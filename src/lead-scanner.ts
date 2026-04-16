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
import { scanDoffin } from './lead-sources/doffin.js';
import { scanBrreg } from './lead-sources/brreg.js';
import { scanFinnJobs } from './lead-sources/finn-jobs.js';
import {
  matchSignal,
  openCacheDbs,
  closeCacheDbs,
} from './lead-sources/matcher.js';
import { checkNewMachinesForMatches } from './proactive-matcher.js';

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
      first_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lead_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      old_price REAL,
      new_price REAL,
      changed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_lead
      ON lead_price_history(lead_id);

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

  // Migration: add first_seen_at column to existing databases
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN first_seen_at TEXT`);
    // Backfill: set first_seen_at = created_at for existing rows
    db.exec(
      `UPDATE leads SET first_seen_at = created_at WHERE first_seen_at IS NULL`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Migration: create lead_price_history if upgrading from Phase 1
  // (handled by CREATE TABLE IF NOT EXISTS above)

  // Phase 3 migration: add company metadata columns
  const migrationColumns = [
    { name: 'company_name', type: 'TEXT' },
    { name: 'company_orgnr', type: 'TEXT' },
    { name: 'nace_code', type: 'TEXT' },
    { name: 'location', type: 'TEXT' },
  ];

  for (const col of migrationColumns) {
    try {
      db.exec(`ALTER TABLE leads ADD COLUMN ${col.name} ${col.type}`);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  return db;
}

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

export function upsertLead(
  db: Database.Database,
  signal: RawSignal,
  signalType: 'demand' | 'supply' | 'growth' | 'change',
  match: MatchResult,
): UpsertResult {
  const now = new Date().toISOString();

  // Check if lead already exists
  const existing = db
    .prepare('SELECT id, price FROM leads WHERE external_id = ?')
    .get(signal.externalId) as { id: number; price: number | null } | undefined;

  if (!existing) {
    // New lead — insert
    db.prepare(
      `INSERT INTO leads
        (source, signal_type, external_id, external_url, title, description,
         category, price, contact_name, contact_info, published_at,
         match_status, matched_ads, price_diff_pct, status, first_seen_at, created_at,
         company_name, company_orgnr, nace_code, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
    ).run(
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
      now,
      now,
      signal.companyName ?? null,
      signal.companyOrgnr ?? null,
      signal.naceCode ?? null,
      signal.location ?? null,
    );
    return 'inserted';
  }

  // Existing lead — check if price changed
  const oldPrice = existing.price;
  const newPrice = signal.price;
  const priceChanged =
    oldPrice !== newPrice && !(oldPrice === null && newPrice === null);

  if (priceChanged) {
    // Record price change
    db.prepare(
      `INSERT INTO lead_price_history (lead_id, old_price, new_price, changed_at)
       VALUES (?, ?, ?, ?)`,
    ).run(existing.id, oldPrice, newPrice, now);

    // Update the lead with new price and re-matched data
    db.prepare(
      `UPDATE leads SET
        price = ?, match_status = ?, matched_ads = ?, price_diff_pct = ?,
        title = ?, description = ?, contact_name = ?, contact_info = ?
       WHERE id = ?`,
    ).run(
      newPrice,
      match.matchStatus,
      JSON.stringify(match.matchedAds),
      match.priceDiffPct,
      signal.title,
      signal.description,
      signal.contactName,
      signal.contactInfo,
      existing.id,
    );
    return 'updated';
  }

  return 'unchanged';
}

async function scanAllSources(db: Database.Database): Promise<void> {
  console.log('[lead-scanner] Starting scan...');
  let totalNew = 0;
  let totalUpdated = 0;

  const cacheDbs = openCacheDbs();
  try {
    // Finn "ønskes kjøpt" — demand signals
    try {
      const finnSignals = await scrapeFinnWanted();
      let finnNew = 0;
      let finnUpdated = 0;
      for (const signal of finnSignals) {
        const match = matchSignal(signal, cacheDbs);
        const result = upsertLead(db, signal, 'demand', match);
        if (result === 'inserted') finnNew++;
        if (result === 'updated') finnUpdated++;
      }
      totalNew += finnNew;
      totalUpdated += finnUpdated;
      console.log(
        `[lead-scanner] Finn: ${finnSignals.length} found, ${finnNew} new, ${finnUpdated} updated`,
      );
    } catch (err) {
      console.error(
        `[lead-scanner] Finn scan failed: ${(err as Error).message}`,
      );
    }

    // Mascus — supply/price signals
    try {
      const mascusSignals = await scrapeMascus();
      let mascusNew = 0;
      let mascusUpdated = 0;
      for (const signal of mascusSignals) {
        const match = matchSignal(signal, cacheDbs);
        const result = upsertLead(db, signal, 'supply', match);
        if (result === 'inserted') mascusNew++;
        if (result === 'updated') mascusUpdated++;
      }
      totalNew += mascusNew;
      totalUpdated += mascusUpdated;
      console.log(
        `[lead-scanner] Mascus: ${mascusSignals.length} found, ${mascusNew} new, ${mascusUpdated} updated`,
      );
    } catch (err) {
      console.error(
        `[lead-scanner] Mascus scan failed: ${(err as Error).message}`,
      );
    }

    // Machineryline — supply/price signals
    try {
      const mlSignals = await scrapeMachineryline();
      let mlNew = 0;
      let mlUpdated = 0;
      for (const signal of mlSignals) {
        const match = matchSignal(signal, cacheDbs);
        const result = upsertLead(db, signal, 'supply', match);
        if (result === 'inserted') mlNew++;
        if (result === 'updated') mlUpdated++;
      }
      totalNew += mlNew;
      totalUpdated += mlUpdated;
      console.log(
        `[lead-scanner] Machineryline: ${mlSignals.length} found, ${mlNew} new, ${mlUpdated} updated`,
      );
    } catch (err) {
      console.error(
        `[lead-scanner] Machineryline scan failed: ${(err as Error).message}`,
      );
    }

    // --- Phase 3 sources ---

    // Doffin — public procurement contracts (growth signals)
    try {
      const doffinSignals = await scanDoffin();
      let doffinNew = 0;
      let doffinUpdated = 0;
      for (const signal of doffinSignals) {
        const match = matchSignal(signal, cacheDbs);
        const result = upsertLead(db, signal, 'growth', match);
        if (result === 'inserted') doffinNew++;
        if (result === 'updated') doffinUpdated++;
      }
      totalNew += doffinNew;
      totalUpdated += doffinUpdated;
      console.log(
        `[lead-scanner] Doffin: ${doffinSignals.length} found, ${doffinNew} new, ${doffinUpdated} updated`,
      );
    } catch (err) {
      console.error(
        `[lead-scanner] Doffin scan failed: ${(err as Error).message}`,
      );
    }

    // Bronnøysund — new registrations (growth) and bankruptcies (change)
    try {
      const brregSignals = await scanBrreg();
      let brregNew = 0;
      let brregUpdated = 0;
      for (const signal of brregSignals) {
        const signalType =
          signal.source === 'brreg_bankrupt' ? 'change' : 'growth';
        const match = matchSignal(signal, cacheDbs);
        const result = upsertLead(db, signal, signalType, match);
        if (result === 'inserted') brregNew++;
        if (result === 'updated') brregUpdated++;
      }
      totalNew += brregNew;
      totalUpdated += brregUpdated;
      console.log(
        `[lead-scanner] Brreg: ${brregSignals.length} found, ${brregNew} new, ${brregUpdated} updated`,
      );
    } catch (err) {
      console.error(
        `[lead-scanner] Brreg scan failed: ${(err as Error).message}`,
      );
    }

    // Finn jobs — operator/driver postings (growth signals)
    try {
      const finnJobSignals = await scanFinnJobs();
      let finnJobsNew = 0;
      let finnJobsUpdated = 0;
      for (const signal of finnJobSignals) {
        const match = matchSignal(signal, cacheDbs);
        const result = upsertLead(db, signal, 'growth', match);
        if (result === 'inserted') finnJobsNew++;
        if (result === 'updated') finnJobsUpdated++;
      }
      totalNew += finnJobsNew;
      totalUpdated += finnJobsUpdated;
      console.log(
        `[lead-scanner] Finn jobs: ${finnJobSignals.length} found, ${finnJobsNew} new, ${finnJobsUpdated} updated`,
      );
    } catch (err) {
      console.error(
        `[lead-scanner] Finn jobs scan failed: ${(err as Error).message}`,
      );
    }
  } finally {
    closeCacheDbs(cacheDbs);
  }

  // Proactive matching: check if new machines match previous customer inquiries
  try {
    checkNewMachinesForMatches(db);
  } catch (err) {
    console.error(
      `[lead-scanner] Proactive matching failed: ${(err as Error).message}`,
    );
  }

  console.log(
    `[lead-scanner] Scan complete: ${totalNew} new, ${totalUpdated} updated`,
  );
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
