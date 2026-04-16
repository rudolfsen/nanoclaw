/**
 * Proactive Matching — Notify when new machines match previous customer inquiries.
 *
 * When the lead scanner runs (every 30 min), checks ATS/LBS caches for
 * recently synced machines and matches them against chat_contacts and
 * Finn "onskes kjopt" leads. If a match is found and hasn't been notified
 * before, an email notification is queued via IPC.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

// --- Stop words & keyword sets (mirrored from matcher.ts) ---

const STOP_WORDS = new Set([
  'onskes',
  'kjopt',
  'selges',
  'til',
  'salgs',
  'brukt',
  'med',
  'for',
  'som',
  'har',
  'kan',
  'fra',
  'eller',
  'evt',
  'etter',
  'pris',
  'god',
  'stand',
  'nice',
  'fin',
  'liten',
  'stor',
  'gammel',
  'ny',
  'nye',
  'bra',
  'rimelig',
  'billig',
  'den',
  'det',
  'denne',
  'per',
  'stk',
  'stykk',
  'type',
  'modell',
  'merke',
  'uten',
  'noe',
  'noen',
  'alle',
  'flere',
]);

const BRANDS = new Set([
  'volvo',
  'caterpillar',
  'cat',
  'komatsu',
  'hitachi',
  'liebherr',
  'jcb',
  'kubota',
  'takeuchi',
  'doosan',
  'hyundai',
  'kobelco',
  'case',
  'john',
  'deere',
  'massey',
  'ferguson',
  'fendt',
  'claas',
  'valtra',
  'new',
  'holland',
  'kverneland',
  'kuhn',
  'igland',
  'maur',
  'scania',
  'man',
  'mercedes',
  'daf',
  'iveco',
  'renault',
]);

const EQUIPMENT_TYPES = new Set([
  'gravemaskin',
  'beltegraver',
  'hjullaster',
  'minigraver',
  'dumper',
  'dozer',
  'traktor',
  'tresker',
  'skurtresker',
  'rundballepresse',
  'slamaskin',
  'plog',
  'harv',
  'samaskin',
  'frontlaster',
  'telehandler',
  'lastebil',
  'trekkvogn',
  'tippbil',
  'semitrailer',
  'tilhenger',
  'hjulgraver',
  'graver',
  'laster',
  'kran',
  'kranbil',
  'hogstmaskin',
  'lassbaerer',
]);

// --- Types ---

export interface NewMachine {
  id: string;
  source: 'ats' | 'lbs';
  title: string;
  price: number | null;
  url: string;
}

export interface MatchedContact {
  contactType: 'chat' | 'finn';
  contactId: string;
  name: string;
  interest: string;
  phone: string | null;
  externalUrl: string | null;
  daysSince: number;
}

// --- Table init ---

export function initMatchedNotifications(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS matched_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      machine_source TEXT NOT NULL,
      contact_type TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      notified_at TEXT NOT NULL,
      UNIQUE(machine_id, machine_source, contact_type, contact_id)
    )
  `);
}

// --- Keyword extraction ---

export function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\wæøåÆØÅ\s]/g, '')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 2 &&
        !STOP_WORDS.has(w) &&
        (BRANDS.has(w) || EQUIPMENT_TYPES.has(w) || w.length > 3),
    );
}

// --- Cache DB helpers ---

function openCacheDb(filename: string): Database.Database | null {
  const dbPath = path.join(
    process.env.ATS_CACHE_DIR || path.resolve(process.cwd(), 'data'),
    filename,
  );
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

function getNewMachinesFromAts(
  db: Database.Database,
): NewMachine[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, title_no as title, price
         FROM ads
         WHERE synced_at > datetime('now', '-35 minutes')
           AND status = 'published'`,
      )
      .all() as { id: string; title: string; price: number | null }[];

    return rows.map((r) => ({
      id: String(r.id),
      source: 'ats' as const,
      title: r.title || '',
      price: r.price,
      url: `https://ats.no/no/gjenstand/${r.id}`,
    }));
  } catch {
    return [];
  }
}

function getNewMachinesFromLbs(
  db: Database.Database,
): NewMachine[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, title, price
         FROM ads
         WHERE synced_at > datetime('now', '-35 minutes')
           AND status = 'published'`,
      )
      .all() as { id: string; title: string; price: number | null }[];

    return rows.map((r) => ({
      id: String(r.id),
      source: 'lbs' as const,
      title: r.title || '',
      price: r.price,
      url: `https://landbrukssalg.no/${r.id}`,
    }));
  } catch {
    return [];
  }
}

// --- Matching logic ---

function findMatchingContacts(
  leadsDb: Database.Database,
  keywords: string[],
): MatchedContact[] {
  const matches: MatchedContact[] = [];
  if (keywords.length === 0) return matches;

  // 1. Search chat_contacts
  try {
    // Build LIKE conditions — require at least one brand/type keyword to match
    const brandTypeKeywords = keywords.filter(
      (w) => BRANDS.has(w) || EQUIPMENT_TYPES.has(w),
    );
    const searchKeywords =
      brandTypeKeywords.length > 0 ? brandTypeKeywords : keywords.slice(0, 3);

    for (const keyword of searchKeywords) {
      const rows = leadsDb
        .prepare(
          `SELECT id, name, phone, email, interest, created_at
           FROM chat_contacts
           WHERE interest LIKE ?
             AND status != 'closed'
             AND created_at > datetime('now', '-30 days')`,
        )
        .all(`%${keyword}%`) as {
        id: number;
        name: string;
        phone: string | null;
        email: string | null;
        interest: string | null;
        created_at: string;
      }[];

      for (const row of rows) {
        // Avoid duplicates within the same search
        if (matches.some((m) => m.contactType === 'chat' && m.contactId === String(row.id))) {
          continue;
        }
        const daysSince = Math.floor(
          (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24),
        );
        matches.push({
          contactType: 'chat',
          contactId: String(row.id),
          name: row.name || 'Ukjent',
          interest: row.interest || '',
          phone: row.phone || null,
          externalUrl: null,
          daysSince,
        });
      }
    }
  } catch {
    // chat_contacts table may not exist
  }

  // 2. Search leads (finn_wanted demand signals)
  try {
    for (const keyword of keywords) {
      const rows = leadsDb
        .prepare(
          `SELECT id, title, contact_name, contact_info, external_url, created_at
           FROM leads
           WHERE source = 'finn_wanted'
             AND signal_type = 'demand'
             AND title LIKE ?
             AND created_at > datetime('now', '-30 days')`,
        )
        .all(`%${keyword}%`) as {
        id: number;
        title: string;
        contact_name: string | null;
        contact_info: string | null;
        external_url: string | null;
        created_at: string;
      }[];

      for (const row of rows) {
        if (matches.some((m) => m.contactType === 'finn' && m.contactId === String(row.id))) {
          continue;
        }
        const daysSince = Math.floor(
          (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24),
        );
        matches.push({
          contactType: 'finn',
          contactId: String(row.id),
          name: row.contact_name || 'Finn-annonse',
          interest: row.title || '',
          phone: row.contact_info || null,
          externalUrl: row.external_url || null,
          daysSince,
        });
      }
    }
  } catch {
    // leads table may not exist
  }

  return matches;
}

// --- Deduplication ---

function filterAlreadyNotified(
  leadsDb: Database.Database,
  machineId: string,
  machineSource: string,
  matches: MatchedContact[],
): MatchedContact[] {
  return matches.filter((m) => {
    const existing = leadsDb
      .prepare(
        `SELECT 1 FROM matched_notifications
         WHERE machine_id = ? AND machine_source = ? AND contact_type = ? AND contact_id = ?`,
      )
      .get(machineId, machineSource, m.contactType, m.contactId);
    return !existing;
  });
}

function recordNotification(
  leadsDb: Database.Database,
  machineId: string,
  machineSource: string,
  match: MatchedContact,
): void {
  leadsDb
    .prepare(
      `INSERT OR IGNORE INTO matched_notifications
       (machine_id, machine_source, contact_type, contact_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(machineId, machineSource, match.contactType, match.contactId, new Date().toISOString());
}

// --- Email formatting ---

export function formatMatchEmail(
  machine: NewMachine,
  matches: MatchedContact[],
): { subject: string; body: string } {
  const priceStr = machine.price
    ? `${machine.price.toLocaleString('nb-NO')} kr`
    : 'Pris ikke oppgitt';

  const matchLines = matches
    .map((m, i) => {
      const sourceLabel = m.contactType === 'chat' ? 'chat' : 'Finn';
      const lines = [
        `${i + 1}. ${m.name} (${sourceLabel}, ${m.daysSince} dager siden)`,
        `   Spurte om: "${m.interest}"`,
      ];
      if (m.phone) {
        lines.push(`   Telefon: ${m.phone}`);
      }
      if (m.externalUrl) {
        lines.push(`   Lenke: ${m.externalUrl}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  const body = `Ny maskin matcher en tidligere henvendelse!

Maskin: ${machine.title}
Pris: ${priceStr}
Lenke: ${machine.url}

Matchede henvendelser:
${matchLines}`;

  const subject = `Proaktiv match: ${machine.title}`;

  return { subject, body };
}

// --- IPC email helper ---

function writeIpcEmail(subject: string, body: string): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', 'ats-email', 'tasks');
  fs.mkdirSync(ipcDir, { recursive: true });

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const filename = `${timestamp}-${random}.json`;
  const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL || 'bjornar@lbs.no';

  fs.writeFileSync(
    path.join(ipcDir, filename),
    JSON.stringify(
      {
        type: 'save_gmail_draft',
        to: notifyEmail,
        subject,
        body,
      },
      null,
      2,
    ),
  );
}

// --- Main entry point ---

export function checkNewMachinesForMatches(leadsDb: Database.Database): void {
  initMatchedNotifications(leadsDb);

  // Collect new machines from both caches
  const newMachines: NewMachine[] = [];

  const atsDb = openCacheDb('ats-feed-cache.sqlite');
  if (atsDb) {
    try {
      newMachines.push(...getNewMachinesFromAts(atsDb));
    } finally {
      atsDb.close();
    }
  }

  const lbsDb = openCacheDb('lbs-feed-cache.sqlite');
  if (lbsDb) {
    try {
      newMachines.push(...getNewMachinesFromLbs(lbsDb));
    } finally {
      lbsDb.close();
    }
  }

  if (newMachines.length === 0) {
    return;
  }

  console.log(
    `[proactive-matcher] Found ${newMachines.length} new machines, checking for matches...`,
  );

  let totalMatches = 0;

  for (const machine of newMachines) {
    const keywords = extractKeywords(machine.title);
    if (keywords.length === 0) continue;

    const allMatches = findMatchingContacts(leadsDb, keywords);
    const newMatches = filterAlreadyNotified(
      leadsDb,
      machine.id,
      machine.source,
      allMatches,
    );

    if (newMatches.length === 0) continue;

    // Record notifications and send email
    for (const match of newMatches) {
      recordNotification(leadsDb, machine.id, machine.source, match);
    }

    const { subject, body } = formatMatchEmail(machine, newMatches);
    writeIpcEmail(subject, body);
    totalMatches += newMatches.length;

    console.log(
      `[proactive-matcher] ${machine.title} matched ${newMatches.length} contact(s)`,
    );
  }

  if (totalMatches > 0) {
    console.log(
      `[proactive-matcher] Sent ${totalMatches} match notification(s)`,
    );
  }
}
