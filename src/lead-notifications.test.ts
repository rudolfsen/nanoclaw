import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initLeadDb } from './lead-scanner.js';
import { scoreLead, scoreTier } from './lead-scoring.js';

describe('Lead notification logic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initLeadDb(':memory:');
  });

  afterEach(() => db.close());

  it('identifies hot leads from recent scans', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at, contact_info, contact_name)
      VALUES ('finn_wanted', 'demand', 'test-1', 'Onskes: Volvo EC220', 'Test',
      'has_match', '[]', 'new', ?, ?, '99887766', 'Ola')`,
    ).run(now, now);

    const rows = db
      .prepare("SELECT * FROM leads WHERE created_at >= ? AND status = 'new'")
      .all(now) as import('./lead-scoring.js').LeadRow[];

    const hot = rows.filter((r) => scoreLead(r) >= 60);
    expect(hot).toHaveLength(1);
    expect(scoreTier(scoreLead(hot[0]))).toBe('hot');
  });

  it('does not flag cold leads', () => {
    const oldDate = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at)
      VALUES ('mascus', 'supply', 'test-2', 'Gammel maskin', 'Test',
      'no_match', '[]', 'new', ?, ?)`,
    ).run(oldDate, oldDate);

    const rows = db
      .prepare("SELECT * FROM leads WHERE status = 'new'")
      .all() as import('./lead-scoring.js').LeadRow[];
    const hot = rows.filter((r) => scoreLead(r) >= 60);
    expect(hot).toHaveLength(0);
  });
});
