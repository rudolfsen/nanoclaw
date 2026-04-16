import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  initMatchedNotifications,
  extractKeywords,
  formatMatchEmail,
  NewMachine,
  MatchedContact,
} from './proactive-matcher.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create chat_contacts table (as in chat-api.ts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      interest TEXT,
      site TEXT,
      conversation TEXT,
      machines_shown TEXT,
      status TEXT DEFAULT 'new',
      created_at TEXT NOT NULL
    )
  `);

  // Create leads table (as in lead-scanner.ts)
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
    )
  `);

  initMatchedNotifications(db);
  return db;
}

describe('initMatchedNotifications', () => {
  it('creates matched_notifications table', () => {
    const db = new Database(':memory:');
    initMatchedNotifications(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('matched_notifications');

    // Verify columns
    const cols = db
      .prepare('PRAGMA table_info(matched_notifications)')
      .all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('machine_id');
    expect(colNames).toContain('machine_source');
    expect(colNames).toContain('contact_type');
    expect(colNames).toContain('contact_id');
    expect(colNames).toContain('notified_at');

    db.close();
  });

  it('is idempotent — can be called multiple times', () => {
    const db = new Database(':memory:');
    initMatchedNotifications(db);
    initMatchedNotifications(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain('matched_notifications');
    db.close();
  });
});

describe('deduplication', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('does not allow duplicate machine+contact notifications', () => {
    const now = new Date().toISOString();

    // Insert first notification
    db.prepare(
      `INSERT INTO matched_notifications (machine_id, machine_source, contact_type, contact_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('12345', 'ats', 'chat', '1', now);

    // Attempt duplicate — should be ignored due to UNIQUE constraint
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO matched_notifications (machine_id, machine_source, contact_type, contact_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run('12345', 'ats', 'chat', '1', now);

    const count = db
      .prepare('SELECT count(*) as c FROM matched_notifications')
      .get() as any;
    expect(count.c).toBe(1);
  });

  it('allows same machine with different contact', () => {
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO matched_notifications (machine_id, machine_source, contact_type, contact_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('12345', 'ats', 'chat', '1', now);

    db.prepare(
      `INSERT INTO matched_notifications (machine_id, machine_source, contact_type, contact_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('12345', 'ats', 'finn', '99', now);

    const count = db
      .prepare('SELECT count(*) as c FROM matched_notifications')
      .get() as any;
    expect(count.c).toBe(2);
  });

  it('allows same contact with different machine', () => {
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO matched_notifications (machine_id, machine_source, contact_type, contact_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('12345', 'ats', 'chat', '1', now);

    db.prepare(
      `INSERT INTO matched_notifications (machine_id, machine_source, contact_type, contact_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('67890', 'lbs', 'chat', '1', now);

    const count = db
      .prepare('SELECT count(*) as c FROM matched_notifications')
      .get() as any;
    expect(count.c).toBe(2);
  });
});

describe('extractKeywords', () => {
  it('extracts brand and equipment type keywords', () => {
    const keywords = extractKeywords('Volvo EC220 beltegraver 2018');
    expect(keywords).toContain('volvo');
    expect(keywords).toContain('beltegraver');
    expect(keywords).toContain('ec220');
  });

  it('filters out stop words', () => {
    const keywords = extractKeywords('Selges brukt Volvo til god pris');
    expect(keywords).not.toContain('selges');
    expect(keywords).not.toContain('brukt');
    expect(keywords).not.toContain('god');
    expect(keywords).not.toContain('pris');
    expect(keywords).toContain('volvo');
  });

  it('filters out short non-brand words', () => {
    const keywords = extractKeywords('En ny og fin maskin');
    // 'en', 'og' are <= 2 chars, 'ny', 'fin' are stop words, 'maskin' > 3 chars
    expect(keywords).toContain('maskin');
    expect(keywords).not.toContain('en');
    expect(keywords).not.toContain('og');
  });
});

describe('matching against contacts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('finds chat contact when interest matches machine title keyword', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO chat_contacts (name, phone, email, interest, site, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('Per Hansen', '99887766', 'per@test.no', 'Volvo gravemaskin', 'ats', 'new', now);

    // Simulate matching: search for 'volvo' in chat_contacts.interest
    const rows = db
      .prepare(
        `SELECT id, name, phone, interest, created_at FROM chat_contacts
         WHERE interest LIKE ? AND status != 'closed'
         AND created_at > datetime('now', '-30 days')`,
      )
      .all('%volvo%') as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Per Hansen');
    expect(rows[0].phone).toBe('99887766');
  });

  it('finds finn_wanted lead when title matches machine keyword', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO leads (source, signal_type, external_id, external_url, title, description, status, first_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'finn_wanted',
      'demand',
      'finn-123',
      'https://finn.no/item/123',
      'Gravemaskin Volvo onskes kjopt',
      'Ser etter brukt Volvo gravemaskin',
      'new',
      now,
      now,
    );

    const rows = db
      .prepare(
        `SELECT id, title, contact_name, contact_info, external_url, created_at
         FROM leads
         WHERE source = 'finn_wanted' AND signal_type = 'demand'
         AND title LIKE ?
         AND created_at > datetime('now', '-30 days')`,
      )
      .all('%volvo%') as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Gravemaskin Volvo onskes kjopt');
  });

  it('does not match closed contacts', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO chat_contacts (name, phone, email, interest, site, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('Closed Person', '11111111', null, 'Volvo traktor', 'ats', 'closed', now);

    const rows = db
      .prepare(
        `SELECT id FROM chat_contacts
         WHERE interest LIKE ? AND status != 'closed'
         AND created_at > datetime('now', '-30 days')`,
      )
      .all('%volvo%') as any[];

    expect(rows).toHaveLength(0);
  });
});

describe('formatMatchEmail', () => {
  it('formats email with machine and matched contacts', () => {
    const machine: NewMachine = {
      id: '21771',
      source: 'ats',
      title: 'Volvo EC220E beltegraver (2018)',
      price: 1290000,
      url: 'https://ats.no/no/gjenstand/21771',
    };

    const matches: MatchedContact[] = [
      {
        contactType: 'chat',
        contactId: '1',
        name: 'Per Hansen',
        interest: 'Volvo gravemaskin',
        phone: '99887766',
        externalUrl: null,
        daysSince: 3,
      },
      {
        contactType: 'finn',
        contactId: '99',
        name: 'Finn-annonse',
        interest: 'Gravemaskin Volvo onskes kjopt',
        phone: null,
        externalUrl: 'https://finn.no/item/459123',
        daysSince: 5,
      },
    ];

    const { subject, body } = formatMatchEmail(machine, matches);

    expect(subject).toContain('Volvo EC220E');
    expect(body).toContain('Volvo EC220E beltegraver (2018)');
    expect(body).toContain('1\u00a0290\u00a0000 kr'); // nb-NO locale formatting
    expect(body).toContain('https://ats.no/no/gjenstand/21771');
    expect(body).toContain('Per Hansen');
    expect(body).toContain('99887766');
    expect(body).toContain('Volvo gravemaskin');
    expect(body).toContain('https://finn.no/item/459123');
  });

  it('handles machine with no price', () => {
    const machine: NewMachine = {
      id: '100',
      source: 'lbs',
      title: 'Kverneland plog',
      price: null,
      url: 'https://landbrukssalg.no/100',
    };

    const matches: MatchedContact[] = [
      {
        contactType: 'chat',
        contactId: '5',
        name: 'Ola',
        interest: 'Kverneland plog',
        phone: null,
        externalUrl: null,
        daysSince: 1,
      },
    ];

    const { body } = formatMatchEmail(machine, matches);
    expect(body).toContain('Pris ikke oppgitt');
  });
});
