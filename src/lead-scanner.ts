/**
 * Lead Intelligence Scanner
 * Scans external marketplaces for buy signals and price opportunities.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { RawSignal, MatchResult } from './lead-sources/types.js';
import { scrapeFinnWanted } from './lead-sources/finn-wanted.js';
import { scrapeMascus } from './lead-sources/mascus.js';
import { scrapeMachineryline } from './lead-sources/machineryline.js';
import { matchSignal } from './lead-sources/matcher.js';

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

async function scanAllSources(db: Database.Database): Promise<void> {
  console.log('[lead-scanner] Starting scan...');
  let totalNew = 0;

  // Finn "ønskes kjøpt" — demand signals
  try {
    const finnSignals = await scrapeFinnWanted();
    for (const signal of finnSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'demand', match)) totalNew++;
    }
    console.log(
      `[lead-scanner] Finn: ${finnSignals.length} found, ${totalNew} new`,
    );
  } catch (err) {
    console.error(`[lead-scanner] Finn scan failed: ${(err as Error).message}`);
  }

  // Mascus — supply/price signals
  const beforeMascus = totalNew;
  try {
    const mascusSignals = await scrapeMascus();
    for (const signal of mascusSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'supply', match)) totalNew++;
    }
    console.log(
      `[lead-scanner] Mascus: ${mascusSignals.length} found, ${totalNew - beforeMascus} new`,
    );
  } catch (err) {
    console.error(
      `[lead-scanner] Mascus scan failed: ${(err as Error).message}`,
    );
  }

  // Machineryline — supply/price signals
  const beforeMl = totalNew;
  try {
    const mlSignals = await scrapeMachineryline();
    for (const signal of mlSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'supply', match)) totalNew++;
    }
    console.log(
      `[lead-scanner] Machineryline: ${mlSignals.length} found, ${totalNew - beforeMl} new`,
    );
  } catch (err) {
    console.error(
      `[lead-scanner] Machineryline scan failed: ${(err as Error).message}`,
    );
  }

  console.log(`[lead-scanner] Scan complete: ${totalNew} new leads total`);
}

export async function runScanLoop(): Promise<void> {
  const dbPath = resolveLeadDbPath();
  const db = initLeadDb(dbPath);
  console.log(`[lead-scanner] Lead DB at ${dbPath}`);

  // Initial scan
  await scanAllSources(db);

  // Re-scan every 30 minutes
  setInterval(
    async () => {
      try {
        await scanAllSources(db);
      } catch (err) {
        console.error(`[lead-scanner] Scan error: ${(err as Error).message}`);
      }
    },
    30 * 60 * 1000,
  );
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  runScanLoop().catch((err) => {
    console.error('[lead-scanner] Fatal error:', err);
    process.exit(1);
  });
}
