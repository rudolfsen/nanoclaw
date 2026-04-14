# Landbrukssalg Feed Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Landbrukssalg.no feed alongside ATS — fetch, cache in SQLite with FTS5 search, and expose via container skill.

**Architecture:** Same pattern as `src/ats-feed-sync.ts`. Landbrukssalg returns all ~1600 ads in a single JSON array (no pagination). Sync fetches the full dump, upserts into a separate SQLite DB, and maintains FTS5 index. Container skill exposes list/get/search commands.

**Tech Stack:** Node.js fetch, better-sqlite3, vitest, bash (container skill)

**Feed URL:** `https://data.landbrukssalg.no/export/json/storefront/en_US?key=89hgiosdbghKn48gh893nh`
**Norwegian variant:** `https://data.landbrukssalg.no/export/json/storefront/nb_NO?key=89hgiosdbghKn48gh893nh`

---

### Task 1: Sync module — src/lbs-feed-sync.ts

**Files:**
- Create: `src/lbs-feed-sync.ts`
- Test: `src/lbs-feed-sync.test.ts`

- [ ] **Step 1: Create src/lbs-feed-sync.ts**

Model after `src/ats-feed-sync.ts` but adapted for Landbrukssalg's single-dump format.

```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types (matching Landbrukssalg JSON structure)
// ---------------------------------------------------------------------------

export interface LbsAd {
  id: string;
  title: string;
  description_plain: string;
  maincategory: string;
  category: string;
  make: string;
  model: string;
  year: string;
  price: string;
  price_eur: string;
  status: string;
  county: string;
  zipcode: number;
  published: string;
  changed: string;
  hours: string | null;
  km: string | null;
  images: Array<{ url: string; url_thumbnail: string }>;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

export function resolveDbPath(): string {
  const dir = process.env.LBS_CACHE_DIR || path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'lbs-feed-cache.sqlite');
}

export function initCacheDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      maincategory TEXT,
      category TEXT,
      make TEXT,
      model TEXT,
      year TEXT,
      price REAL,
      price_eur REAL,
      status TEXT NOT NULL,
      county TEXT,
      zipcode TEXT,
      hours TEXT,
      km TEXT,
      image_url TEXT,
      published_at TEXT,
      changed_at TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ads_fts USING fts5(
      title,
      description,
      make,
      model,
      category,
      content='ads',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS ads_ai AFTER INSERT ON ads BEGIN
      INSERT INTO ads_fts(rowid, title, description, make, model, category)
      VALUES (new.rowid, new.title, new.description, new.make, new.model, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS ads_ad AFTER DELETE ON ads BEGIN
      INSERT INTO ads_fts(ads_fts, rowid, title, description, make, model, category)
      VALUES ('delete', old.rowid, old.title, old.description, old.make, old.model, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS ads_au AFTER UPDATE ON ads BEGIN
      INSERT INTO ads_fts(ads_fts, rowid, title, description, make, model, category)
      VALUES ('delete', old.rowid, old.title, old.description, old.make, old.model, old.category);
      INSERT INTO ads_fts(rowid, title, description, make, model, category)
      VALUES (new.rowid, new.title, new.description, new.make, new.model, new.category);
    END;
  `);

  return db;
}

export function upsertAd(
  db: Database.Database,
  ad: LbsAd,
  syncedAt: string,
): void {
  if (ad.status !== 'published') return;

  const imageUrl = ad.images?.[0]?.url || null;

  db.prepare(
    `INSERT INTO ads (id, title, description, maincategory, category, make, model, year, price, price_eur, status, county, zipcode, hours, km, image_url, published_at, changed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       maincategory = excluded.maincategory,
       category = excluded.category,
       make = excluded.make,
       model = excluded.model,
       year = excluded.year,
       price = excluded.price,
       price_eur = excluded.price_eur,
       status = excluded.status,
       county = excluded.county,
       zipcode = excluded.zipcode,
       hours = excluded.hours,
       km = excluded.km,
       image_url = excluded.image_url,
       published_at = excluded.published_at,
       changed_at = excluded.changed_at,
       synced_at = excluded.synced_at`,
  ).run(
    ad.id,
    ad.title,
    ad.description_plain || null,
    ad.maincategory || null,
    ad.category || null,
    ad.make || null,
    ad.model || null,
    ad.year || null,
    ad.price ? parseFloat(ad.price) : null,
    ad.price_eur ? parseFloat(ad.price_eur) : null,
    ad.status,
    ad.county || null,
    ad.zipcode ? String(ad.zipcode) : null,
    ad.hours || null,
    ad.km || null,
    imageUrl,
    ad.published || null,
    ad.changed || null,
    syncedAt,
  );
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const FEED_URL =
  'https://data.landbrukssalg.no/export/json/storefront/nb_NO?key=89hgiosdbghKn48gh893nh';

async function fetchFeed(): Promise<LbsAd[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000); // 60s — large payload

  try {
    const res = await fetch(FEED_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`LBS feed error: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as LbsAd[];
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error('LBS feed timeout');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function fullSync(db: Database.Database): Promise<void> {
  const syncedAt = new Date().toISOString();

  console.log('[lbs-feed-sync] Fetching full feed...');
  const ads = await fetchFeed();
  console.log(`[lbs-feed-sync] Received ${ads.length} ads`);

  const upsertMany = db.transaction((items: LbsAd[]) => {
    for (const ad of items) {
      upsertAd(db, ad, syncedAt);
    }
  });
  upsertMany(ads);

  const published = ads.filter((a) => a.status === 'published').length;

  // Remove stale ads
  const deleteResult = db
    .prepare('DELETE FROM ads WHERE synced_at < ?')
    .run(syncedAt);

  console.log(
    `[lbs-feed-sync] Sync complete: ${published} published, ${deleteResult.changes} stale removed`,
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runSyncLoop(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = initCacheDb(dbPath);
  console.log(`[lbs-feed-sync] Cache DB at ${dbPath}`);

  // Full sync on startup
  try {
    await fullSync(db);
  } catch (err) {
    console.error('[lbs-feed-sync] Sync failed on startup:', err);
  }

  // Re-sync every 30 minutes (feed is a full dump, no incremental needed)
  const SYNC_INTERVAL = 30 * 60 * 1000;

  setInterval(async () => {
    try {
      await fullSync(db);
    } catch (err) {
      console.error('[lbs-feed-sync] Sync error:', err);
    }
  }, SYNC_INTERVAL);
}

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  runSyncLoop().catch((err) => {
    console.error('[lbs-feed-sync] Fatal error:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Create test file src/lbs-feed-sync.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initCacheDb, upsertAd, LbsAd } from './lbs-feed-sync.js';

function makeLbsAd(overrides: Partial<LbsAd> = {}): LbsAd {
  return {
    id: '1234',
    title: '2020 John Deere 6130R',
    description_plain: 'Traktor i god stand',
    maincategory: 'Traktor',
    category: 'Traktor',
    make: 'John Deere',
    model: '6130R',
    year: '2020',
    price: '850000',
    price_eur: '77000',
    status: 'published',
    county: 'Trøndelag',
    zipcode: 7080,
    published: '2026-01-15 10:00:00',
    changed: '2026-04-01 12:00:00',
    hours: '3200',
    km: null,
    images: [{ url: 'https://example.com/img.jpg', url_thumbnail: 'https://example.com/thumb.jpg' }],
    ...overrides,
  };
}

describe('lbs-feed-sync', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initCacheDb(':memory:');
  });

  it('upserts a published ad', () => {
    const ad = makeLbsAd();
    upsertAd(db, ad, '2026-04-14T10:00:00Z');

    const row = db.prepare('SELECT * FROM ads WHERE id = ?').get('1234') as any;
    expect(row).toBeDefined();
    expect(row.title).toBe('2020 John Deere 6130R');
    expect(row.price).toBe(850000);
    expect(row.make).toBe('John Deere');
    expect(row.county).toBe('Trøndelag');
  });

  it('skips non-published ads', () => {
    const ad = makeLbsAd({ status: 'closed' });
    upsertAd(db, ad, '2026-04-14T10:00:00Z');

    const row = db.prepare('SELECT * FROM ads WHERE id = ?').get('1234');
    expect(row).toBeUndefined();
  });

  it('updates existing ad on re-upsert', () => {
    const ad = makeLbsAd({ price: '800000' });
    upsertAd(db, ad, '2026-04-14T10:00:00Z');

    const updated = makeLbsAd({ price: '750000' });
    upsertAd(db, updated, '2026-04-14T11:00:00Z');

    const row = db.prepare('SELECT price FROM ads WHERE id = ?').get('1234') as any;
    expect(row.price).toBe(750000);
  });

  it('FTS search finds ad by title', () => {
    upsertAd(db, makeLbsAd(), '2026-04-14T10:00:00Z');
    upsertAd(db, makeLbsAd({ id: '5678', title: 'Kverneland plog', make: 'Kverneland', model: 'ES85' }), '2026-04-14T10:00:00Z');

    const results = db.prepare(
      `SELECT a.id, a.title FROM ads_fts f JOIN ads a ON a.rowid = f.rowid WHERE ads_fts MATCH '"John Deere"'`
    ).all() as any[];

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1234');
  });

  it('stores first image URL', () => {
    upsertAd(db, makeLbsAd(), '2026-04-14T10:00:00Z');
    const row = db.prepare('SELECT image_url FROM ads WHERE id = ?').get('1234') as any;
    expect(row.image_url).toBe('https://example.com/img.jpg');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lbs-feed-sync.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/lbs-feed-sync.ts src/lbs-feed-sync.test.ts
git commit -m "feat: add Landbrukssalg feed sync module with SQLite cache and FTS5"
```

---

### Task 2: Container skill — lbs-feed.sh + SKILL.md

**Files:**
- Create: `container/skills/lbs-feed/lbs-feed.sh`
- Create: `container/skills/lbs-feed/SKILL.md`

- [ ] **Step 1: Create container/skills/lbs-feed/lbs-feed.sh**

```bash
#!/usr/bin/env bash
# Tool for querying the Landbrukssalg.no product feed.
# Uses a local SQLite cache (built by lbs-feed-sync).

set -euo pipefail

FEED_URL="https://data.landbrukssalg.no/export/json/storefront/nb_NO?key=89hgiosdbghKn48gh893nh"
CACHE_DB="${LBS_CACHE_DB:-data/lbs-feed-cache.sqlite}"

case "${1:-help}" in
  list)
    COUNT="${2:-20}"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Falling back to API (first 20)..." >&2
      curl -s "$FEED_URL" | jq "[.[] | select(.status == \"published\")] | sort_by(.published) | reverse | .[0:$COUNT] | .[] | {id, title, price, price_eur, year, make, model, category, county}"
      exit 0
    fi
    sqlite3 -json "$CACHE_DB" "
      SELECT id, substr(title, 1, 80) as title, price, price_eur, year, make, model, category, county
      FROM ads WHERE status = 'published'
      ORDER BY published_at DESC
      LIMIT $COUNT
    " | jq '.[]'
    ;;

  get)
    if [ -z "${2:-}" ]; then
      echo "Usage: lbs-feed get <id>" >&2
      exit 1
    fi
    AD_ID="$2"
    if [ -f "$CACHE_DB" ]; then
      sqlite3 -json "$CACHE_DB" "
        SELECT id, title, description, maincategory, category, make, model, year,
               price, price_eur, county, zipcode, hours, km, image_url,
               published_at, changed_at
        FROM ads WHERE id = '$AD_ID'
      " | jq '.[0]'
    else
      curl -s "$FEED_URL" | jq ".[] | select(.id == \"$AD_ID\") | {id, title, description_plain, maincategory, category, make, model, year, price, price_eur, county, zipcode, hours, km, images: [.images[0].url]}"
    fi
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: lbs-feed search <query>" >&2
      exit 1
    fi
    QUERY="$2"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Try again in a moment." >&2
      exit 1
    fi
    ESCAPED="${QUERY//\"/\"\"}"
    RESULTS=$(sqlite3 -json "$CACHE_DB" "
      SELECT a.id, substr(a.title, 1, 80) as title, a.price, a.price_eur, a.year, a.make, a.model, a.category, a.county
      FROM ads_fts f
      JOIN ads a ON a.rowid = f.rowid
      WHERE ads_fts MATCH '\"${ESCAPED}\"'
        AND a.status = 'published'
      ORDER BY f.rank
      LIMIT 20
    " 2>/dev/null || echo "[]")
    COUNT=$(echo "$RESULTS" | jq 'length')
    if [ "$COUNT" -gt 0 ]; then
      echo "$RESULTS" | jq '.[]'
    else
      echo "No results found for: $QUERY"
    fi
    ;;

  categories)
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready." >&2
      exit 1
    fi
    sqlite3 -json "$CACHE_DB" "
      SELECT category, COUNT(*) as count
      FROM ads WHERE status = 'published'
      GROUP BY category ORDER BY count DESC
    " | jq '.[]'
    ;;

  help|*)
    cat <<EOF
LBS Feed Tool — Query Landbrukssalg.no product database

Usage:
  lbs-feed list [count]      List published ads (default: 20)
  lbs-feed get <id>          Get full ad details by ID
  lbs-feed search <query>    Search ads by keyword (FTS5)
  lbs-feed categories        List categories with counts

Examples:
  lbs-feed list 10
  lbs-feed get 2450
  lbs-feed search "john deere"
  lbs-feed search "plog"
  lbs-feed categories
EOF
    ;;
esac
```

- [ ] **Step 2: Make executable**

```bash
chmod +x container/skills/lbs-feed/lbs-feed.sh
```

- [ ] **Step 3: Create container/skills/lbs-feed/SKILL.md**

```markdown
# Landbrukssalg Feed Tool

Query the Landbrukssalg.no database for used agricultural equipment.

## Commands

### List published ads
```bash
lbs-feed list        # Latest 20 published ads
lbs-feed list 10     # Latest 10
```

### Get full details
```bash
lbs-feed get 2450    # Full details for ad #2450
```

### Search by keyword
```bash
lbs-feed search "john deere"    # Find John Deere equipment
lbs-feed search "plog"          # Find plows
lbs-feed search "traktor"       # Find tractors
lbs-feed search "rundballepresse"  # Find round balers
```

### List categories
```bash
lbs-feed categories   # Show all categories with counts
```

## Response Fields

- `id` — Ad ID (use with `get` for full details)
- `title` — Equipment title with year and model
- `price` — Price in NOK
- `price_eur` — Price in EUR
- `year` — Manufacturing year
- `make` / `model` — Manufacturer and model name
- `category` — Equipment category (e.g. "Traktor", "Grass production")
- `county` — Norwegian county where equipment is located
- `hours` / `km` — Usage hours or kilometers
- `image_url` — Main image URL

## Usage in Email Responses

When responding to a customer inquiry about agricultural equipment:
1. Use `lbs-feed search` to find matching products
2. Use `lbs-feed get <id>` for full details on the best matches
3. Include relevant details (price, specs, year, location) in the draft
4. Link to the ad: `https://landbrukssalg.no/kjope/?id=<id>`
```

- [ ] **Step 4: Commit**

```bash
git add container/skills/lbs-feed/
git commit -m "feat: add Landbrukssalg container skill (list, get, search, categories)"
```

---

### Task 3: Wire sync into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add LBS sync startup alongside ATS**

Find the section in `src/index.ts` where ATS feed sync is started (around line 613-625). Add LBS sync right after:

```typescript
// Start LBS feed cache sync in direct mode
if (AGENT_MODE === 'direct') {
  const lbsSyncScript = path.join(process.cwd(), 'dist', 'lbs-feed-sync.js');
  if (fs.existsSync(lbsSyncScript)) {
    const { spawn } = await import('child_process');
    const lbsSync = spawn('node', [lbsSyncScript], {
      stdio: 'inherit',
      env: { ...process.env, LBS_CACHE_DIR: path.join(process.cwd(), 'data') },
    });
    lbsSync.on('error', (err) => logger.error({ err }, 'LBS feed sync failed to start'));
  }
}
```

- [ ] **Step 2: Mount LBS cache DB into containers**

In `src/container-runner.ts`, find where the ATS cache DB is mounted (look for `ats-feed-cache.sqlite`). Add a similar mount for LBS:

```typescript
// Mount LBS feed cache if it exists
const lbsCachePath = path.join(process.cwd(), 'data', 'lbs-feed-cache.sqlite');
if (fs.existsSync(lbsCachePath)) {
  args.push('-v', `${lbsCachePath}:/workspace/group/data/lbs-feed-cache.sqlite:ro`);
}
```

Also ensure the container skill script is available. It should already be accessible via the project mount (`/workspace/project/container/skills/lbs-feed/lbs-feed.sh`).

- [ ] **Step 3: Add lbs-feed to PATH in container**

Check if container agents already have `container/skills/*/` in PATH or if scripts need to be explicitly linked. If ATS uses a symlink or PATH addition, do the same for LBS.

The `container/skills/ats-feed/ats-feed.sh` pattern: the script is at a known path and the agent calls it directly via `bash /workspace/project/container/skills/ats-feed/ats-feed.sh`. LBS follows the same convention — no PATH change needed, just document the full path in SKILL.md or add an alias in the container CLAUDE.md.

- [ ] **Step 4: Run build and tests**

Run: `npm run build && npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/container-runner.ts
git commit -m "feat: wire Landbrukssalg feed sync into startup and container mounts"
```

---

### Task 4: Build, test, deploy

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean

- [ ] **Step 3: Deploy**

```bash
git push origin main
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && systemctl restart nanoclaw'
```

- [ ] **Step 4: Verify sync starts**

```bash
ssh root@204.168.178.32 'sleep 10 && journalctl -u nanoclaw --no-pager -n 20 | grep lbs-feed'
```

Expected: `[lbs-feed-sync] Sync complete: ~1600 published, 0 stale removed`

- [ ] **Step 5: Test container skill**

Send a message to the agent via Telegram asking about a tractor, and verify it can use `lbs-feed search "traktor"` to find results.
