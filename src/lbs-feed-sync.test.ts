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
    images: [
      {
        url: 'https://example.com/img.jpg',
        url_thumbnail: 'https://example.com/thumb.jpg',
      },
    ],
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

    const row = db
      .prepare('SELECT price FROM ads WHERE id = ?')
      .get('1234') as any;
    expect(row.price).toBe(750000);
  });

  it('FTS search finds ad by title', () => {
    upsertAd(db, makeLbsAd(), '2026-04-14T10:00:00Z');
    upsertAd(
      db,
      makeLbsAd({
        id: '5678',
        title: 'Kverneland plog',
        make: 'Kverneland',
        model: 'ES85',
      }),
      '2026-04-14T10:00:00Z',
    );

    const results = db
      .prepare(
        `SELECT a.id, a.title FROM ads_fts f JOIN ads a ON a.rowid = f.rowid WHERE ads_fts MATCH '"John Deere"'`,
      )
      .all() as any[];

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1234');
  });

  it('stores first image URL', () => {
    upsertAd(db, makeLbsAd(), '2026-04-14T10:00:00Z');
    const row = db
      .prepare('SELECT image_url FROM ads WHERE id = ?')
      .get('1234') as any;
    expect(row.image_url).toBe('https://example.com/img.jpg');
  });
});
