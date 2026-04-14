import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiAd {
  id: number;
  status: string;
  price: number | null;
  price_euro: number | null;
  year: number | null;
  make_id: number | null;
  model_id: number | null;
  category_id: number | null;
  fts_nb_no: string | null;
  fts_en_us: string | null;
  fts_de_de: string | null;
  county_id: number | null;
  zipcode: string | null;
  published: string | null;
  changed: string | null;
}

interface ApiResponse {
  data: ApiAd[];
  meta: {
    last_page: number;
    current_page: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

export function resolveDbPath(): string {
  const dir = process.env.ATS_CACHE_DIR || path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ats-feed-cache.sqlite');
}

export function initCacheDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      price REAL,
      price_euro REAL,
      year INTEGER,
      make_id INTEGER,
      model_id INTEGER,
      category_id INTEGER,
      title_no TEXT,
      title_en TEXT,
      title_de TEXT,
      county_id INTEGER,
      zipcode TEXT,
      published_at TEXT,
      changed_at TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ads_fts USING fts5(
      title_no,
      title_en,
      title_de,
      content='ads',
      content_rowid='id'
    );

    -- Triggers to keep FTS index in sync with ads table
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

export function upsertAd(
  db: Database.Database,
  ad: ApiAd,
  syncedAt: string,
): void {
  if (ad.status !== 'published') return;

  db.prepare(
    `INSERT INTO ads (id, status, price, price_euro, year, make_id, model_id, category_id, title_no, title_en, title_de, county_id, zipcode, published_at, changed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       price = excluded.price,
       price_euro = excluded.price_euro,
       year = excluded.year,
       make_id = excluded.make_id,
       model_id = excluded.model_id,
       category_id = excluded.category_id,
       title_no = excluded.title_no,
       title_en = excluded.title_en,
       title_de = excluded.title_de,
       county_id = excluded.county_id,
       zipcode = excluded.zipcode,
       published_at = excluded.published_at,
       changed_at = excluded.changed_at,
       synced_at = excluded.synced_at`,
  ).run(
    ad.id,
    ad.status,
    ad.price ?? null,
    ad.price_euro ?? null,
    ad.year ?? null,
    ad.make_id ?? null,
    ad.model_id ?? null,
    ad.category_id ?? null,
    ad.fts_nb_no ?? null,
    ad.fts_en_us ?? null,
    ad.fts_de_de ?? null,
    ad.county_id ?? null,
    ad.zipcode ?? null,
    ad.published ?? null,
    ad.changed ?? null,
    syncedAt,
  );
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API_BASE = 'https://api3.ats.no/api/v3/ad';

const PAGE_DELAY_MS = 200; // Delay between API calls to avoid 429 rate limiting

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(page: number): Promise<ApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(`${API_BASE}?page=${page}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 429) {
      console.log(
        `[ats-feed-sync] Rate limited on page ${page}, waiting 5s...`,
      );
      await sleep(5000);
      return fetchPage(page); // retry
    }
    if (!res.ok) {
      throw new Error(`ATS API error: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as ApiResponse;
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`ATS API timeout on page ${page}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sync strategies
// ---------------------------------------------------------------------------

export async function fullSync(db: Database.Database): Promise<void> {
  const syncedAt = new Date().toISOString();

  // Get last page number first
  const firstRes = await fetchPage(1);
  const lastPage = firstRes.meta.last_page;
  console.log(
    `[ats-feed-sync] Starting full sync: ${lastPage} pages (newest first)`,
  );

  let totalUpserted = 0;
  let consecutiveErrors = 0;

  // Paginate backwards — newest ads (published) are on the last pages
  for (let page = lastPage; page >= 1; page--) {
    try {
      const res = await fetchPage(page);
      consecutiveErrors = 0;

      const upsertMany = db.transaction((ads: ApiAd[]) => {
        for (const ad of ads) {
          upsertAd(db, ad, syncedAt);
        }
      });
      upsertMany(res.data);

      totalUpserted += res.data.filter((a) => a.status === 'published').length;

      const processed = lastPage - page + 1;
      if (processed % 100 === 0) {
        console.log(
          `[ats-feed-sync] Progress: ${processed}/${lastPage} pages (${totalUpserted} ads)`,
        );
      }
    } catch (err) {
      consecutiveErrors++;
      console.error(
        `[ats-feed-sync] Error on page ${page}: ${(err as Error).message}`,
      );
      if (consecutiveErrors >= 5) {
        console.error(
          `[ats-feed-sync] Too many consecutive errors, stopping full sync`,
        );
        break;
      }
    }

    await sleep(PAGE_DELAY_MS);
  }

  // Delete stale ads (not seen in this full sync) — only if we got most pages
  if (totalUpserted > 0) {
    const deleteResult = db
      .prepare(`DELETE FROM ads WHERE synced_at < ?`)
      .run(syncedAt);
    console.log(
      `[ats-feed-sync] Full sync complete: ${totalUpserted} ads, ${deleteResult.changes} stale removed`,
    );
  } else {
    console.log(`[ats-feed-sync] Full sync complete: no published ads found`);
  }
}

export async function incrementalSync(db: Database.Database): Promise<void> {
  const syncedAt = new Date().toISOString();
  let totalUpserted = 0;

  // Fetch page 1 to get last_page, then fetch the last 5 pages (newest ads)
  const first = await fetchPage(1);
  const lastPage = first.meta.last_page;
  const startPage = Math.max(1, lastPage - 4);

  for (let page = lastPage; page >= startPage; page--) {
    const res = await fetchPage(page);

    const upsertMany = db.transaction((ads: ApiAd[]) => {
      for (const ad of ads) {
        upsertAd(db, ad, syncedAt);
      }
    });
    upsertMany(res.data);

    totalUpserted += res.data.filter((a) => a.status === 'published').length;
    await sleep(PAGE_DELAY_MS);
  }

  if (totalUpserted > 0) {
    console.log(
      `[ats-feed-sync] Incremental sync: ${totalUpserted} ads upserted`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runSyncLoop(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = initCacheDb(dbPath);
  console.log(`[ats-feed-sync] Cache DB at ${dbPath}`);

  // Full sync on startup
  try {
    await fullSync(db);
  } catch (err) {
    console.error('[ats-feed-sync] Full sync failed on startup:', err);
  }

  let lastFullSync = Date.now();
  const FULL_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
  const INCREMENTAL_INTERVAL = 90 * 1000; // 90 seconds

  const tick = async () => {
    try {
      const now = Date.now();
      if (now - lastFullSync >= FULL_SYNC_INTERVAL) {
        await fullSync(db);
        lastFullSync = now;
      } else {
        await incrementalSync(db);
      }
    } catch (err) {
      console.error('[ats-feed-sync] Sync error:', err);
    }
  };

  setInterval(() => void tick(), INCREMENTAL_INTERVAL);
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
    console.error('[ats-feed-sync] Fatal error:', err);
    process.exit(1);
  });
}
