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

describe('Weekly digest queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initLeadDb(':memory:');
  });

  afterEach(() => db.close());

  it('groups leads by source for digest sections', () => {
    const now = new Date().toISOString();

    // Bankruptcy lead
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      category, match_status, matched_ads, status, first_seen_at, created_at, company_name)
      VALUES ('brreg_bankrupt', 'change', 'brreg-b-1', 'Konkurs: Maskin AS', 'Test',
      'Anlegg', 'no_match', '[]', 'new', ?, ?, 'Maskin AS')`,
    ).run(now, now);

    // Demand match lead
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at, external_url)
      VALUES ('finn_wanted', 'demand', 'finn-w-1', 'Minigraver ønskes kjøpt', 'Test',
      'has_match', ?, 'new', ?, ?, 'https://www.finn.no/item/12345')`,
    ).run(
      JSON.stringify([
        { source: 'ats', id: 99, title: 'Cat 301.7', price: 350000 },
      ]),
      now,
      now,
    );

    // Finn wanted without match (should NOT appear in demand match section)
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at)
      VALUES ('finn_wanted', 'demand', 'finn-w-2', 'Gravemaskin ønskes', 'Test',
      'no_match', '[]', 'new', ?, ?)`,
    ).run(now, now);

    // Finn jobs lead
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at, company_name)
      VALUES ('finn_jobs', 'growth', 'finn-j-1', 'Søker: Maskinfører — Holthe Anlegg AS', 'Test',
      'no_match', '[]', 'new', ?, ?, 'Holthe Anlegg AS')`,
    ).run(now, now);

    // Old lead outside 7-day window (should NOT appear)
    const oldDate = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at)
      VALUES ('brreg_bankrupt', 'change', 'brreg-b-old', 'Konkurs: Gammel AS', 'Old',
      'no_match', '[]', 'new', ?, ?)`,
    ).run(oldDate, oldDate);

    // Query leads from last 7 days
    const weekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const weekLeads = db
      .prepare('SELECT * FROM leads WHERE created_at >= ?')
      .all(weekAgo) as Array<{
      source: string;
      match_status: string;
    }>;

    expect(weekLeads).toHaveLength(4);

    const bankruptcies = weekLeads.filter(
      (l) => l.source === 'brreg_bankrupt',
    );
    expect(bankruptcies).toHaveLength(1);

    const demandMatches = weekLeads.filter(
      (l) => l.source === 'finn_wanted' && l.match_status === 'has_match',
    );
    expect(demandMatches).toHaveLength(1);

    const hiring = weekLeads.filter((l) => l.source === 'finn_jobs');
    expect(hiring).toHaveLength(1);
  });

  it('handles empty week with no leads', () => {
    const weekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const weekLeads = db
      .prepare('SELECT * FROM leads WHERE created_at >= ?')
      .all(weekAgo);
    expect(weekLeads).toHaveLength(0);
  });

  it('groups hiring leads by company for multi-hire detection', () => {
    const now = new Date().toISOString();

    // Two jobs from same company
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at, company_name)
      VALUES ('finn_jobs', 'growth', 'finn-j-10', 'Søker: Maskinfører — Holthe Anlegg AS', 'Test',
      'no_match', '[]', 'new', ?, ?, 'Holthe Anlegg AS')`,
    ).run(now, now);

    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at, company_name)
      VALUES ('finn_jobs', 'growth', 'finn-j-11', 'Søker: Gravemaskinfører — Holthe Anlegg AS', 'Test',
      'no_match', '[]', 'new', ?, ?, 'Holthe Anlegg AS')`,
    ).run(now, now);

    // One job from another company
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, first_seen_at, created_at, company_name)
      VALUES ('finn_jobs', 'growth', 'finn-j-12', 'Søker: Kranfører — AF Gruppen', 'Test',
      'no_match', '[]', 'new', ?, ?, 'AF Gruppen')`,
    ).run(now, now);

    const weekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const hiring = db
      .prepare(
        "SELECT * FROM leads WHERE created_at >= ? AND source = 'finn_jobs'",
      )
      .all(weekAgo) as Array<{ company_name: string }>;

    // Group by company
    const byCompany = new Map<string, typeof hiring>();
    for (const lead of hiring) {
      const key = lead.company_name || 'Ukjent';
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key)!.push(lead);
    }

    expect(byCompany.get('Holthe Anlegg AS')).toHaveLength(2);
    expect(byCompany.get('AF Gruppen')).toHaveLength(1);
  });
});
