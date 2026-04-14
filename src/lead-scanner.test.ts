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
    matchedAds: [
      { source: 'ats', id: 22819, title: 'Volvo EC220', price: 450000 },
    ],
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
  beforeEach(() => {
    db = initLeadDb(':memory:');
  });

  it('inserts a demand lead', () => {
    const ok = insertLead(db, makeSignal(), 'demand', makeMatch());
    expect(ok).toBe(true);
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('finn-123') as any;
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
    insertLead(db, signal, 'supply', match);
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('mascus-456') as any;
    expect(row.price).toBe(350000);
    expect(row.price_diff_pct).toBe(22);
  });
});
