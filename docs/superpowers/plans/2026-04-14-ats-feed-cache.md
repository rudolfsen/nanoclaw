# ATS Feed Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local SQLite cache with FTS5 full-text search over all ATS Norway ads, kept in sync by a background process, so `ats-feed.sh` can search reliably across 21 500+ ads.

**Architecture:** A standalone TypeScript sync script paginates the ATS API and upserts ads into a SQLite database with FTS5 indexing. `ats-feed.sh` is rewritten to query the local cache for `search` and `list` commands. NanoClaw spawns the sync script as a child process in direct mode.

**Tech Stack:** TypeScript, better-sqlite3, SQLite FTS5, bash (ats-feed.sh)

**Spec:** `docs/superpowers/specs/2026-04-14-ats-feed-cache-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/ats-feed-sync.ts` | Create | Sync script: paginates API, upserts into SQLite, manages FTS5 |
| `src/ats-feed-sync.test.ts` | Create | Tests for sync logic (DB operations, not API calls) |
| `container/skills/ats-feed/ats-feed.sh` | Rewrite | Query local cache for search/list, keep direct API for get |
| `src/index.ts` | Modify | Spawn sync script in direct mode |
| `customer/Dockerfile` | Modify | Add sqlite3 CLI to container |

---

### Task 1: Sync script — database setup and full sync

Create the sync script with SQLite schema, FTS5 table, and full sync logic.

**Files:**
- Create: `src/ats-feed-sync.ts`
- Create: `src/ats-feed-sync.test.ts`

- [ ] **Step 1: Create the sync script with DB schema**

Create `src/ats-feed-sync.ts`:

```typescript
/**
 * ATS Feed Sync — keeps a local SQLite cache of all ATS Norway ads.
 * Run as a long-lived background process.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const API_BASE = 'https://api3.ats.no/api/v3/ad';
const INCREMENTAL_INTERVAL_MS = 90_000;
const FULL_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const INCREMENTAL_PAGES = 5;

function resolveDbPath(): string {
  const dataDir = process.env.ATS_CACHE_DIR || path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'ats-feed-cache.sqlite');
}

export function initCacheDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'published',
      price INTEGER,
      price_euro INTEGER,
      year TEXT,
      make_id INTEGER,
      model_id INTEGER,
      category_id INTEGER,
      title_no TEXT,
      title_en TEXT,
      title_de TEXT,
      county_id INTEGER,
      zipcode INTEGER,
      published_at TEXT,
      changed_at TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ads_fts USING fts5(
      title_no, title_en, title_de,
      content='ads',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS ads_ai AFTER INSERT ON ads BEGIN
      INSERT INTO ads_fts(rowid, title_no, title_en, title_de)
      VALUES (new.id, new.title_no, new.title_en, new.title_de);
    END;

    CREATE TRIGGER IF NOT EXISTS ads_ad AFTER DELETE ON ads BEGIN
      INSERT INTO ads_fts(ads_fts, rowid, title_no, title_en, title_de)
      VALUES ('delete', old.id, old.title_no, old.title_en, old.title_de);
    END;

    CREATE TRIGGER IF NOT EXISTS ads_au AFTER UPDATE ON ads BEGIN
      INSERT INTO ads_fts(ads_fts, rowid, title_no, title_en, title_de)
      VALUES ('delete', old.id, old.title_no, old.title_en, old.title_de);
      INSERT INTO ads_fts(rowid, title_no, title_en, title_de)
      VALUES (new.id, new.title_no, new.title_en, new.title_de);
    END;
  `);

  return db;
}

interface ApiAd {
  id: number;
  status: string;
  price: number | null;
  price_euro: number | null;
  year: string | null;
  make_id: number | null;
  model_id: number | null;
  category_id: number | null;
  fts_nb_no: string | null;
  fts_en_us: string | null;
  fts_de_de: string | null;
  county_id: number | null;
  zipcode: number | null;
  published: string | null;
  changed: string | null;
}

interface ApiResponse {
  data: ApiAd[];
  meta: { last_page: number; current_page: number; total: number };
}

async function fetchPage(page: number): Promise<ApiResponse> {
  const res = await fetch(`${API_BASE}?page=${page}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<ApiResponse>;
}

export function upsertAd(db: Database.Database, ad: ApiAd, syncedAt: string): void {
  if (ad.status !== 'published') return;
  db.prepare(`
    INSERT INTO ads (id, status, price, price_euro, year, make_id, model_id,
      category_id, title_no, title_en, title_de, county_id, zipcode,
      published_at, changed_at, synced_at)
    VALUES (?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status='published', price=excluded.price, price_euro=excluded.price_euro,
      year=excluded.year, make_id=excluded.make_id, model_id=excluded.model_id,
      category_id=excluded.category_id, title_no=excluded.title_no,
      title_en=excluded.title_en, title_de=excluded.title_de,
      county_id=excluded.county_id, zipcode=excluded.zipcode,
      published_at=excluded.published_at, changed_at=excluded.changed_at,
      synced_at=excluded.synced_at
  `).run(
    ad.id, ad.price, ad.price_euro, ad.year, ad.make_id, ad.model_id,
    ad.category_id, ad.fts_nb_no, ad.fts_en_us, ad.fts_de_de,
    ad.county_id, ad.zipcode, ad.published, ad.changed, syncedAt,
  );
}

export async function fullSync(db: Database.Database): Promise<number> {
  const syncedAt = new Date().toISOString();
  const firstPage = await fetchPage(1);
  const lastPage = firstPage.meta.last_page;

  let count = 0;

  // Process in a transaction per page for performance
  for (let page = 1; page <= lastPage; page++) {
    const data = page === 1 ? firstPage : await fetchPage(page);
    const tx = db.transaction(() => {
      for (const ad of data.data) {
        upsertAd(db, ad, syncedAt);
        count++;
      }
    });
    tx();

    if (page % 100 === 0) {
      console.log(`[ats-feed-sync] Full sync: page ${page}/${lastPage}`);
    }
  }

  // Remove ads that were not seen in this sync (no longer published)
  const removed = db.prepare(
    `DELETE FROM ads WHERE synced_at < ?`
  ).run(syncedAt);

  console.log(
    `[ats-feed-sync] Full sync complete: ${count} ads processed, ${removed.changes} removed`,
  );

  return count;
}

export async function incrementalSync(db: Database.Database): Promise<number> {
  const syncedAt = new Date().toISOString();
  const firstPage = await fetchPage(1);
  const lastPage = firstPage.meta.last_page;

  let count = 0;
  const startPage = Math.max(1, lastPage - INCREMENTAL_PAGES + 1);

  for (let page = lastPage; page >= startPage; page--) {
    const data = page === lastPage && lastPage === firstPage.meta.last_page
      ? firstPage
      : await fetchPage(page);
    const tx = db.transaction(() => {
      for (const ad of data.data) {
        upsertAd(db, ad, syncedAt);
        count++;
      }
    });
    tx();
  }

  return count;
}

async function runSyncLoop(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = initCacheDb(dbPath);
  console.log(`[ats-feed-sync] Cache DB: ${dbPath}`);

  // Initial full sync
  await fullSync(db);

  let lastFullSync = Date.now();

  // Sync loop
  while (true) {
    await new Promise((r) => setTimeout(r, INCREMENTAL_INTERVAL_MS));

    try {
      if (Date.now() - lastFullSync > FULL_SYNC_INTERVAL_MS) {
        await fullSync(db);
        lastFullSync = Date.now();
      } else {
        const count = await incrementalSync(db);
        if (count > 0) {
          console.log(`[ats-feed-sync] Incremental: ${count} ads checked`);
        }
      }
    } catch (err) {
      console.error('[ats-feed-sync] Sync error:', err);
    }
  }
}

// Run when executed directly
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  runSyncLoop().catch((err) => {
    console.error('[ats-feed-sync] Fatal error:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Write tests for DB operations**

Create `src/ats-feed-sync.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initCacheDb, upsertAd, fullSync } from './ats-feed-sync.js';

function makeAd(overrides: Record<string, unknown> = {}) {
  return {
    id: 1000,
    status: 'published',
    price: 100000,
    price_euro: 9000,
    year: '2020',
    make_id: 1,
    model_id: 10,
    category_id: 100,
    fts_nb_no: 'Volvo gravemaskin 2020',
    fts_en_us: 'Volvo excavator 2020',
    fts_de_de: 'Volvo Bagger 2020',
    county_id: 3,
    zipcode: 1234,
    published: '2026-01-01T00:00:00Z',
    changed: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('initCacheDb', () => {
  it('creates ads table and FTS index', () => {
    const db = initCacheDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('ads');
    expect(tables).toContain('ads_fts');
    db.close();
  });
});

describe('upsertAd', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initCacheDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a published ad', () => {
    upsertAd(db, makeAd(), '2026-04-14T00:00:00Z');
    const row = db.prepare('SELECT * FROM ads WHERE id = 1000').get() as any;
    expect(row.price).toBe(100000);
    expect(row.title_no).toBe('Volvo gravemaskin 2020');
  });

  it('skips non-published ads', () => {
    upsertAd(db, makeAd({ status: 'closed' }), '2026-04-14T00:00:00Z');
    const row = db.prepare('SELECT * FROM ads WHERE id = 1000').get();
    expect(row).toBeUndefined();
  });

  it('updates existing ad on conflict', () => {
    upsertAd(db, makeAd({ price: 100000 }), '2026-04-14T00:00:00Z');
    upsertAd(db, makeAd({ price: 120000 }), '2026-04-14T01:00:00Z');
    const row = db.prepare('SELECT * FROM ads WHERE id = 1000').get() as any;
    expect(row.price).toBe(120000);
  });

  it('indexes ad in FTS table', () => {
    upsertAd(db, makeAd(), '2026-04-14T00:00:00Z');
    const results = db
      .prepare("SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'volvo'")
      .all();
    expect(results).toHaveLength(1);
  });

  it('FTS matches Norwegian, English, and German text', () => {
    upsertAd(db, makeAd(), '2026-04-14T00:00:00Z');
    const no = db.prepare("SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'gravemaskin'").all();
    const en = db.prepare("SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'excavator'").all();
    const de = db.prepare("SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'bagger'").all();
    expect(no).toHaveLength(1);
    expect(en).toHaveLength(1);
    expect(de).toHaveLength(1);
  });

  it('FTS updates when ad is updated', () => {
    upsertAd(db, makeAd({ fts_nb_no: 'Volvo gravemaskin' }), '2026-04-14T00:00:00Z');
    upsertAd(db, makeAd({ fts_nb_no: 'Caterpillar gravemaskin' }), '2026-04-14T01:00:00Z');
    const volvo = db.prepare("SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'volvo'").all();
    const cat = db.prepare("SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'caterpillar'").all();
    expect(volvo).toHaveLength(0);
    expect(cat).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm run build && npx vitest run src/ats-feed-sync.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/ats-feed-sync.ts src/ats-feed-sync.test.ts
git commit -m "feat: add ATS feed sync script with SQLite FTS5 cache"
```

---

### Task 2: Rewrite ats-feed.sh to query local cache

Replace the API-based search and list commands with SQLite queries against the local cache. Keep `get` as a direct API call.

**Files:**
- Rewrite: `container/skills/ats-feed/ats-feed.sh`

- [ ] **Step 1: Rewrite ats-feed.sh**

Replace `container/skills/ats-feed/ats-feed.sh` with:

```bash
#!/usr/bin/env bash
# Tool for querying the ATS Norway product feed.
# search/list use a local SQLite cache (built by sync-ats-feed).
# get calls the API directly for the freshest data.

set -euo pipefail

API_BASE="https://api3.ats.no/api/v3/ad"
CACHE_DB="${ATS_CACHE_DB:-data/ats-feed-cache.sqlite}"

case "${1:-help}" in
  list)
    COUNT="${2:-20}"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Falling back to API..." >&2
      curl -s "$API_BASE?status=published&\$top=$COUNT" | \
        jq -r '.data[] | {id, title: .fts_nb_no[0:80], price, price_euro, year, make_id, category_id}'
      exit 0
    fi
    sqlite3 -json "$CACHE_DB" "
      SELECT id, substr(title_no, 1, 80) as title, price, price_euro, year, make_id, category_id
      FROM ads WHERE status = 'published'
      ORDER BY published_at DESC
      LIMIT $COUNT
    " | jq '.[]'
    ;;

  get)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed get <id>" >&2
      exit 1
    fi
    curl -s "$API_BASE/$2" | jq '.data | {
      id, status, price, price_euro, year,
      make_id, model_id, category_id,
      title_no: (.fts_nb_no // "")[0:300],
      title_en: (.fts_en_us // "")[0:300],
      title_de: (.fts_de_de // "")[0:300],
      specs: .vegvesen,
      county_id, zipcode,
      published, changed,
      seller, seller_contact, importantinfo
    }'
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed search <query>" >&2
      exit 1
    fi
    QUERY="$2"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Try again in a moment." >&2
      exit 1
    fi
    # FTS5 query: quote the user's input to prevent syntax errors
    sqlite3 -json "$CACHE_DB" "
      SELECT a.id, substr(a.title_no, 1, 80) as title, a.price, a.price_euro, a.year, a.make_id
      FROM ads_fts f
      JOIN ads a ON a.id = f.rowid
      WHERE ads_fts MATCH '\"${QUERY//\"/\"\"}\"'
        AND a.status = 'published'
      ORDER BY rank
      LIMIT 20
    " | jq '.[]'
    RESULT_COUNT=$(sqlite3 "$CACHE_DB" "
      SELECT count(*) FROM ads_fts f JOIN ads a ON a.id = f.rowid
      WHERE ads_fts MATCH '\"${QUERY//\"/\"\"}\"' AND a.status = 'published'
    ")
    if [ "$RESULT_COUNT" -eq 0 ]; then
      echo "No results found for: $QUERY"
    fi
    ;;

  help|*)
    cat <<EOF
ATS Feed Tool — Query ATS Norway product database

Usage:
  ats-feed list [count]      List published ads (default: 20)
  ats-feed get <id>          Get full ad details by ID (live API)
  ats-feed search <query>    Search ads by keyword (local cache, FTS5)

Examples:
  ats-feed list 10
  ats-feed get 22898
  ats-feed search "volvo"
  ats-feed search "maur trippelkjerre"
EOF
    ;;
esac
```

- [ ] **Step 2: Test locally with existing cache**

First create a small test cache and verify the script works:

```bash
# Build the sync script
npm run build

# Run sync briefly to populate the cache (Ctrl+C after "Full sync complete")
node dist/ats-feed-sync.js &
SYNC_PID=$!
sleep 30 && kill $SYNC_PID

# Test the updated script
./container/skills/ats-feed/ats-feed.sh search "volvo"
./container/skills/ats-feed/ats-feed.sh search "maur trippelkjerre"
./container/skills/ats-feed/ats-feed.sh list 5
./container/skills/ats-feed/ats-feed.sh get 21420
```

Expected: search returns results from cache, list returns newest ads, get returns live API data.

- [ ] **Step 3: Commit**

```bash
git add container/skills/ats-feed/ats-feed.sh
git commit -m "feat: rewrite ats-feed.sh to use local SQLite FTS5 cache"
```

---

### Task 3: Spawn sync script from NanoClaw in direct mode

Start the sync process as a child process when `AGENT_MODE=direct`.

**Files:**
- Modify: `src/index.ts:597-610` (main function)

- [ ] **Step 1: Add sync spawn to main()**

In `src/index.ts`, add after the `loadState()` call (line 611) and before the OneCLI agent loop (line 614):

```typescript
  // Start ATS feed cache sync in direct mode
  if (AGENT_MODE === 'direct') {
    const syncScript = path.join(process.cwd(), 'dist', 'ats-feed-sync.js');
    if (fs.existsSync(syncScript)) {
      const { spawn } = await import('child_process');
      const syncProc = spawn('node', [syncScript], {
        stdio: 'inherit',
        env: { ...process.env, ATS_CACHE_DIR: path.resolve(process.cwd(), 'data') },
      });
      syncProc.on('exit', (code) => {
        logger.warn({ code }, 'ATS feed sync process exited');
      });
      logger.info('ATS feed sync started');
    }
  }
```

Note: `path` and `fs` are already imported in index.ts.

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: spawn ATS feed sync as child process in direct mode"
```

---

### Task 4: Add sqlite3 CLI to customer Dockerfile

The rewritten `ats-feed.sh` needs the `sqlite3` command-line tool.

**Files:**
- Modify: `customer/Dockerfile:16`

- [ ] **Step 1: Add sqlite3 to apt-get install**

In `customer/Dockerfile`, modify the `apt-get install` line (line 16):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq ca-certificates python3 make g++ sqlite3 \
  && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Commit**

```bash
git add customer/Dockerfile
git commit -m "feat: add sqlite3 CLI to customer Dockerfile for cache queries"
```

---

### Task 5: Deploy and verify on VPS

Build, push, and test the full pipeline on the VPS.

- [ ] **Step 1: Push to origin**

```bash
git push origin main
```

- [ ] **Step 2: Rebuild Docker image on VPS**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && docker build -f customer/Dockerfile -t nanoclaw-customer:latest .'
```

- [ ] **Step 3: Reset and restart container**

```bash
ssh root@204.168.178.32 'docker stop nanoclaw-ats && rm -f /opt/nanoclaw-customers/ats/data/db.sqlite /opt/nanoclaw-customers/ats/data/ats-feed-cache.sqlite && docker start nanoclaw-ats'
```

- [ ] **Step 4: Watch sync logs**

```bash
ssh root@204.168.178.32 'docker logs nanoclaw-ats -f' | grep ats-feed-sync
```

Expected: "Full sync complete: ~21500 ads processed"

- [ ] **Step 5: Send test email**

Send email to `ats.test.assistent@gmail.com` asking about "Maur Trippelkjerre". Verify:
1. Agent finds the ad via FTS5 search
2. Agent creates a draft with correct machine data
3. Draft appears in Gmail Drafts
