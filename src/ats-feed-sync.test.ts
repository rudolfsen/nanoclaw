import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { ApiAd, initCacheDb, upsertAd } from './ats-feed-sync.js';

let db: Database.Database;

beforeEach(() => {
  db = initCacheDb(':memory:');
});

// ---------------------------------------------------------------------------
// initCacheDb
// ---------------------------------------------------------------------------

describe('initCacheDb', () => {
  it('creates the ads table', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ads'",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('creates the FTS index', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ads_fts'",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// upsertAd
// ---------------------------------------------------------------------------

function makeAd(overrides: Partial<ApiAd> = {}): ApiAd {
  return {
    id: 1,
    status: 'published',
    price: 250000,
    price_euro: 22000,
    year: 2020,
    make_id: 10,
    model_id: 100,
    category_id: 1,
    fts_nb_no: 'Volvo XC60 Diesel Automat',
    fts_en_us: 'Volvo XC60 Diesel Automatic',
    fts_de_de: 'Volvo XC60 Diesel Automatik',
    county_id: 3,
    zipcode: '0150',
    published: '2024-06-01T10:00:00Z',
    changed: '2024-06-02T12:00:00Z',
    ...overrides,
  };
}

describe('upsertAd', () => {
  it('inserts a published ad with correct data', () => {
    const ad = makeAd();
    upsertAd(db, ad, '2024-06-10T00:00:00Z');

    const row = db.prepare('SELECT * FROM ads WHERE id = ?').get(ad.id) as {
      id: number;
      status: string;
      price: number;
      price_euro: number;
      year: number;
      make_id: number;
      model_id: number;
      category_id: number;
      title_no: string;
      title_en: string;
      title_de: string;
      county_id: number;
      zipcode: string;
      published_at: string;
      changed_at: string;
      synced_at: string;
    };

    expect(row).toBeDefined();
    expect(row.id).toBe(1);
    expect(row.status).toBe('published');
    expect(row.price).toBe(250000);
    expect(row.price_euro).toBe(22000);
    expect(row.year).toBe(2020);
    expect(row.make_id).toBe(10);
    expect(row.model_id).toBe(100);
    expect(row.category_id).toBe(1);
    expect(row.title_no).toBe('Volvo XC60 Diesel Automat');
    expect(row.title_en).toBe('Volvo XC60 Diesel Automatic');
    expect(row.title_de).toBe('Volvo XC60 Diesel Automatik');
    expect(row.county_id).toBe(3);
    expect(row.zipcode).toBe('0150');
    expect(row.published_at).toBe('2024-06-01T10:00:00Z');
    expect(row.changed_at).toBe('2024-06-02T12:00:00Z');
    expect(row.synced_at).toBe('2024-06-10T00:00:00Z');
  });

  it('skips non-published ads', () => {
    upsertAd(db, makeAd({ status: 'draft' }), '2024-06-10T00:00:00Z');
    upsertAd(db, makeAd({ id: 2, status: 'sold' }), '2024-06-10T00:00:00Z');
    upsertAd(db, makeAd({ id: 3, status: 'archived' }), '2024-06-10T00:00:00Z');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM ads').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(0);
  });

  it('updates existing ad on conflict', () => {
    const ad = makeAd();
    upsertAd(db, ad, '2024-06-10T00:00:00Z');

    const updated = makeAd({ price: 230000, year: 2021 });
    upsertAd(db, updated, '2024-06-11T00:00:00Z');

    const row = db.prepare('SELECT * FROM ads WHERE id = ?').get(ad.id) as {
      price: number;
      year: number;
      synced_at: string;
    };

    expect(row.price).toBe(230000);
    expect(row.year).toBe(2021);
    expect(row.synced_at).toBe('2024-06-11T00:00:00Z');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM ads').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FTS search
// ---------------------------------------------------------------------------

describe('FTS search', () => {
  it('indexes content and matches Norwegian text', () => {
    upsertAd(
      db,
      makeAd({ id: 1, fts_nb_no: 'Volvo XC60 Diesel Automat' }),
      '2024-06-10T00:00:00Z',
    );

    const results = db
      .prepare(
        `SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'Diesel' ORDER BY rank`,
      )
      .all() as Array<{ rowid: number }>;
    expect(results).toHaveLength(1);
    expect(results[0].rowid).toBe(1);
  });

  it('indexes and matches English text', () => {
    upsertAd(
      db,
      makeAd({ id: 2, fts_en_us: 'Toyota Hilux Pickup Truck' }),
      '2024-06-10T00:00:00Z',
    );

    const results = db
      .prepare(
        `SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'Pickup' ORDER BY rank`,
      )
      .all() as Array<{ rowid: number }>;
    expect(results).toHaveLength(1);
    expect(results[0].rowid).toBe(2);
  });

  it('indexes and matches German text', () => {
    upsertAd(
      db,
      makeAd({ id: 3, fts_de_de: 'Mercedes Sprinter Transporter' }),
      '2024-06-10T00:00:00Z',
    );

    const results = db
      .prepare(
        `SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'Transporter' ORDER BY rank`,
      )
      .all() as Array<{ rowid: number }>;
    expect(results).toHaveLength(1);
    expect(results[0].rowid).toBe(3);
  });

  it('updates FTS when ad is updated', () => {
    upsertAd(
      db,
      makeAd({
        id: 1,
        fts_nb_no: 'Volvo XC60 Diesel',
        fts_en_us: 'Volvo XC60 Diesel',
        fts_de_de: 'Volvo XC60 Diesel',
      }),
      '2024-06-10T00:00:00Z',
    );

    // Verify initial match
    let results = db
      .prepare(
        `SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'Diesel' ORDER BY rank`,
      )
      .all() as Array<{ rowid: number }>;
    expect(results).toHaveLength(1);

    // Update the ad — all title fields changed, "Diesel" removed
    upsertAd(
      db,
      makeAd({
        id: 1,
        fts_nb_no: 'Volvo XC60 Bensin',
        fts_en_us: 'Volvo XC60 Petrol',
        fts_de_de: 'Volvo XC60 Benzin',
      }),
      '2024-06-11T00:00:00Z',
    );

    // Old term should no longer match
    results = db
      .prepare(
        `SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'Diesel' ORDER BY rank`,
      )
      .all() as Array<{ rowid: number }>;
    expect(results).toHaveLength(0);

    // New term should match
    results = db
      .prepare(
        `SELECT rowid FROM ads_fts WHERE ads_fts MATCH 'Bensin' ORDER BY rank`,
      )
      .all() as Array<{ rowid: number }>;
    expect(results).toHaveLength(1);
    expect(results[0].rowid).toBe(1);
  });
});
