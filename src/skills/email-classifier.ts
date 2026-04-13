import Database from 'better-sqlite3';
import { categorizeEmail, CategoryResult, lookupLearnedCategory } from './email-sorter.js';

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

export function classifyWithFallback(
  db: Database.Database,
  email: EmailForClassification,
): CategoryResult {
  // Step 1: pattern-based classification
  const result = categorizeEmail({
    from: email.from,
    subject: email.subject,
    body: email.body,
  });

  // Step 2: if confident, store and return
  if (!result.needsAI) {
    classifyAndStore(db, email);
    return result;
  }

  // Step 3: check DB for learned category
  const learned = lookupLearnedCategory(db, email.from);
  if (learned && learned.confidence >= 0.7) {
    const learnedResult: CategoryResult = {
      category: learned.category as CategoryResult['category'],
      confidence: learned.confidence,
      needsAI: false,
    };
    classifyAndStore(db, email);
    return learnedResult;
  }

  // Step 4: fall through as "annet" (AI classification via container agent later)
  classifyAndStore(db, email);
  return result;
}
