import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';

describe('Skill database tables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSkillTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should create email_categories table', () => {
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='email_categories'"
    ).get();
    expect(result).toBeDefined();
  });

  it('should create receipts table', () => {
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='receipts'"
    ).get();
    expect(result).toBeDefined();
  });

  it('should insert and query a receipt', () => {
    db.prepare(`
      INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(123, 'gmail', 'Meta', 1500.00, 'NOK', '2026-03-19', 'receipts/meta-2026-03-19.pdf', 'pending');

    const receipt = db.prepare('SELECT * FROM receipts WHERE email_uid = ?').get(123) as any;
    expect(receipt.vendor).toBe('Meta');
    expect(receipt.amount).toBe(1500.00);
    expect(receipt.status).toBe('pending');
  });

  it('should insert and query learned email categories', () => {
    db.prepare(`
      INSERT INTO email_categories (sender, category, confidence)
      VALUES (?, ?, ?)
    `).run('noreply@facebookmail.com', 'kvittering', 0.95);

    const cat = db.prepare('SELECT * FROM email_categories WHERE sender = ?')
      .get('noreply@facebookmail.com') as any;
    expect(cat.category).toBe('kvittering');
    expect(cat.confidence).toBe(0.95);
  });

  it('should create outlook_processed table', () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='outlook_processed'"
      )
      .get() as any;
    expect(row).toBeDefined();
    expect(row.name).toBe('outlook_processed');
  });

  it('should create outlook_deliveries table', () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='outlook_deliveries'"
      )
      .get() as any;
    expect(row).toBeDefined();
    expect(row.name).toBe('outlook_deliveries');
  });

  it('should have response_count and ignore_count on email_categories', () => {
    db.prepare(
      "INSERT INTO email_categories (sender, category, confidence) VALUES ('test@example.com', 'viktig', 0.9)"
    ).run();
    const row = db
      .prepare('SELECT response_count, ignore_count, last_response_at FROM email_categories WHERE sender = ?')
      .get('test@example.com') as any;
    expect(row.response_count).toBe(0);
    expect(row.ignore_count).toBe(0);
    expect(row.last_response_at).toBeNull();
  });

  it('should create email_tags table', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_tags'")
      .get() as any;
    expect(row).toBeDefined();
  });

  it('should create learned_tags table', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_tags'")
      .get() as any;
    expect(row).toBeDefined();
  });

  it('outlook_processed should accept TEXT uid', () => {
    db.prepare("INSERT INTO outlook_processed (uid) VALUES ('AAMkAGQ123')").run();
    const row = db.prepare("SELECT uid FROM outlook_processed WHERE uid = 'AAMkAGQ123'").get() as any;
    expect(row.uid).toBe('AAMkAGQ123');
  });
});
