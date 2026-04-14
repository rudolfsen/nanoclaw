# Lead Intelligence Phase 2 — Lifecycle & Competition Signals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track price changes over time, flag stale listings, compare ATS/LBS pricing against the market, and identify demand-supply gaps. These four features give Bjornar competitive intelligence beyond the raw lead list from Phase 1.

**Architecture:** Extends the existing lead scanner (`src/lead-scanner.ts`) with an upsert strategy that detects price changes, a new `lead_price_history` table, a `first_seen_at` column for time-on-market calculations, and three new leads skill commands (`stale`, `positioning`, `gaps`).

**Tech Stack:** TypeScript, better-sqlite3, SQLite, bash (container skill)

**Spec:** `docs/superpowers/specs/2026-04-14-lead-intelligence-design.md` (Phase 2 section)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lead-scanner.ts` | Modify | Add `lead_price_history` table, `first_seen_at` column, upsert logic |
| `src/lead-scanner.test.ts` | Modify | Tests for upsert, price history, first_seen_at |
| `container/skills/leads/leads.sh` | Modify | Add `stale`, `positioning`, `gaps` commands |
| `src/direct-agent.ts` | Modify | Add new commands to leads tool enum |

---

### Task 1: DB schema migration — first_seen_at and lead_price_history

Add the `first_seen_at` column to the `leads` table and create the `lead_price_history` table.

**Files:**
- Modify: `src/lead-scanner.ts`

- [ ] **Step 1: Add first_seen_at column and lead_price_history table to initLeadDb**

In `src/lead-scanner.ts`, update `initLeadDb` to add the new column and table. The `first_seen_at` column stores when a lead was first discovered. The `lead_price_history` table stores each price change event.

Replace the `db.exec` block inside `initLeadDb` with:

```typescript
export function initLeadDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      external_id TEXT UNIQUE,
      external_url TEXT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT,
      price REAL,
      contact_name TEXT,
      contact_info TEXT,
      published_at TEXT,
      match_status TEXT DEFAULT 'no_match',
      matched_ads TEXT,
      price_diff_pct REAL,
      status TEXT DEFAULT 'new',
      first_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lead_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      old_price REAL,
      new_price REAL,
      changed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_lead
      ON lead_price_history(lead_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS leads_fts USING fts5(
      title, description,
      content='leads',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS leads_ai AFTER INSERT ON leads BEGIN
      INSERT INTO leads_fts(rowid, title, description)
      VALUES (new.id, new.title, new.description);
    END;

    CREATE TRIGGER IF NOT EXISTS leads_ad AFTER DELETE ON leads BEGIN
      INSERT INTO leads_fts(leads_fts, rowid, title, description)
      VALUES ('delete', old.id, old.title, old.description);
    END;

    CREATE TRIGGER IF NOT EXISTS leads_au AFTER UPDATE ON leads BEGIN
      INSERT INTO leads_fts(leads_fts, rowid, title, description)
      VALUES ('delete', old.id, old.title, old.description);
      INSERT INTO leads_fts(rowid, title, description)
      VALUES (new.id, new.title, new.description);
    END;
  `);

  // Migration: add first_seen_at column to existing databases
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN first_seen_at TEXT`);
    // Backfill: set first_seen_at = created_at for existing rows
    db.exec(`UPDATE leads SET first_seen_at = created_at WHERE first_seen_at IS NULL`);
  } catch {
    // Column already exists — ignore
  }

  // Migration: create lead_price_history if upgrading from Phase 1
  // (handled by CREATE TABLE IF NOT EXISTS above)

  return db;
}
```

- [ ] **Step 2: Build to verify schema compiles**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lead-scanner.ts
git commit -m "feat(leads): add first_seen_at column and lead_price_history table"
```

---

### Task 2: Upsert with price tracking

Replace the `INSERT OR IGNORE` strategy with an upsert that detects price changes and records them in `lead_price_history`.

**Files:**
- Modify: `src/lead-scanner.ts`

- [ ] **Step 1: Replace insertLead with upsertLead**

Replace the existing `insertLead` function in `src/lead-scanner.ts` with:

```typescript
export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

export function upsertLead(
  db: Database.Database,
  signal: RawSignal,
  signalType: 'demand' | 'supply',
  match: MatchResult,
): UpsertResult {
  const now = new Date().toISOString();

  // Check if lead already exists
  const existing = db
    .prepare('SELECT id, price FROM leads WHERE external_id = ?')
    .get(signal.externalId) as { id: number; price: number | null } | undefined;

  if (!existing) {
    // New lead — insert
    db.prepare(
      `INSERT INTO leads
        (source, signal_type, external_id, external_url, title, description,
         category, price, contact_name, contact_info, published_at,
         match_status, matched_ads, price_diff_pct, status, first_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    ).run(
      signal.source,
      signalType,
      signal.externalId,
      signal.externalUrl,
      signal.title,
      signal.description,
      signal.category,
      signal.price,
      signal.contactName,
      signal.contactInfo,
      signal.publishedAt,
      match.matchStatus,
      JSON.stringify(match.matchedAds),
      match.priceDiffPct,
      now,
      now,
    );
    return 'inserted';
  }

  // Existing lead — check if price changed
  const oldPrice = existing.price;
  const newPrice = signal.price;
  const priceChanged =
    oldPrice !== newPrice &&
    !(oldPrice === null && newPrice === null);

  if (priceChanged) {
    // Record price change
    db.prepare(
      `INSERT INTO lead_price_history (lead_id, old_price, new_price, changed_at)
       VALUES (?, ?, ?, ?)`,
    ).run(existing.id, oldPrice, newPrice, now);

    // Update the lead with new price and re-matched data
    db.prepare(
      `UPDATE leads SET
        price = ?, match_status = ?, matched_ads = ?, price_diff_pct = ?,
        title = ?, description = ?, contact_name = ?, contact_info = ?
       WHERE id = ?`,
    ).run(
      newPrice,
      match.matchStatus,
      JSON.stringify(match.matchedAds),
      match.priceDiffPct,
      signal.title,
      signal.description,
      signal.contactName,
      signal.contactInfo,
      existing.id,
    );
    return 'updated';
  }

  return 'unchanged';
}
```

- [ ] **Step 2: Update scanAllSources to use upsertLead**

Replace `insertLead` calls in `scanAllSources` with `upsertLead` and track counts by result type:

```typescript
async function scanAllSources(db: Database.Database): Promise<void> {
  console.log('[lead-scanner] Starting scan...');
  let totalNew = 0;
  let totalUpdated = 0;

  // Finn "ønskes kjøpt" — demand signals
  try {
    const finnSignals = await scrapeFinnWanted();
    let finnNew = 0;
    let finnUpdated = 0;
    for (const signal of finnSignals) {
      const match = matchSignal(signal);
      const result = upsertLead(db, signal, 'demand', match);
      if (result === 'inserted') finnNew++;
      if (result === 'updated') finnUpdated++;
    }
    totalNew += finnNew;
    totalUpdated += finnUpdated;
    console.log(
      `[lead-scanner] Finn: ${finnSignals.length} found, ${finnNew} new, ${finnUpdated} updated`,
    );
  } catch (err) {
    console.error(`[lead-scanner] Finn scan failed: ${(err as Error).message}`);
  }

  // Mascus — supply/price signals
  try {
    const mascusSignals = await scrapeMascus();
    let mascusNew = 0;
    let mascusUpdated = 0;
    for (const signal of mascusSignals) {
      const match = matchSignal(signal);
      const result = upsertLead(db, signal, 'supply', match);
      if (result === 'inserted') mascusNew++;
      if (result === 'updated') mascusUpdated++;
    }
    totalNew += mascusNew;
    totalUpdated += mascusUpdated;
    console.log(
      `[lead-scanner] Mascus: ${mascusSignals.length} found, ${mascusNew} new, ${mascusUpdated} updated`,
    );
  } catch (err) {
    console.error(
      `[lead-scanner] Mascus scan failed: ${(err as Error).message}`,
    );
  }

  // Machineryline — supply/price signals
  try {
    const mlSignals = await scrapeMachineryline();
    let mlNew = 0;
    let mlUpdated = 0;
    for (const signal of mlSignals) {
      const match = matchSignal(signal);
      const result = upsertLead(db, signal, 'supply', match);
      if (result === 'inserted') mlNew++;
      if (result === 'updated') mlUpdated++;
    }
    totalNew += mlNew;
    totalUpdated += mlUpdated;
    console.log(
      `[lead-scanner] Machineryline: ${mlSignals.length} found, ${mlNew} new, ${mlUpdated} updated`,
    );
  } catch (err) {
    console.error(
      `[lead-scanner] Machineryline scan failed: ${(err as Error).message}`,
    );
  }

  console.log(
    `[lead-scanner] Scan complete: ${totalNew} new, ${totalUpdated} updated`,
  );
}
```

- [ ] **Step 3: Remove old insertLead export and add upsertLead to exports**

Update the imports in the test file (Task 3). The old `insertLead` function is deleted — `upsertLead` replaces it.

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/lead-scanner.ts
git commit -m "feat(leads): replace INSERT OR IGNORE with upsert + price history tracking"
```

---

### Task 3: Tests for upsert and price history

Add tests covering the new upsert behavior and price history recording.

**Files:**
- Modify: `src/lead-scanner.test.ts`

- [ ] **Step 1: Update test imports and existing tests**

Replace the full contents of `src/lead-scanner.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initLeadDb, upsertLead } from './lead-scanner.js';
import { RawSignal, MatchResult } from './lead-sources/types.js';

function makeSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    source: 'finn_wanted',
    externalUrl: 'https://finn.no/item/123',
    title: 'Ønsker å kjøpe gravemaskin Volvo',
    description: 'Ser etter brukt Volvo gravemaskin',
    category: 'Anlegg',
    price: null,
    contactName: 'Ola Nordmann',
    contactInfo: '99887766',
    publishedAt: '2026-04-14',
    externalId: 'finn-123',
    ...overrides,
  };
}

function makeMatch(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    matchStatus: 'has_match',
    matchedAds: [
      { source: 'ats', id: 22819, title: 'Volvo EC220', price: 450000 },
    ],
    priceDiffPct: null,
    ...overrides,
  };
}

describe('initLeadDb', () => {
  it('creates leads table with first_seen_at and price history table', () => {
    const db = initLeadDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('leads');
    expect(tables).toContain('leads_fts');
    expect(tables).toContain('lead_price_history');

    // Verify first_seen_at column exists
    const cols = db.prepare('PRAGMA table_info(leads)').all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('first_seen_at');
    db.close();
  });
});

describe('upsertLead', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initLeadDb(':memory:');
  });

  it('inserts a new demand lead', () => {
    const result = upsertLead(db, makeSignal(), 'demand', makeMatch());
    expect(result).toBe('inserted');
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('finn-123') as any;
    expect(row.title).toBe('Ønsker å kjøpe gravemaskin Volvo');
    expect(row.signal_type).toBe('demand');
    expect(row.match_status).toBe('has_match');
    expect(row.first_seen_at).toBeTruthy();
  });

  it('returns unchanged for duplicate with same price', () => {
    upsertLead(db, makeSignal(), 'demand', makeMatch());
    const result = upsertLead(db, makeSignal(), 'demand', makeMatch());
    expect(result).toBe('unchanged');
    const count = db.prepare('SELECT count(*) as c FROM leads').get() as any;
    expect(count.c).toBe(1);
  });

  it('FTS search finds lead by title', () => {
    upsertLead(db, makeSignal(), 'demand', makeMatch());
    const results = db
      .prepare(
        "SELECT l.* FROM leads_fts f JOIN leads l ON l.id = f.rowid WHERE leads_fts MATCH 'gravemaskin'",
      )
      .all();
    expect(results).toHaveLength(1);
  });

  it('inserts supply lead with price', () => {
    const signal = makeSignal({
      source: 'mascus',
      externalId: 'mascus-456',
      title: 'Volvo EC220 2018',
      price: 350000,
    });
    const match = makeMatch({
      matchStatus: 'price_opportunity',
      priceDiffPct: 22,
    });
    upsertLead(db, signal, 'supply', match);
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('mascus-456') as any;
    expect(row.price).toBe(350000);
    expect(row.price_diff_pct).toBe(22);
  });

  it('detects price change and records history', () => {
    const signal = makeSignal({
      source: 'mascus',
      externalId: 'mascus-789',
      title: 'Komatsu PC210',
      price: 500000,
    });
    upsertLead(db, signal, 'supply', makeMatch({ priceDiffPct: 10 }));

    // Rescan with lower price
    const updatedSignal = makeSignal({
      source: 'mascus',
      externalId: 'mascus-789',
      title: 'Komatsu PC210',
      price: 420000,
    });
    const result = upsertLead(
      db,
      updatedSignal,
      'supply',
      makeMatch({ priceDiffPct: 25 }),
    );
    expect(result).toBe('updated');

    // Lead should have new price
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('mascus-789') as any;
    expect(row.price).toBe(420000);
    expect(row.price_diff_pct).toBe(25);

    // Price history should have one record
    const history = db
      .prepare('SELECT * FROM lead_price_history WHERE lead_id = ?')
      .all(row.id) as any[];
    expect(history).toHaveLength(1);
    expect(history[0].old_price).toBe(500000);
    expect(history[0].new_price).toBe(420000);
    expect(history[0].changed_at).toBeTruthy();
  });

  it('preserves first_seen_at on price update', () => {
    const signal = makeSignal({
      source: 'mascus',
      externalId: 'mascus-preserve',
      price: 300000,
    });
    upsertLead(db, signal, 'supply', makeMatch());

    const before = db
      .prepare('SELECT first_seen_at FROM leads WHERE external_id = ?')
      .get('mascus-preserve') as any;

    // Update with new price
    const updated = makeSignal({
      source: 'mascus',
      externalId: 'mascus-preserve',
      price: 250000,
    });
    upsertLead(db, updated, 'supply', makeMatch());

    const after = db
      .prepare('SELECT first_seen_at FROM leads WHERE external_id = ?')
      .get('mascus-preserve') as any;

    expect(after.first_seen_at).toBe(before.first_seen_at);
  });

  it('records multiple price changes in history', () => {
    const base = {
      source: 'mascus' as const,
      externalId: 'mascus-multi',
      title: 'CAT 320',
    };

    upsertLead(
      db,
      makeSignal({ ...base, price: 600000 }),
      'supply',
      makeMatch(),
    );
    upsertLead(
      db,
      makeSignal({ ...base, price: 550000 }),
      'supply',
      makeMatch(),
    );
    upsertLead(
      db,
      makeSignal({ ...base, price: 480000 }),
      'supply',
      makeMatch(),
    );

    const row = db
      .prepare('SELECT id FROM leads WHERE external_id = ?')
      .get('mascus-multi') as any;
    const history = db
      .prepare(
        'SELECT * FROM lead_price_history WHERE lead_id = ? ORDER BY changed_at',
      )
      .all(row.id) as any[];
    expect(history).toHaveLength(2);
    expect(history[0].old_price).toBe(600000);
    expect(history[0].new_price).toBe(550000);
    expect(history[1].old_price).toBe(550000);
    expect(history[1].new_price).toBe(480000);
  });

  it('does not record history when price is unchanged', () => {
    const signal = makeSignal({
      source: 'mascus',
      externalId: 'mascus-same',
      price: 400000,
    });
    upsertLead(db, signal, 'supply', makeMatch());
    upsertLead(db, signal, 'supply', makeMatch());

    const row = db
      .prepare('SELECT id FROM leads WHERE external_id = ?')
      .get('mascus-same') as any;
    const history = db
      .prepare('SELECT * FROM lead_price_history WHERE lead_id = ?')
      .all(row.id) as any[];
    expect(history).toHaveLength(0);
  });

  it('handles price change from null to a value', () => {
    const signal = makeSignal({
      source: 'finn_wanted',
      externalId: 'finn-null-price',
      price: null,
    });
    upsertLead(db, signal, 'demand', makeMatch());

    const updated = makeSignal({
      source: 'finn_wanted',
      externalId: 'finn-null-price',
      price: 200000,
    });
    const result = upsertLead(db, updated, 'demand', makeMatch());
    expect(result).toBe('updated');

    const row = db
      .prepare('SELECT id FROM leads WHERE external_id = ?')
      .get('finn-null-price') as any;
    const history = db
      .prepare('SELECT * FROM lead_price_history WHERE lead_id = ?')
      .all(row.id) as any[];
    expect(history).toHaveLength(1);
    expect(history[0].old_price).toBeNull();
    expect(history[0].new_price).toBe(200000);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run build && npx vitest run src/lead-scanner.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/lead-scanner.test.ts
git commit -m "test(leads): add tests for upsert, price history, and first_seen_at"
```

---

### Task 4: Stale leads command (time-on-market)

Add a `stale` command to the leads skill that shows leads with >60 days on market (motivated sellers).

**Files:**
- Modify: `container/skills/leads/leads.sh`

- [ ] **Step 1: Add the stale command**

Add the `stale` case before the `help|*` case in `leads.sh`:

```bash
  stale)
    DAYS="${2:-60}"
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,60) as title, price,
             first_seen_at,
             CAST(julianday('now') - julianday(first_seen_at) AS INTEGER) as days_on_market,
             external_url, status
      FROM leads
      WHERE signal_type = 'supply'
        AND first_seen_at IS NOT NULL
        AND CAST(julianday('now') - julianday(first_seen_at) AS INTEGER) > $DAYS
      ORDER BY days_on_market DESC
      LIMIT ${3:-30}
    " | jq '.[]'
    ;;
```

- [ ] **Step 2: Add price-drops command to show leads with price history**

Add a `price-drops` case to show leads that have had price reductions (useful companion to stale):

```bash
  price-drops)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT l.id, l.source, substr(l.title,1,60) as title,
             h.old_price, h.new_price,
             CAST((h.old_price - h.new_price) * 100.0 / h.old_price AS INTEGER) as drop_pct,
             h.changed_at, l.external_url
      FROM lead_price_history h
      JOIN leads l ON l.id = h.lead_id
      WHERE h.new_price < h.old_price
      ORDER BY h.changed_at DESC
      LIMIT ${2:-30}
    " | jq '.[]'
    ;;
```

- [ ] **Step 3: Update help text**

Update the help text to include the new commands:

```bash
  help|*)
    cat <<EOF
Leads Tool — Query lead intelligence database

Usage:
  leads list [count]        List newest leads (default: 20)
  leads demand [count]      Show buy signals (people looking for equipment)
  leads opportunities       Show price opportunities (cheaper elsewhere)
  leads search <query>      Search leads by keyword
  leads stats               Show summary statistics
  leads stale [days]        Show listings on market >N days (default: 60) — motivated sellers
  leads price-drops [count] Show recent price reductions
  leads positioning         Compare ATS/LBS avg price vs market avg per equipment type
  leads gaps                Show demand-supply gaps (high demand, low supply)
EOF
    ;;
```

- [ ] **Step 4: Commit**

```bash
git add container/skills/leads/leads.sh
git commit -m "feat(leads): add stale and price-drops commands for lifecycle signals"
```

---

### Task 5: Price positioning command

Add a `positioning` command that compares average market price (Mascus/Machineryline) vs ATS/LBS average for the same equipment type.

**Files:**
- Modify: `container/skills/leads/leads.sh`

- [ ] **Step 1: Add the positioning command**

This command joins leads (supply signals from Mascus/Machineryline) against ATS/LBS cache databases to compare pricing by category. Add before the `help|*` case:

```bash
  positioning)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    ATS_DB="${ATS_CACHE_DIR:-data}/ats-feed-cache.sqlite"
    LBS_DB="${ATS_CACHE_DIR:-data}/lbs-feed-cache.sqlite"

    echo "=== Price Positioning: Market vs ATS/LBS ==="
    echo ""
    echo "Market averages (Mascus + Machineryline supply leads):"
    sqlite3 "$LEAD_DB" "
      SELECT category,
             count(*) as count,
             CAST(avg(price) AS INTEGER) as avg_price,
             CAST(min(price) AS INTEGER) as min_price,
             CAST(max(price) AS INTEGER) as max_price
      FROM leads
      WHERE signal_type = 'supply'
        AND price IS NOT NULL
        AND price > 0
        AND source IN ('mascus', 'machineryline')
      GROUP BY category
      ORDER BY count DESC
    " -header -column

    echo ""
    if [ -f "$ATS_DB" ]; then
      echo "ATS averages (published listings):"
      sqlite3 "$ATS_DB" "
        SELECT substr(category,1,30) as category,
               count(*) as count,
               CAST(avg(price) AS INTEGER) as avg_price,
               CAST(min(price) AS INTEGER) as min_price,
               CAST(max(price) AS INTEGER) as max_price
        FROM ads
        WHERE status = 'published' AND price IS NOT NULL AND price > 0
        GROUP BY category
        ORDER BY count DESC
      " -header -column
    else
      echo "ATS cache not available ($ATS_DB)"
    fi

    echo ""
    if [ -f "$LBS_DB" ]; then
      echo "LBS averages (published listings):"
      sqlite3 "$LBS_DB" "
        SELECT substr(category,1,30) as category,
               count(*) as count,
               CAST(avg(price) AS INTEGER) as avg_price,
               CAST(min(price) AS INTEGER) as min_price,
               CAST(max(price) AS INTEGER) as max_price
        FROM ads
        WHERE status = 'published' AND price IS NOT NULL AND price > 0
        GROUP BY category
        ORDER BY count DESC
      " -header -column
    else
      echo "LBS cache not available ($LBS_DB)"
    fi

    echo ""
    echo "--- Per-type comparison (leads with ATS/LBS matches) ---"
    sqlite3 "$LEAD_DB" "
      SELECT category,
             count(*) as market_count,
             CAST(avg(price) AS INTEGER) as market_avg,
             CAST(avg(
               CASE WHEN matched_ads IS NOT NULL AND matched_ads != '[]'
               THEN json_extract(matched_ads, '$[0].price')
               END
             ) AS INTEGER) as ats_lbs_avg,
             CAST(avg(price_diff_pct) AS INTEGER) as avg_diff_pct
      FROM leads
      WHERE signal_type = 'supply'
        AND price IS NOT NULL
        AND price > 0
        AND matched_ads IS NOT NULL
        AND matched_ads != '[]'
      GROUP BY category
      HAVING count(*) >= 2
      ORDER BY avg_diff_pct DESC
    " -header -column
    ;;
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/leads/leads.sh
git commit -m "feat(leads): add positioning command — market vs ATS/LBS price comparison"
```

---

### Task 6: Market demand gap command

Add a `gaps` command that counts demand signals (Finn "ønskes kjøpt") per keyword and compares with supply count in ATS/LBS.

**Files:**
- Modify: `container/skills/leads/leads.sh`

- [ ] **Step 1: Add the gaps command**

This command counts demand leads per category and compares them against supply leads and ATS/LBS cache listings. Equipment types that have high demand but low supply represent market gaps. Add before the `help|*` case:

```bash
  gaps)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    ATS_DB="${ATS_CACHE_DIR:-data}/ats-feed-cache.sqlite"
    LBS_DB="${ATS_CACHE_DIR:-data}/lbs-feed-cache.sqlite"

    echo "=== Market Demand-Supply Gaps ==="
    echo ""
    echo "Demand signals by category (Finn 'ønskes kjøpt'):"
    sqlite3 "$LEAD_DB" "
      SELECT category,
             count(*) as demand_count,
             count(CASE WHEN match_status = 'has_match' THEN 1 END) as has_match,
             count(CASE WHEN match_status = 'no_match' THEN 1 END) as no_match
      FROM leads
      WHERE signal_type = 'demand'
      GROUP BY category
      ORDER BY demand_count DESC
    " -header -column

    echo ""
    echo "Supply signals by category (Mascus + Machineryline):"
    sqlite3 "$LEAD_DB" "
      SELECT category,
             count(*) as supply_count,
             CAST(avg(price) AS INTEGER) as avg_price
      FROM leads
      WHERE signal_type = 'supply'
        AND source IN ('mascus', 'machineryline')
      GROUP BY category
      ORDER BY supply_count DESC
    " -header -column

    echo ""
    echo "--- Gap analysis: high demand, low/no supply ---"
    sqlite3 "$LEAD_DB" "
      SELECT
        d.category,
        d.demand_count,
        COALESCE(s.supply_count, 0) as supply_count,
        d.demand_count - COALESCE(s.supply_count, 0) as gap,
        d.no_match as unmatched_demand
      FROM (
        SELECT category,
               count(*) as demand_count,
               count(CASE WHEN match_status = 'no_match' THEN 1 END) as no_match
        FROM leads WHERE signal_type = 'demand'
        GROUP BY category
      ) d
      LEFT JOIN (
        SELECT category, count(*) as supply_count
        FROM leads WHERE signal_type = 'supply'
        GROUP BY category
      ) s ON d.category = s.category
      ORDER BY gap DESC, d.demand_count DESC
    " -header -column

    # Show ATS/LBS inventory counts for context
    echo ""
    ATS_COUNT=0
    LBS_COUNT=0
    if [ -f "$ATS_DB" ]; then
      ATS_COUNT=$(sqlite3 "$ATS_DB" "SELECT count(*) FROM ads WHERE status = 'published'")
    fi
    if [ -f "$LBS_DB" ]; then
      LBS_COUNT=$(sqlite3 "$LBS_DB" "SELECT count(*) FROM ads WHERE status = 'published'")
    fi
    echo "ATS inventory: $ATS_COUNT published | LBS inventory: $LBS_COUNT published"
    ;;
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/leads/leads.sh
git commit -m "feat(leads): add gaps command — demand vs supply gap analysis"
```

---

### Task 7: Update direct-agent tool enum

Add the new commands to the leads tool enum and description in `src/direct-agent.ts`.

**Files:**
- Modify: `src/direct-agent.ts`

- [ ] **Step 1: Update the leads tool definition**

In `src/direct-agent.ts`, update the leads tool's description and enum to include the new commands:

```typescript
          {
            name: 'leads',
            description:
              'Query the lead intelligence database. Commands: list [count], demand [count], opportunities, search <query>, stats, stale [days], price-drops [count], positioning, gaps.',
            input_schema: {
              type: 'object' as const,
              properties: {
                command: {
                  type: 'string',
                  description:
                    'Command: list, demand, opportunities, search, stats, stale, price-drops, positioning, or gaps',
                  enum: [
                    'list',
                    'demand',
                    'opportunities',
                    'search',
                    'stats',
                    'stale',
                    'price-drops',
                    'positioning',
                    'gaps',
                  ],
                },
                argument: {
                  type: 'string',
                  description:
                    'Count for list/demand/stale/price-drops, days threshold for stale, or search query for search',
                },
              },
              required: ['command'],
            },
          } satisfies Anthropic.Tool,
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/direct-agent.ts
git commit -m "feat(leads): add stale, price-drops, positioning, gaps to agent tool enum"
```

---

### Task 8: Update stats command with Phase 2 data

Enhance the `stats` command in leads.sh to include Phase 2 metrics.

**Files:**
- Modify: `container/skills/leads/leads.sh`

- [ ] **Step 1: Update stats command**

Replace the `stats` case with:

```bash
  stats)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    echo "=== Lead Statistics ==="
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' total leads' FROM leads"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' new' FROM leads WHERE status = 'new'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' demand (buy signals)' FROM leads WHERE signal_type = 'demand'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' supply (price opportunities)' FROM leads WHERE match_status = 'price_opportunity'"
    echo "--- By source ---"
    sqlite3 "$LEAD_DB" "SELECT source || ': ' || count(*) FROM leads GROUP BY source"
    echo "--- Phase 2 metrics ---"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' price changes recorded' FROM lead_price_history"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' price drops' FROM lead_price_history WHERE new_price < old_price"
    sqlite3 "$LEAD_DB" "
      SELECT count(*) || ' stale listings (>60 days)'
      FROM leads
      WHERE signal_type = 'supply'
        AND first_seen_at IS NOT NULL
        AND CAST(julianday('now') - julianday(first_seen_at) AS INTEGER) > 60
    "
    ;;
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/leads/leads.sh
git commit -m "feat(leads): enhance stats command with Phase 2 metrics"
```

---

### Task 9: Final verification

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 2: Run all tests**

Run: `npx vitest run src/lead-scanner.test.ts`
Expected: All tests pass (including new upsert and price history tests)

- [ ] **Step 3: Verify leads.sh is valid bash**

Run: `bash -n container/skills/leads/leads.sh`
Expected: No syntax errors

- [ ] **Step 4: Verify all commands are listed in help**

Run: `bash container/skills/leads/leads.sh help`
Expected: Shows all 9 commands (list, demand, opportunities, search, stats, stale, price-drops, positioning, gaps)
