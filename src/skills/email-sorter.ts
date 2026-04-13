import Database from 'better-sqlite3';

export interface EmailInput {
  from: string;
  subject: string;
  body: string;
}

export interface CategoryResult {
  category:
    | 'viktig'
    | 'handling_kreves'
    | 'kvittering'
    | 'nyhetsbrev'
    | 'reklame'
    | 'annet';
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
  /\bdigest\b/i,
  /\bukens?\s+(nyhet|oppdatering)/i,
  /\bny(het|tt)!\s/i,
  /\bny bok\b/i,
  /\bnyheter i pocket\b/i,
  /\bpå sitt sterkeste\b/i,
  /\bterningkast\b/i,
  /\bkommer:?\s/i,
];

const RECEIPT_SENDERS = [
  'facebookmail.com',
  'paypal.com',
  'stripe.com',
  'vipps.no',
  'klarna.com',
];

const REKLAME_PATTERNS = [
  /campaign/i,
  /\boffer\b/i,
  /\bsale\b/i,
  /rabatt/i,
  /tilbud/i,
  /\d+\s*%\s*off/i,
  /\bjoin\b.*\bevent\b/i,
  /\bregister\b.*\bnow\b/i,
  /\btop \d+ things you'll miss\b/i,
  /\bgratismalen?\b/i,
];

const AUTOMATED_SENDER_PATTERNS = [
  /noreply/i,
  /no-reply/i,
  /donotreply/i,
  /do-not-reply/i,
  /notifications?@/i,
  /alerts?@/i,
  /support@/i,
  /hello@/i,
  /info@/i,
  /contact@/i,
  /news@/i,
  /newsletter@/i,
  /mailer@/i,
  /updates?@/i,
];

const AUTOMATED_DOMAINS = [
  't.shopifyemail.com',
  'shopify.com',
  'mailchimp.com',
  'sendgrid.net',
  'mandrillapp.com',
  'amazonses.com',
  'mailgun.org',
  'sparkpostmail.com',
  'exacttarget.com',
  'salesforce.com',
  'hubspot.com',
  'klaviyo.com',
  'constantcontact.com',
  'mailerlite.com',
  'sendinblue.com',
  // Marketing/newsletter domains (not personal contacts)
  'figma.com',
  'tiktok.com',
  'mindtheproduct.com',
  'outsidecontext.co',
  'adobe.com',
  // Industry/org mailing lists
  'w3.org',
  'edrlab.org',
  'penguinrandomhouse.com',
  'neustudio.com',
  'mailchimpapp.com',
  'styreforeningen.no',
  'bulabistro.no',
];

type ClaudeClassifier = (
  email: EmailInput,
) => Promise<{ category: string; confidence: number }>;

export async function classifyWithClaude(
  email: EmailInput,
  classifier: ClaudeClassifier,
): Promise<CategoryResult> {
  const result = await classifier(email);
  return {
    category: result.category as CategoryResult['category'],
    confidence: result.confidence,
    needsAI: false,
  };
}

function isAutomatedSender(from: string): boolean {
  const senderDomain = from.split('@')[1] || '';
  if (AUTOMATED_DOMAINS.some((d) => senderDomain.includes(d))) return true;
  if (AUTOMATED_SENDER_PATTERNS.some((p) => p.test(from))) return true;
  return false;
}

export function categorizeEmail(email: EmailInput): CategoryResult {
  const text = `${email.subject} ${email.body}`;
  const senderDomain = email.from.split('@')[1] || '';

  // Shopify transactional domain → annet
  if (senderDomain.includes('t.shopifyemail.com')) {
    return { category: 'annet', confidence: 0.9, needsAI: false };
  }

  if (
    RECEIPT_SENDERS.some((s) => senderDomain.includes(s)) ||
    RECEIPT_PATTERNS.some((p) => p.test(text))
  ) {
    return { category: 'kvittering', confidence: 0.9, needsAI: false };
  }

  if (NEWSLETTER_PATTERNS.some((p) => p.test(text))) {
    return { category: 'nyhetsbrev', confidence: 0.8, needsAI: false };
  }

  if (REKLAME_PATTERNS.some((p) => p.test(text))) {
    return { category: 'reklame', confidence: 0.8, needsAI: false };
  }

  // Automated senders that didn't match any pattern → annet
  if (isAutomatedSender(email.from)) {
    return { category: 'annet', confidence: 0.7, needsAI: false };
  }

  // Non-automated sender, no pattern match → needs AI to decide
  return { category: 'annet', confidence: 0, needsAI: true };
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
