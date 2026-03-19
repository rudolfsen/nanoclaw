import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';
import { getPendingReceipts, markReceiptSent } from '../src/skills/regnskapsbot-bridge';

describe('Regnskapsbot Bridge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSkillTables(db);
    db.prepare(`
      INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'gmail', 'Meta', 1500, 'NOK', '2026-03-19', 'receipts/meta.pdf', 'pending');
    db.prepare(`
      INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 'outlook', 'Stripe', 299, 'USD', '2026-03-18', 'receipts/stripe.pdf', 'sent');
  });

  afterEach(() => { db.close(); });

  it('should return only pending receipts', () => {
    const pending = getPendingReceipts(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].vendor).toBe('Meta');
  });

  it('should mark receipt as sent', () => {
    markReceiptSent(db, 1);
    const pending = getPendingReceipts(db);
    expect(pending).toHaveLength(0);
  });
});
