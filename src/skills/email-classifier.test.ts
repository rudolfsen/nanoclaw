import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { classifyAndStore, isImportant } from './email-classifier';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE categorized_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_uid TEXT NOT NULL,
      source TEXT NOT NULL,
      sender TEXT,
      subject TEXT,
      category TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(email_uid, source)
    )
  `);
  db.exec(`
    CREATE TABLE email_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(sender, category)
    )
  `);
  return db;
}

describe('classifyAndStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('stores classification in categorized_emails table (noreply@shopify.com → annet)', () => {
    const email = {
      uid: 'msg-001',
      source: 'gmail' as const,
      from: 'noreply@shopify.com',
      subject: 'Your account has been updated',
      body: 'We made some changes to your account settings.',
    };

    const result = classifyAndStore(db, email);

    // noreply@shopify.com is an automated sender with no receipt/newsletter/reklame
    // signals, so the sorter returns annet (needsAI: true)
    expect(result.category).toBe('annet');

    const row = db
      .prepare('SELECT * FROM categorized_emails WHERE email_uid = ?')
      .get('msg-001') as any;

    expect(row).toBeDefined();
    expect(row.email_uid).toBe('msg-001');
    expect(row.source).toBe('gmail');
    expect(row.sender).toBe('noreply@shopify.com');
    expect(row.subject).toBe('Your account has been updated');
    expect(row.category).toBe('annet');
  });

  it('returns viktig for personal emails (kollega@firma.no)', () => {
    const email = {
      uid: 'msg-002',
      source: 'outlook' as const,
      from: 'kollega@firma.no',
      subject: 'Møte i morgen?',
      body: 'Har du tid til et kort møte i morgen formiddag?',
    };

    const result = classifyAndStore(db, email);

    expect(result.category).toBe('viktig');

    const row = db
      .prepare('SELECT category FROM categorized_emails WHERE email_uid = ?')
      .get('msg-002') as any;

    expect(row.category).toBe('viktig');
  });

  it('does not insert duplicate when called twice with same uid (INSERT OR IGNORE)', () => {
    const email = {
      uid: 'msg-003',
      source: 'gmail' as const,
      from: 'noreply@shopify.com',
      subject: 'Duplicate test',
      body: 'Body text.',
    };

    classifyAndStore(db, email);
    classifyAndStore(db, email);

    const rows = db
      .prepare('SELECT * FROM categorized_emails WHERE email_uid = ?')
      .all('msg-003');

    expect(rows).toHaveLength(1);
  });
});

describe('isImportant', () => {
  it('returns true for viktig', () => {
    expect(isImportant('viktig')).toBe(true);
  });

  it('returns true for handling_kreves', () => {
    expect(isImportant('handling_kreves')).toBe(true);
  });

  it('returns false for kvittering', () => {
    expect(isImportant('kvittering')).toBe(false);
  });

  it('returns false for nyhetsbrev', () => {
    expect(isImportant('nyhetsbrev')).toBe(false);
  });

  it('returns false for reklame', () => {
    expect(isImportant('reklame')).toBe(false);
  });

  it('returns false for annet', () => {
    expect(isImportant('annet')).toBe(false);
  });
});
