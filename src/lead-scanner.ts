/**
 * Lead Intelligence Scanner
 * Scans external marketplaces for buy signals and price opportunities.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { RawSignal, MatchResult } from './lead-sources/types.js';

export function resolveLeadDbPath(): string {
  const dir = process.env.LEAD_DB_DIR || path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'leads.sqlite');
}

export function initLeadDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      external_id TEXT UNIQUE,
      external_url TEXT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT,
      price REAL,
      contact_name TEXT,
      contact_info TEXT,
      published_at TEXT,
      match_status TEXT DEFAULT 'no_match',
      matched_ads TEXT,
      price_diff_pct REAL,
      status TEXT DEFAULT 'new',
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS leads_fts USING fts5(
      title, description,
      content='leads',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS leads_ai AFTER INSERT ON leads BEGIN
      INSERT INTO leads_fts(rowid, title, description)
      VALUES (new.id, new.title, new.description);
    END;

    CREATE TRIGGER IF NOT EXISTS leads_ad AFTER DELETE ON leads BEGIN
      INSERT INTO leads_fts(leads_fts, rowid, title, description)
      VALUES ('delete', old.id, old.title, old.description);
    END;

    CREATE TRIGGER IF NOT EXISTS leads_au AFTER UPDATE ON leads BEGIN
      INSERT INTO leads_fts(leads_fts, rowid, title, description)
      VALUES ('delete', old.id, old.title, old.description);
      INSERT INTO leads_fts(rowid, title, description)
      VALUES (new.id, new.title, new.description);
    END;
  `);

  return db;
}

export function insertLead(
  db: Database.Database,
  signal: RawSignal,
  signalType: 'demand' | 'supply',
  match: MatchResult,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO leads
      (source, signal_type, external_id, external_url, title, description,
       category, price, contact_name, contact_info, published_at,
       match_status, matched_ads, price_diff_pct, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    )
    .run(
      signal.source,
      signalType,
      signal.externalId,
      signal.externalUrl,
      signal.title,
      signal.description,
      signal.category,
      signal.price,
      signal.contactName,
      signal.contactInfo,
      signal.publishedAt,
      match.matchStatus,
      JSON.stringify(match.matchedAds),
      match.priceDiffPct,
      new Date().toISOString(),
    );
  return result.changes > 0; // false when duplicate external_id was ignored
}
