# Lead Intelligence Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan Finn.no "ønskes kjøpt", Mascus.no, and Machineryline.com for buy signals and price opportunities, match against ATS/LBS inventory, and store as queryable leads.

**Architecture:** A lead scanner script (`src/lead-scanner.ts`) runs as a background process. Per-source parsers scrape HTML listings. Leads are stored in a SQLite database with FTS5. A `leads` container skill exposes the data to the agent. NanoClaw spawns the scanner in direct mode.

**Tech Stack:** TypeScript, better-sqlite3, SQLite FTS5, Node.js fetch (HTML scraping with regex), bash (container skill)

**Spec:** `docs/superpowers/specs/2026-04-14-lead-intelligence-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lead-scanner.ts` | Create | Main scanner loop: orchestrates sources, stores leads |
| `src/lead-sources/finn-wanted.ts` | Create | Scrape Finn "ønskes kjøpt" listings |
| `src/lead-sources/mascus.ts` | Create | Scrape Mascus.no listings with prices |
| `src/lead-sources/machineryline.ts` | Create | Scrape Machineryline.com listings with prices |
| `src/lead-sources/types.ts` | Create | Shared RawSignal interface |
| `src/lead-sources/matcher.ts` | Create | Match leads against ATS/LBS cache, calculate price diff |
| `src/lead-scanner.test.ts` | Create | Tests for DB operations and matching logic |
| `container/skills/leads/leads.sh` | Create | Container skill for querying leads |
| `container/skills/leads/SKILL.md` | Create | Skill documentation |
| `src/direct-agent.ts` | Modify | Add `leads` tool |
| `src/index.ts` | Modify | Spawn lead scanner in direct mode |

---

### Task 1: Types and lead database

Create the shared types and database schema.

**Files:**
- Create: `src/lead-sources/types.ts`
- Create: `src/lead-scanner.ts` (DB portion only)
- Create: `src/lead-scanner.test.ts`

- [ ] **Step 1: Create shared types**

Create `src/lead-sources/types.ts`:

```typescript
export interface RawSignal {
  source: 'finn_wanted' | 'finn_supply' | 'mascus' | 'machineryline';
  externalUrl: string;
  title: string;
  description: string;
  category: string;
  price: number | null;
  contactName: string | null;
  contactInfo: string | null;
  publishedAt: string;
  externalId: string;
}

export interface MatchResult {
  matchStatus: 'has_match' | 'no_match' | 'price_opportunity';
  matchedAds: Array<{ source: 'ats' | 'lbs'; id: string | number; title: string; price: number }>;
  priceDiffPct: number | null;
}
```

- [ ] **Step 2: Create lead scanner with DB schema**

Create `src/lead-scanner.ts`:

```typescript
/**
 * Lead Intelligence Scanner
 * Scans external marketplaces for buy signals and price opportunities.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { RawSignal, MatchResult } from './lead-sources/types.js';

export function resolveLeadDbPath(): string {
  const dir = process.env.LEAD_DB_DIR || path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'leads.sqlite');
}

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
      created_at TEXT NOT NULL
    );

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

  return db;
}

export function insertLead(
  db: Database.Database,
  signal: RawSignal,
  signalType: 'demand' | 'supply',
  match: MatchResult,
): boolean {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO leads
        (source, signal_type, external_id, external_url, title, description,
         category, price, contact_name, contact_info, published_at,
         match_status, matched_ads, price_diff_pct, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
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
      new Date().toISOString(),
    );
    return true;
  } catch {
    return false; // duplicate external_id
  }
}
```

- [ ] **Step 3: Write tests for DB operations**

Create `src/lead-scanner.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initLeadDb, insertLead } from './lead-scanner.js';
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
    matchedAds: [{ source: 'ats', id: 22819, title: 'Volvo EC220', price: 450000 }],
    priceDiffPct: null,
    ...overrides,
  };
}

describe('initLeadDb', () => {
  it('creates leads table and FTS index', () => {
    const db = initLeadDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('leads');
    expect(tables).toContain('leads_fts');
    db.close();
  });
});

describe('insertLead', () => {
  let db: Database.Database;
  beforeEach(() => { db = initLeadDb(':memory:'); });

  it('inserts a demand lead', () => {
    const ok = insertLead(db, makeSignal(), 'demand', makeMatch());
    expect(ok).toBe(true);
    const row = db.prepare('SELECT * FROM leads WHERE external_id = ?').get('finn-123') as any;
    expect(row.title).toBe('Ønsker å kjøpe gravemaskin Volvo');
    expect(row.signal_type).toBe('demand');
    expect(row.match_status).toBe('has_match');
  });

  it('skips duplicate external_id', () => {
    insertLead(db, makeSignal(), 'demand', makeMatch());
    const ok = insertLead(db, makeSignal(), 'demand', makeMatch());
    expect(ok).toBe(false);
    const count = db.prepare('SELECT count(*) as c FROM leads').get() as any;
    expect(count.c).toBe(1);
  });

  it('FTS search finds lead by title', () => {
    insertLead(db, makeSignal(), 'demand', makeMatch());
    const results = db.prepare(
      "SELECT l.* FROM leads_fts f JOIN leads l ON l.id = f.rowid WHERE leads_fts MATCH 'gravemaskin'"
    ).all();
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
    insertLead(db, signal, 'supply', match);
    const row = db.prepare('SELECT * FROM leads WHERE external_id = ?').get('mascus-456') as any;
    expect(row.price).toBe(350000);
    expect(row.price_diff_pct).toBe(22);
  });
});
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run src/lead-scanner.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/lead-sources/types.ts src/lead-scanner.ts src/lead-scanner.test.ts
git commit -m "feat: add lead intelligence DB schema with FTS5 and dedup"
```

---

### Task 2: Source parsers — Finn, Mascus, Machineryline

Create the three scrapers that fetch and parse listings from each source.

**Files:**
- Create: `src/lead-sources/finn-wanted.ts`
- Create: `src/lead-sources/mascus.ts`
- Create: `src/lead-sources/machineryline.ts`

- [ ] **Step 1: Create Finn "ønskes kjøpt" parser**

Create `src/lead-sources/finn-wanted.ts`:

```typescript
import { RawSignal } from './types.js';

const FINN_URLS = [
  'https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&category=0.67',  // Landbruk
  'https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&category=0.69',  // Næringsvirksomhet
];

function parseListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];
  // Match each article.sf-search-ad block
  const adPattern = /<article[^>]*class="[^"]*sf-search-ad[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const block = match[1];

    // Extract link and ID
    const linkMatch = block.match(/href="([^"]*\/item\/(\d+)[^"]*)"/);
    if (!linkMatch) continue;
    const url = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.finn.no${linkMatch[1]}`;
    const externalId = `finn-${linkMatch[2]}`;

    // Extract title
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    // Extract price
    const priceMatch = block.match(/font-bold[^>]*>[\s\S]*?<span[^>]*>([\d\s]+)\s*kr/);
    const price = priceMatch
      ? parseInt(priceMatch[1].replace(/\s/g, ''), 10)
      : null;

    // Extract location
    const locMatch = block.match(/s-text-subtle[^>]*>[\s\S]*?<span[^>]*>([^<]+)</);
    const location = locMatch ? locMatch[1].trim() : '';

    if (title) {
      signals.push({
        source: 'finn_wanted',
        externalUrl: url,
        title,
        description: `${title} — ${location}`,
        category: '',
        price,
        contactName: null,
        contactInfo: null,
        publishedAt: new Date().toISOString().slice(0, 10),
        externalId,
      });
    }
  }

  return signals;
}

export async function scrapeFinnWanted(): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];

  for (const baseUrl of FINN_URLS) {
    try {
      // Fetch first 2 pages
      for (let page = 1; page <= 2; page++) {
        const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
        });
        if (!res.ok) break;
        const html = await res.text();
        allSignals.push(...parseListings(html));
      }
    } catch (err) {
      console.error(`[lead-scanner] Finn scrape error: ${(err as Error).message}`);
    }
  }

  return allSignals;
}
```

- [ ] **Step 2: Create Mascus parser**

Create `src/lead-sources/mascus.ts`:

```typescript
import { RawSignal } from './types.js';

const MASCUS_URLS = [
  'https://www.mascus.no/anlegg/gravemaskiner',
  'https://www.mascus.no/anlegg/hjullastere',
  'https://www.mascus.no/landbruk/traktorer',
  'https://www.mascus.no/transport/lastebiler',
];

function parseListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];

  // Match listing blocks using data-index attribute
  const adPattern = /<div[^>]*data-index="(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]*data-index="|$)/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const block = match[2];

    // Extract link
    const linkMatch = block.match(/href="(\/[^"]*\.html)"/);
    if (!linkMatch) continue;
    const url = `https://www.mascus.no${linkMatch[1]}`;
    const externalId = `mascus-${linkMatch[1].replace(/[^a-zA-Z0-9]/g, '-')}`;

    // Extract title from h3
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    // Extract price
    const priceMatch = block.match(/heading5[^>]*>([\d\s,.]+)\s*(NOK|EUR)/i);
    let price: number | null = null;
    if (priceMatch) {
      price = parseInt(priceMatch[1].replace(/[\s,.]/g, ''), 10);
      if (priceMatch[2].toUpperCase() === 'EUR') price = Math.round(price * 11.1);
    }

    // Extract specs (year, hours, location)
    const specsMatch = block.match(/basicText2Style[^>]*>([^<]+)/);
    const specs = specsMatch ? specsMatch[1].trim() : '';

    if (title) {
      signals.push({
        source: 'mascus',
        externalUrl: url,
        title,
        description: `${title} — ${specs}`,
        category: '',
        price,
        contactName: null,
        contactInfo: null,
        publishedAt: new Date().toISOString().slice(0, 10),
        externalId,
      });
    }
  }

  return signals;
}

export async function scrapeMascus(): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];

  for (const url of MASCUS_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      allSignals.push(...parseListings(html));
    } catch (err) {
      console.error(`[lead-scanner] Mascus scrape error: ${(err as Error).message}`);
    }
  }

  return allSignals;
}
```

- [ ] **Step 3: Create Machineryline parser**

Create `src/lead-sources/machineryline.ts`:

```typescript
import { RawSignal } from './types.js';

const ML_URLS = [
  'https://www.machineryline.com/-/excavators--c163',
  'https://www.machineryline.com/-/wheel-loaders--c164',
  'https://www.machineryline.com/-/tractors--c185',
  'https://www.machineryline.com/-/dump-trucks--c167',
];

function parseListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];

  // Match each sl-item div using data-code attribute
  const adPattern = /<div[^>]*class="[^"]*sl-item[^"]*"[^>]*data-code="(\d+)"[^>]*data-name="([^"]*)"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*sl-item[^"]*"|<\/section>)/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const externalId = `ml-${match[1]}`;
    const title = match[2];
    const block = match[3];

    // Extract link
    const linkMatch = block.match(/href="(\/[^"]*sale[^"]*)"/);
    const url = linkMatch
      ? `https://www.machineryline.com${linkMatch[1]}`
      : `https://www.machineryline.com`;

    // Extract price
    const priceMatch = block.match(/price-value[^>]*title="Price"[^>]*>([^<]+)/);
    let price: number | null = null;
    if (priceMatch) {
      const raw = priceMatch[1].replace(/[^0-9.,]/g, '');
      price = parseInt(raw.replace(/[.,]/g, ''), 10);
      // Machineryline shows EUR by default for .com
      if (price && !priceMatch[1].includes('NOK')) {
        price = Math.round(price * 11.1);
      }
    }

    // Extract location
    const locMatch = block.match(/location-text[^>]*>([^<]+)/);
    const location = locMatch ? locMatch[1].trim() : '';

    // Extract year and hours
    const yearMatch = block.match(/title="year"[^>]*>([^<]+)/);
    const hoursMatch = block.match(/title="running hours"[^>]*>([^<]+)/);
    const year = yearMatch ? yearMatch[1].trim() : '';
    const hours = hoursMatch ? hoursMatch[1].trim() : '';

    if (title) {
      signals.push({
        source: 'machineryline',
        externalUrl: url,
        title,
        description: `${title} ${year} ${hours} — ${location}`.trim(),
        category: '',
        price,
        contactName: null,
        contactInfo: null,
        publishedAt: new Date().toISOString().slice(0, 10),
        externalId,
      });
    }
  }

  return signals;
}

export async function scrapeMachineryline(): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];

  for (const url of ML_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      allSignals.push(...parseListings(html));
    } catch (err) {
      console.error(`[lead-scanner] Machineryline scrape error: ${(err as Error).message}`);
    }
  }

  return allSignals;
}
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add src/lead-sources/
git commit -m "feat: add source parsers for Finn, Mascus, and Machineryline"
```

---

### Task 3: Matcher — compare against ATS/LBS inventory

Match scraped signals against the local ATS/LBS caches.

**Files:**
- Create: `src/lead-sources/matcher.ts`

- [ ] **Step 1: Create matcher module**

Create `src/lead-sources/matcher.ts`:

```typescript
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

import { RawSignal, MatchResult } from './types.js';

function openCacheDb(filename: string): Database.Database | null {
  const dbPath = path.join(
    process.env.ATS_CACHE_DIR || path.resolve(process.cwd(), 'data'),
    filename,
  );
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

interface CacheMatch {
  source: 'ats' | 'lbs';
  id: string | number;
  title: string;
  price: number;
}

function searchCache(
  db: Database.Database,
  source: 'ats' | 'lbs',
  query: string,
): CacheMatch[] {
  // Extract meaningful keywords (skip short words)
  const words = query
    .replace(/[^\w\sæøåÆØÅ]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5);
  if (words.length === 0) return [];

  const ftsQuery = words.map((w) => `"${w}"`).join(' OR ');

  try {
    const idCol = source === 'ats' ? 'a.id' : 'a.id';
    const titleCol = source === 'ats' ? 'a.title_no' : 'a.title';
    const priceCol = 'a.price';

    const rows = db
      .prepare(
        `SELECT ${idCol} as id, ${titleCol} as title, ${priceCol} as price
         FROM ads_fts f JOIN ads a ON a.${source === 'ats' ? 'id' : 'rowid'} = f.rowid
         WHERE ads_fts MATCH ? AND a.status = 'published'
         ORDER BY f.rank LIMIT 5`,
      )
      .all(ftsQuery) as any[];

    return rows
      .filter((r) => r.price)
      .map((r) => ({
        source,
        id: r.id,
        title: (r.title || '').slice(0, 80),
        price: r.price,
      }));
  } catch {
    return [];
  }
}

export function matchSignal(signal: RawSignal): MatchResult {
  const matches: CacheMatch[] = [];

  const atsDb = openCacheDb('ats-feed-cache.sqlite');
  if (atsDb) {
    matches.push(...searchCache(atsDb, 'ats', signal.title));
    atsDb.close();
  }

  const lbsDb = openCacheDb('lbs-feed-cache.sqlite');
  if (lbsDb) {
    matches.push(...searchCache(lbsDb, 'lbs', signal.title));
    lbsDb.close();
  }

  // Calculate price diff for supply signals
  let priceDiffPct: number | null = null;
  if (signal.price && matches.length > 0) {
    const avgOurPrice =
      matches.reduce((sum, m) => sum + m.price, 0) / matches.length;
    if (avgOurPrice > 0) {
      priceDiffPct = Math.round(
        ((avgOurPrice - signal.price) / avgOurPrice) * 100,
      );
    }
  }

  let matchStatus: MatchResult['matchStatus'] = 'no_match';
  if (matches.length > 0 && priceDiffPct !== null && priceDiffPct > 15) {
    matchStatus = 'price_opportunity';
  } else if (matches.length > 0) {
    matchStatus = 'has_match';
  }

  return { matchStatus, matchedAds: matches, priceDiffPct };
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add src/lead-sources/matcher.ts
git commit -m "feat: add lead matcher — compare signals against ATS/LBS inventory"
```

---

### Task 4: Scanner main loop

Wire the parsers and matcher into the main scanner loop.

**Files:**
- Modify: `src/lead-scanner.ts` (add scan loop)

- [ ] **Step 1: Add scan loop to lead-scanner.ts**

Add at the end of `src/lead-scanner.ts` (after `insertLead`):

```typescript
import { scrapeFinnWanted } from './lead-sources/finn-wanted.js';
import { scrapeMascus } from './lead-sources/mascus.js';
import { scrapeMachineryline } from './lead-sources/machineryline.js';
import { matchSignal } from './lead-sources/matcher.js';

async function scanAllSources(db: Database.Database): Promise<void> {
  console.log('[lead-scanner] Starting scan...');
  let totalNew = 0;

  // Finn "ønskes kjøpt" — demand signals
  try {
    const finnSignals = await scrapeFinnWanted();
    for (const signal of finnSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'demand', match)) totalNew++;
    }
    console.log(`[lead-scanner] Finn: ${finnSignals.length} found, ${totalNew} new`);
  } catch (err) {
    console.error(`[lead-scanner] Finn scan failed: ${(err as Error).message}`);
  }

  // Mascus — supply/price signals
  const beforeMascus = totalNew;
  try {
    const mascusSignals = await scrapeMascus();
    for (const signal of mascusSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'supply', match)) totalNew++;
    }
    console.log(`[lead-scanner] Mascus: ${mascusSignals.length} found, ${totalNew - beforeMascus} new`);
  } catch (err) {
    console.error(`[lead-scanner] Mascus scan failed: ${(err as Error).message}`);
  }

  // Machineryline — supply/price signals
  const beforeMl = totalNew;
  try {
    const mlSignals = await scrapeMachineryline();
    for (const signal of mlSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'supply', match)) totalNew++;
    }
    console.log(`[lead-scanner] Machineryline: ${mlSignals.length} found, ${totalNew - beforeMl} new`);
  } catch (err) {
    console.error(`[lead-scanner] Machineryline scan failed: ${(err as Error).message}`);
  }

  console.log(`[lead-scanner] Scan complete: ${totalNew} new leads total`);
}

export async function runScanLoop(): Promise<void> {
  const dbPath = resolveLeadDbPath();
  const db = initLeadDb(dbPath);
  console.log(`[lead-scanner] Lead DB at ${dbPath}`);

  // Initial scan
  await scanAllSources(db);

  // Re-scan every 30 minutes
  setInterval(async () => {
    try {
      await scanAllSources(db);
    } catch (err) {
      console.error(`[lead-scanner] Scan error: ${(err as Error).message}`);
    }
  }, 30 * 60 * 1000);
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  runScanLoop().catch((err) => {
    console.error('[lead-scanner] Fatal error:', err);
    process.exit(1);
  });
}
```

Note: the imports for the source parsers and matcher should be added at the top of the file, after the existing imports.

- [ ] **Step 2: Build and run tests**

Run: `npm run build && npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/lead-scanner.ts
git commit -m "feat: add lead scanner main loop — scans all sources every 30 min"
```

---

### Task 5: Container skill and direct agent tool

Expose leads to the agent via a bash skill and direct agent tool.

**Files:**
- Create: `container/skills/leads/leads.sh`
- Create: `container/skills/leads/SKILL.md`
- Modify: `src/direct-agent.ts`

- [ ] **Step 1: Create leads.sh**

Create `container/skills/leads/leads.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

LEAD_DB="${LEAD_DB:-data/leads.sqlite}"

case "${1:-help}" in
  list)
    COUNT="${2:-20}"
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, signal_type, substr(title,1,60) as title, price,
             match_status, price_diff_pct, status, created_at
      FROM leads ORDER BY created_at DESC LIMIT $COUNT
    " | jq '.[]'
    ;;

  demand)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,60) as title, contact_name, contact_info,
             match_status, external_url, created_at
      FROM leads WHERE signal_type = 'demand' AND status = 'new'
      ORDER BY created_at DESC LIMIT ${2:-20}
    " | jq '.[]'
    ;;

  opportunities)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,60) as title, price, price_diff_pct,
             matched_ads, external_url, created_at
      FROM leads WHERE match_status = 'price_opportunity' AND status = 'new'
      ORDER BY price_diff_pct DESC LIMIT ${2:-20}
    " | jq '.[]'
    ;;

  search)
    [ -z "${2:-}" ] && echo "Usage: leads search <query>" >&2 && exit 1
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    ESCAPED="${2//\"/\"\"}"
    sqlite3 -json "$LEAD_DB" "
      SELECT l.id, l.source, l.signal_type, substr(l.title,1,60) as title, l.price,
             l.match_status, l.external_url, l.created_at
      FROM leads_fts f JOIN leads l ON l.id = f.rowid
      WHERE leads_fts MATCH '\"${ESCAPED}\"'
      ORDER BY f.rank LIMIT 20
    " | jq '.[]'
    ;;

  stats)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    echo "=== Lead Statistics ==="
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' total leads' FROM leads"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' new' FROM leads WHERE status = 'new'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' demand (buy signals)' FROM leads WHERE signal_type = 'demand'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' supply (price opportunities)' FROM leads WHERE match_status = 'price_opportunity'"
    echo "--- By source ---"
    sqlite3 "$LEAD_DB" "SELECT source || ': ' || count(*) FROM leads GROUP BY source"
    ;;

  help|*)
    cat <<EOF
Leads Tool — Query lead intelligence database

Usage:
  leads list [count]        List newest leads (default: 20)
  leads demand [count]      Show buy signals (people looking for equipment)
  leads opportunities       Show price opportunities (cheaper elsewhere)
  leads search <query>      Search leads by keyword
  leads stats               Show summary statistics
EOF
    ;;
esac
```

- [ ] **Step 2: Make executable and create SKILL.md**

```bash
chmod +x container/skills/leads/leads.sh
```

Create `container/skills/leads/SKILL.md`:

```markdown
# Leads Tool

Query the lead intelligence database for buy signals and price opportunities.

## Commands

- `leads list` — Show newest leads
- `leads demand` — Show people looking to buy equipment (potential customers)
- `leads opportunities` — Show equipment priced lower on other platforms (buy/resell opportunity)
- `leads search "volvo"` — Search leads by keyword
- `leads stats` — Summary statistics
```

- [ ] **Step 3: Add leads tool to direct-agent.ts**

In `src/direct-agent.ts`, add to `buildTools()` after `lbs_feed`:

```typescript
    {
      name: 'leads',
      description:
        'Query the lead intelligence database. Commands: list [count], demand [count], opportunities, search <query>, stats.',
      input_schema: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string',
            description: 'Command: list, demand, opportunities, search, or stats',
            enum: ['list', 'demand', 'opportunities', 'search', 'stats'],
          },
          argument: {
            type: 'string',
            description: 'Count for list/demand, or search query for search',
          },
        },
        required: ['command'],
      },
    },
```

Add to `executeTool()` after `lbs_feed`:

```typescript
    case 'leads': {
      const scriptPath = path.join(
        process.cwd(),
        'container',
        'skills',
        'leads',
        'leads.sh',
      );
      if (!fs.existsSync(scriptPath)) {
        return 'Error: leads.sh not found';
      }
      return new Promise((resolve) => {
        const args = [input.command as string];
        if (input.argument) args.push(input.argument as string);
        execFile(
          scriptPath,
          args,
          { timeout: 30_000 },
          (error, stdout, stderr) => {
            if (error) resolve(`Error: ${stderr || error.message}`);
            else resolve(stdout || 'No results');
          },
        );
      });
    }
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run`
Expected: All pass (update buildTools test count if needed)

- [ ] **Step 5: Commit**

```bash
git add container/skills/leads/ src/direct-agent.ts
git commit -m "feat: add leads container skill and direct agent tool"
```

---

### Task 6: Wire scanner into NanoClaw and deploy

Start the lead scanner as a child process in direct mode.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add lead scanner spawn**

In `src/index.ts`, in the direct mode block where ATS and LBS sync are spawned, add:

```typescript
    const leadScanScript = path.join(
      process.cwd(),
      'dist',
      'lead-scanner.js',
    );
    if (fs.existsSync(leadScanScript)) {
      const leadScan = spawn('node', [leadScanScript], {
        stdio: 'inherit',
        env: {
          ...process.env,
          LEAD_DB_DIR: path.resolve(process.cwd(), 'data'),
        },
      });
      leadScan.on('exit', (code) => {
        logger.warn({ code }, 'Lead scanner process exited');
      });
      logger.info('Lead scanner started');
    }
```

- [ ] **Step 2: Add sqlite3 to Dockerfile (already present)**

Verify `sqlite3` is already in `customer/Dockerfile` apt-get line (added in ATS feed cache task).

- [ ] **Step 3: Build, test, commit**

Run: `npm run build && npx vitest run`

```bash
git add src/index.ts
git commit -m "feat: spawn lead scanner in direct mode"
```

- [ ] **Step 4: Push and deploy**

```bash
git push origin main
ssh root@204.168.178.32 'cd /opt/assistent && git pull && docker build --no-cache -f customer/Dockerfile -t nanoclaw-customer:latest . && docker stop nanoclaw-ats && docker rm nanoclaw-ats && rm -f /opt/nanoclaw-customers/ats/store/messages.db && docker run -d --name nanoclaw-ats --restart unless-stopped --env-file /opt/nanoclaw-customers/ats/.env -v /opt/nanoclaw-customers/ats/data:/app/data -v /opt/nanoclaw-customers/ats/groups:/app/groups -v /root/.gmail-mcp-ats-test:/app/credentials -v /opt/nanoclaw-customers/ats/store:/app/store --memory=1g --cpus=1.0 nanoclaw-customer:latest'
```

- [ ] **Step 5: Verify scanner runs**

```bash
ssh root@204.168.178.32 'docker logs nanoclaw-ats 2>&1 | grep lead-scanner'
```

Expected: `[lead-scanner] Scan complete: N new leads total`
