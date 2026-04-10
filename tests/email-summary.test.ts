import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';
import { generateDailySummary } from '../src/skills/email-summary';

describe('Daily Email Summary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSkillTables(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS categorized_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_uid INTEGER NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => { db.close(); });

  it('should generate summary from categorized emails', () => {
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(1, 'gmail', 'viktig');
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(2, 'outlook', 'kvittering');
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(3, 'gmail', 'nyhetsbrev');
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(4, 'gmail', 'nyhetsbrev');

    const summary = generateDailySummary(db);
    expect(summary).toContain('4');
    expect(summary).toContain('viktig');
    expect(summary).toContain('kvittering');
    expect(summary).toContain('nyhetsbrev');
  });

  it('should return empty message when no emails', () => {
    const summary = generateDailySummary(db);
    expect(summary).toBe('Ingen nye e-poster i går');
  });
});
