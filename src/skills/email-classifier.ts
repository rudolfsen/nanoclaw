import Database from 'better-sqlite3';
import { categorizeEmail, CategoryResult } from './email-sorter.js';

export interface EmailForClassification {
  uid: string;
  source: 'gmail' | 'outlook';
  from: string;
  subject: string;
  body: string;
}

export function classifyAndStore(
  db: Database.Database,
  email: EmailForClassification,
): CategoryResult {
  const result = categorizeEmail({
    from: email.from,
    subject: email.subject,
    body: email.body,
  });

  db.prepare(
    `INSERT OR IGNORE INTO categorized_emails (email_uid, source, sender, subject, category)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(email.uid, email.source, email.from, email.subject, result.category);

  return result;
}

export function isImportant(category: string): boolean {
  return category === 'viktig' || category === 'handling_kreves';
}
