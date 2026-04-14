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

  it('inserts a growth signal from doffin', () => {
    const signal = makeSignal({
      source: 'doffin',
      externalId: 'doffin-2026-106721',
      title: 'Veibygging E39 Mandal-Lyngdal',
      companyName: 'Statens vegvesen',
      companyOrgnr: '971032081',
      naceCode: '42',
      location: 'Agder',
    });
    const result = upsertLead(
      db,
      signal,
      'growth',
      makeMatch({ matchStatus: 'no_match', matchedAds: [] }),
    );
    expect(result).toBe('inserted');
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('doffin-2026-106721') as any;
    expect(row.signal_type).toBe('growth');
    expect(row.company_name).toBe('Statens vegvesen');
    expect(row.company_orgnr).toBe('971032081');
    expect(row.nace_code).toBe('42');
    expect(row.location).toBe('Agder');
  });

  it('inserts a change signal from brreg bankruptcy', () => {
    const signal = makeSignal({
      source: 'brreg_bankrupt',
      externalId: 'brreg-934349148',
      title: '2T4 BYGG AS - Konkurs',
      companyName: '2T4 BYGG AS',
      companyOrgnr: '934349148',
      naceCode: '41.000',
      location: 'LARVIK',
    });
    const result = upsertLead(
      db,
      signal,
      'change',
      makeMatch({ matchStatus: 'no_match', matchedAds: [] }),
    );
    expect(result).toBe('inserted');
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('brreg-934349148') as any;
    expect(row.signal_type).toBe('change');
    expect(row.source).toBe('brreg_bankrupt');
    expect(row.company_name).toBe('2T4 BYGG AS');
  });

  it('inserts a growth signal from finn_jobs', () => {
    const signal = makeSignal({
      source: 'finn_jobs',
      externalId: 'finn-job-999888',
      title: 'Søker: Maskinfører — Veidekke ASA',
      companyName: 'Veidekke ASA',
      location: 'Oslo',
    });
    const result = upsertLead(
      db,
      signal,
      'growth',
      makeMatch({ matchStatus: 'no_match', matchedAds: [] }),
    );
    expect(result).toBe('inserted');
    const row = db
      .prepare('SELECT * FROM leads WHERE external_id = ?')
      .get('finn-job-999888') as any;
    expect(row.signal_type).toBe('growth');
    expect(row.source).toBe('finn_jobs');
    expect(row.company_name).toBe('Veidekke ASA');
    expect(row.location).toBe('Oslo');
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
