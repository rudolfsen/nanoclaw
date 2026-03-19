import Database from 'better-sqlite3';

export interface EmailInput {
  from: string;
  subject: string;
  body: string;
}

export interface CategoryResult {
  category:
    | 'kvittering'
    | 'nyhetsbrev'
    | 'viktig'
    | 'jobb'
    | 'privat'
    | 'ukjent';
  confidence: number;
  needsAI: boolean;
}

const RECEIPT_PATTERNS = [
  /receipt/i,
  /invoice/i,
  /faktura/i,
  /kvittering/i,
  /payment.*confirm/i,
  /amount.*charged/i,
  /order.*confirm/i,
];

const NEWSLETTER_PATTERNS = [
  /unsubscribe/i,
  /newsletter/i,
  /weekly.*digest/i,
  /nyhetsbrev/i,
  /avmeld/i,
  /list-unsubscribe/i,
];

const RECEIPT_SENDERS = [
  'facebookmail.com',
  'paypal.com',
  'stripe.com',
  'vipps.no',
  'klarna.com',
];

type ClaudeClassifier = (email: EmailInput) => Promise<{ category: string; confidence: number }>;

export async function classifyWithClaude(
  email: EmailInput,
  classifier: ClaudeClassifier
): Promise<CategoryResult> {
  const result = await classifier(email);
  return {
    category: result.category as CategoryResult['category'],
    confidence: result.confidence,
    needsAI: false,
  };
}

export function categorizeEmail(email: EmailInput): CategoryResult {
  const text = `${email.subject} ${email.body}`;
  const senderDomain = email.from.split('@')[1] || '';

  if (
    RECEIPT_SENDERS.some((s) => senderDomain.includes(s)) ||
    RECEIPT_PATTERNS.some((p) => p.test(text))
  ) {
    return { category: 'kvittering', confidence: 0.9, needsAI: false };
  }

  if (NEWSLETTER_PATTERNS.some((p) => p.test(text))) {
    return { category: 'nyhetsbrev', confidence: 0.8, needsAI: false };
  }

  return { category: 'ukjent', confidence: 0, needsAI: true };
}

export function lookupLearnedCategory(
  db: Database.Database,
  sender: string,
): { category: string; confidence: number } | null {
  const row = db
    .prepare(
      'SELECT category, confidence FROM email_categories WHERE sender = ? ORDER BY confidence DESC LIMIT 1',
    )
    .get(sender) as any;
  return row ? { category: row.category, confidence: row.confidence } : null;
}

export function saveLearnedCategory(
  db: Database.Database,
  sender: string,
  category: string,
  confidence: number,
): void {
  db.prepare(
    `
    INSERT INTO email_categories (sender, category, confidence)
    VALUES (?, ?, ?)
    ON CONFLICT(sender, category) DO UPDATE SET confidence = ?, created_at = datetime('now')
  `,
  ).run(sender, category, confidence, confidence);
}
