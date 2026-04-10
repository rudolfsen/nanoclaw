import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { generateDailySummary } from './email-summary.js';

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
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function insertEmail(
  db: Database.Database,
  category: string,
  hoursAgo: number = 1,
): void {
  const createdAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '');
  db.prepare(
    `INSERT INTO categorized_emails (email_uid, source, sender, subject, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`uid-${Math.random()}`, 'gmail', 'test@example.com', 'Test', category, createdAt);
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('generateDailySummary', () => {
  it('generates summary with correct counts per category', () => {
    insertEmail(db, 'viktig');
    insertEmail(db, 'viktig');
    insertEmail(db, 'handling_kreves');
    insertEmail(db, 'kvittering');
    insertEmail(db, 'kvittering');
    insertEmail(db, 'kvittering');
    insertEmail(db, 'reklame');
    insertEmail(db, 'reklame');
    insertEmail(db, 'reklame');
    insertEmail(db, 'reklame');
    insertEmail(db, 'reklame');
    insertEmail(db, 'reklame');

    const result = generateDailySummary(db);

    expect(result).toBe(
      '📬 12 nye i går — 2 viktige, 1 handling, 3 kvitteringer, 6 reklame',
    );
  });

  it('omits categories with zero count', () => {
    insertEmail(db, 'viktig');
    insertEmail(db, 'reklame');
    insertEmail(db, 'reklame');

    const result = generateDailySummary(db);

    expect(result).toContain('1 viktige');
    expect(result).toContain('2 reklame');
    expect(result).not.toContain('handling');
    expect(result).not.toContain('kvittering');
    expect(result).not.toContain('nyhetsbrev');
    expect(result).not.toContain('annet');
  });

  it('returns "Ingen nye e-poster i går" when no emails', () => {
    const result = generateDailySummary(db);
    expect(result).toBe('Ingen nye e-poster i går');
  });

  it('excludes emails older than 24 hours', () => {
    insertEmail(db, 'viktig', 25); // 25 hours ago — outside window
    insertEmail(db, 'reklame', 1); // 1 hour ago — inside window

    const result = generateDailySummary(db);

    expect(result).not.toContain('viktige');
    expect(result).toContain('1 reklame');
  });
});
