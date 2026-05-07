/**
 * Post-hoc classification of chat sessions that ended without an explicit
 * save_contact call. Walks pending_classification rows, asks Haiku to extract
 * any contact info the model missed in the live chat, then updates the row to
 * has_contact or no_contact accordingly.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';

import { logger } from './logger.js';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const CLASSIFIER_MAX_TOKENS = 512;
const DEFAULT_BATCH_LIMIT = 50;

const SYSTEM_PROMPT = `Du analyserer en chat mellom en kunde og en bot på en norsk landbruks- eller maskinhandelsside. Avgjør om KUNDEN selv har oppgitt sin egen kontaktinfo (navn, telefon, e-post) i samtalen.

Viktig:
- Bots egne kontaktdetaljer (Bjørnar, support-numre) teller IKKE som kundens kontakt.
- Et fornavn alene som svar på "Hva heter du?" teller som kontakt.
- Telefon- eller e-postformat fra kunden teller som kontakt.

Returner KUN gyldig JSON, uten forklaring eller markdown:
{"has_contact": boolean, "name": string|null, "phone": string|null, "email": string|null, "interest": string|null}

interest = en kort beskrivelse på norsk av hva kunden vil (f.eks. "selge dieseltank" eller "kjøpe traktor"). Sett null om uklart.`;

interface ClassifierResult {
  has_contact: boolean;
  name: string | null;
  phone: string | null;
  email: string | null;
  interest: string | null;
}

interface PendingRow {
  id: number;
  session_id: string;
  conversation: string;
}

export interface ClassifyOptions {
  limit?: number;
}

export interface ClassifyReport {
  classified: number;
  hasContact: number;
  noContact: number;
  failed: number;
}

function parseClassifierResponse(text: string): ClassifierResult | null {
  // Haiku occasionally wraps JSON in code fences — strip them.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.has_contact !== 'boolean') return null;
    return {
      has_contact: parsed.has_contact,
      name: typeof parsed.name === 'string' ? parsed.name : null,
      phone: typeof parsed.phone === 'string' ? parsed.phone : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      interest: typeof parsed.interest === 'string' ? parsed.interest : null,
    };
  } catch {
    return null;
  }
}

function formatConversation(conversationJson: string): string {
  try {
    const parsed = JSON.parse(conversationJson) as {
      role: string;
      content: string;
    }[];
    return parsed
      .map(
        (m) =>
          `${m.role === 'user' ? 'Kunde' : 'Bot'}: ${m.content.replace(/\s+/g, ' ').trim()}`,
      )
      .join('\n');
  } catch {
    return conversationJson;
  }
}

export async function classifyPendingChats(
  db: Database.Database,
  anthropic: Anthropic,
  opts: ClassifyOptions = {},
): Promise<ClassifyReport> {
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  const rows = db
    .prepare(
      `SELECT id, session_id, conversation
       FROM chat_contacts
       WHERE status = 'pending_classification'
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(limit) as PendingRow[];

  const report: ClassifyReport = {
    classified: 0,
    hasContact: 0,
    noContact: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      const response = await anthropic.messages.create({
        model: CLASSIFIER_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Samtale:\n${formatConversation(row.conversation)}`,
          },
        ],
      });

      const text = response.content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map((b) => b.text)
        .join('');
      const parsed = parseClassifierResponse(text);

      if (!parsed) {
        report.failed++;
        logger.warn(
          { sessionId: row.session_id, raw: text.slice(0, 200) },
          'chat-classifier: malformed response, leaving row pending',
        );
        continue;
      }

      if (parsed.has_contact) {
        db.prepare(
          `UPDATE chat_contacts
           SET status = 'has_contact',
               name = ?,
               phone = ?,
               email = ?,
               interest = ?
           WHERE id = ?`,
        ).run(
          parsed.name ?? '',
          parsed.phone ?? '',
          parsed.email ?? '',
          parsed.interest ?? '',
          row.id,
        );
        report.hasContact++;
      } else {
        db.prepare(
          `UPDATE chat_contacts SET status = 'no_contact' WHERE id = ?`,
        ).run(row.id);
        report.noContact++;
      }
      report.classified++;
    } catch (err) {
      report.failed++;
      logger.error(
        { err, sessionId: row.session_id },
        'chat-classifier: API call failed, will retry next pass',
      );
    }
  }

  if (report.classified > 0 || report.failed > 0) {
    logger.info(
      { ...report, batchSize: rows.length },
      'chat-classifier: pass complete',
    );
  }

  return report;
}
