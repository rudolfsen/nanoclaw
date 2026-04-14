/**
 * Lead Notifications — Telegram alerts for high-value leads and daily summaries.
 *
 * Two notification types:
 * 1. Instant alerts: triggered after each scan for new leads scoring >= 60 (hot)
 * 2. Daily summary: scheduled once per day (configurable hour)
 *
 * Uses the grammy Bot API directly (not the channel system) to send to a
 * configured chat ID. This avoids coupling with the message processing pipeline.
 */
import Database from 'better-sqlite3';
import { Bot } from 'grammy';

import { scoreLead, scoreTier, LeadRow } from './lead-scoring.js';
import { logger } from './logger.js';

const NOTIFY_CHAT_ID = process.env.LEAD_NOTIFY_CHAT_ID || '';
const NOTIFY_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DAILY_SUMMARY_HOUR = parseInt(process.env.LEAD_SUMMARY_HOUR || '7', 10); // 07:00
const HOT_LEAD_THRESHOLD = 60;

let bot: Bot | null = null;

function getBot(): Bot | null {
  if (!NOTIFY_BOT_TOKEN || !NOTIFY_CHAT_ID) return null;
  if (!bot) bot = new Bot(NOTIFY_BOT_TOKEN);
  return bot;
}

/**
 * Format a lead for Telegram (Markdown v1).
 */
function formatLeadAlert(
  lead: LeadRow & { score: number; external_url?: string; title?: string },
): string {
  const emoji = lead.signal_type === 'demand' ? '\u{1F3AF}' : '\u{1F4B0}';
  const tier = scoreTier(lead.score);
  const tierEmoji =
    tier === 'hot' ? '\u{1F525}' : tier === 'warm' ? '\u{1F7E1}' : '\u26AA';
  const lines = [
    `${emoji} *Ny lead* (score: ${lead.score} ${tierEmoji})`,
    ``,
    `*${lead.title || 'Uten tittel'}*`,
    `Kilde: ${lead.source} | Type: ${lead.signal_type}`,
    `Match: ${lead.match_status}`,
  ];
  if (lead.price_diff_pct != null) {
    lines.push(`Prisdiff: ${lead.price_diff_pct.toFixed(1)}%`);
  }
  if (lead.contact_name) {
    lines.push(`Kontakt: ${lead.contact_name}`);
  }
  if (lead.external_url) {
    lines.push(`[Se annonsen](${lead.external_url})`);
  }
  return lines.join('\n');
}

/**
 * Called after each scan. Checks for new hot leads (created since last check)
 * and sends Telegram alerts.
 */
export async function notifyNewHotLeads(
  db: Database.Database,
  since: string,
): Promise<number> {
  const b = getBot();
  if (!b) return 0;

  const rows = db
    .prepare(
      `SELECT * FROM leads WHERE created_at >= ? AND status = 'new' ORDER BY created_at DESC`,
    )
    .all(since) as (LeadRow & { external_url?: string; title?: string })[];

  let sent = 0;
  for (const row of rows) {
    const score = scoreLead(row);
    if (score >= HOT_LEAD_THRESHOLD) {
      const msg = formatLeadAlert({ ...row, score });
      try {
        await b.api.sendMessage(NOTIFY_CHAT_ID, msg, {
          parse_mode: 'Markdown',
        });
        sent++;
      } catch (err) {
        logger.error(
          { err, leadId: row.id },
          'Failed to send lead notification',
        );
      }
    }
  }

  if (sent > 0) {
    logger.info({ sent }, 'Lead notifications sent');
  }
  return sent;
}

/**
 * Send daily summary of lead activity.
 */
export async function sendDailySummary(db: Database.Database): Promise<void> {
  const b = getBot();
  if (!b) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();

  const total = (
    db.prepare('SELECT count(*) as n FROM leads').get() as { n: number }
  ).n;
  const newToday = (
    db
      .prepare('SELECT count(*) as n FROM leads WHERE created_at >= ?')
      .get(todayStr) as { n: number }
  ).n;
  const hotToday = db
    .prepare(`SELECT * FROM leads WHERE created_at >= ? AND status = 'new'`)
    .all(todayStr) as LeadRow[];

  const hotCount = hotToday.filter(
    (l) => scoreLead(l) >= HOT_LEAD_THRESHOLD,
  ).length;
  const demandCount = (
    db
      .prepare(
        "SELECT count(*) as n FROM leads WHERE created_at >= ? AND signal_type = 'demand'",
      )
      .get(todayStr) as { n: number }
  ).n;
  const priceOppCount = (
    db
      .prepare(
        "SELECT count(*) as n FROM leads WHERE created_at >= ? AND match_status = 'price_opportunity'",
      )
      .get(todayStr) as { n: number }
  ).n;

  const lines = [
    `\u{1F4CA} *Daglig lead-oppsummering*`,
    ``,
    `Nye leads i dag: *${newToday}*`,
    `\u{1F525} Hot leads: *${hotCount}*`,
    `\u{1F3AF} Kjopssignaler: *${demandCount}*`,
    `\u{1F4B0} Prismuligheter: *${priceOppCount}*`,
    ``,
    `Totalt i databasen: ${total}`,
  ];

  if (hotCount > 0) {
    lines.push(``, `Se dashboard for detaljer.`);
  }

  try {
    await b.api.sendMessage(NOTIFY_CHAT_ID, lines.join('\n'), {
      parse_mode: 'Markdown',
    });
    logger.info('Daily lead summary sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send daily lead summary');
  }
}

/**
 * Schedule the daily summary. Runs every minute and checks if it's time.
 */
export function scheduleDailySummary(db: Database.Database): NodeJS.Timeout {
  let lastSentDate = '';

  return setInterval(async () => {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    if (now.getHours() === DAILY_SUMMARY_HOUR && lastSentDate !== dateStr) {
      lastSentDate = dateStr;
      await sendDailySummary(db);
    }
  }, 60_000);
}
