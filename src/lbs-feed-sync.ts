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
