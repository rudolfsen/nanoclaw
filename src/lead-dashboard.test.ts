import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initLeadDb } from './lead-scanner.js';
import { scoreLead, scoreTier } from './lead-scoring.js';

// Test helpers
function insertTestLead(
  db: Database.Database,
  overrides: Record<string, unknown> = {},
) {
  const defaults = {
    source: 'finn_wanted',
    signal_type: 'demand',
    external_id: `test-${Math.random()}`,
    external_url: 'https://finn.no/123',
    title: 'Onskes kjopt: Volvo gravemaskin',
    description: 'Ser etter brukt gravemaskin',
    category: 'gravemaskin',
    price: null,
    contact_name: 'Test Person',
    contact_info: '99887766',
    published_at: '2026-04-14T00:00:00Z',
    match_status: 'has_match',
    matched_ads: '[]',
    price_diff_pct: null,
    status: 'new',
    first_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO leads (source, signal_type, external_id, external_url,
    title, description, category, price, contact_name, contact_info, published_at,
    match_status, matched_ads, price_diff_pct, status, first_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    defaults.source,
    defaults.signal_type,
    defaults.external_id,
    defaults.external_url,
    defaults.title,
    defaults.description,
    defaults.category,
    defaults.price,
    defaults.contact_name,
    defaults.contact_info,
    defaults.published_at,
    defaults.match_status,
    defaults.matched_ads,
    defaults.price_diff_pct,
    defaults.status,
    defaults.first_seen_at,
    defaults.created_at,
  );
}

describe('Lead Dashboard API', () => {
  // Unit tests for the handler logic using in-memory DB.
  let db: Database.Database;

  beforeEach(() => {
    db = initLeadDb(':memory:');
    insertTestLead(db, {
      external_id: 'lead-1',
      signal_type: 'demand',
      match_status: 'has_match',
    });
    insertTestLead(db, {
      external_id: 'lead-2',
      signal_type: 'supply',
      match_status: 'price_opportunity',
      price_diff_pct: 25,
    });
    insertTestLead(db, {
      external_id: 'lead-3',
      signal_type: 'demand',
      match_status: 'no_match',
      status: 'contacted',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('queries leads with status filter', () => {
    const rows = db.prepare("SELECT * FROM leads WHERE status = 'new'").all();
    expect(rows).toHaveLength(2);
  });

  it('queries leads with source filter', () => {
    const rows = db
      .prepare("SELECT * FROM leads WHERE source = 'finn_wanted'")
      .all();
    expect(rows).toHaveLength(3);
  });

  it('updates lead status', () => {
    const result = db
      .prepare("UPDATE leads SET status = 'contacted' WHERE id = 1")
      .run();
    expect(result.changes).toBe(1);
    const row = db
      .prepare('SELECT status FROM leads WHERE id = 1')
      .get() as Record<string, unknown>;
    expect(row.status).toBe('contacted');
  });

  it('gets stats', () => {
    const total = (
      db.prepare('SELECT count(*) as n FROM leads').get() as { n: number }
    ).n;
    expect(total).toBe(3);
    const byType = db
      .prepare(
        'SELECT signal_type, count(*) as n FROM leads GROUP BY signal_type',
      )
      .all();
    expect(byType).toHaveLength(2);
  });

  it('computes scores for leads', () => {
    const rows = db
      .prepare('SELECT * FROM leads')
      .all() as import('./lead-scoring.js').LeadRow[];
    for (const row of rows) {
      const score = scoreLead(row);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      const tier = scoreTier(score);
      expect(['hot', 'warm', 'cold']).toContain(tier);
    }
  });
});
