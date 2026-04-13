import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const VALID_CATEGORIES = [
  'viktig',
  'handling_kreves',
  'kvittering',
  'nyhetsbrev',
  'reklame',
  'annet',
] as const;

type Category = (typeof VALID_CATEGORIES)[number];

/**
 * Use Claude to classify an email that the pattern matcher couldn't handle.
 * Returns a category string. Uses Haiku for speed and cost.
 */
export async function classifyEmailWithAI(
  from: string,
  subject: string,
  bodySnippet: string,
): Promise<{ category: Category; confidence: number; isLegal: boolean }> {
  const envVars = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY;

  if (!apiKey) {
    logger.warn('No ANTHROPIC_API_KEY, falling back to annet');
    return { category: 'annet', confidence: 0, isLegal: false };
  }

  const prompt = `Classify this email into exactly one category. The recipient is Magnus who runs Allvit, a digital publishing/book industry company in Norway.

Categories:
- viktig: Requires Magnus's personal attention or action. Direct messages from colleagues, clients, partners asking questions, requesting meetings, or needing decisions.
- handling_kreves: Urgent action needed (deadlines, time-sensitive requests).
- kvittering: Receipts, invoices, payment confirmations, subscription renewals.
- nyhetsbrev: Newsletters, digests, product announcements, marketing from companies, book/publishing news, event invitations, industry updates.
- reklame: Ads, promotions, sales offers, "boost your performance" type emails.
- annet: Everything else (automated notifications, system emails, confirmations).

Key distinction: "viktig" is ONLY for emails where a real person is writing directly to Magnus expecting a personal response. Mass emails from real-looking addresses (publishers announcing books, industry digests, mailing lists) are "nyhetsbrev", not "viktig".

Also flag if this email has potential legal implications (contracts, terminations, disputes, claims, compliance). Add "[JURIDISK]" before the category if so.

Email:
From: ${from}
Subject: ${subject}
Body: ${bodySnippet.slice(0, 300)}

Reply with ONLY the category name, nothing else.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, text }, 'AI classification API error');
      return { category: 'annet', confidence: 0, isLegal: false };
    }

    const data = (await res.json()) as any;
    const reply = (data.content?.[0]?.text || '').trim().toLowerCase();
    const isLegal = reply.includes('[juridisk]');
    const cleanReply = reply.replace('[juridisk]', '').trim();

    if (VALID_CATEGORIES.includes(cleanReply as Category)) {
      return { category: cleanReply as Category, confidence: 0.85, isLegal };
    }

    // Try to extract category from reply if it has extra text
    for (const cat of VALID_CATEGORIES) {
      if (cleanReply.includes(cat)) {
        return { category: cat, confidence: 0.8, isLegal };
      }
    }

    logger.warn({ reply }, 'AI classifier returned unexpected value');
    return { category: 'annet', confidence: 0.5, isLegal: false };
  } catch (err) {
    logger.warn({ err }, 'AI classification failed');
    return { category: 'annet', confidence: 0, isLegal: false };
  }
}
