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
const WEEKLY_DIGEST_DAY = parseInt(process.env.WEEKLY_DIGEST_DAY || '1', 10); // 1 = Monday
const WEEKLY_DIGEST_HOUR = parseInt(process.env.WEEKLY_DIGEST_HOUR || '8', 10); // 08:00
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

// ---------------------------------------------------------------------------
// Weekly Digest
// ---------------------------------------------------------------------------

interface DigestLead {
  id: number;
  source: string;
  signal_type: string;
  title: string;
  description: string | null;
  category: string | null;
  external_url: string | null;
  match_status: string;
  matched_ads: string | null;
  company_name: string | null;
  price: number | null;
}

/**
 * Split a message into chunks that fit within Telegram's 4096 char limit,
 * splitting at line boundaries to preserve formatting.
 */
function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatBankruptcySection(leads: DigestLead[]): string {
  if (leads.length === 0) return '';
  const lines = [`\u{1F3DA} KONKURSER DENNE UKEN (${leads.length} stk)\n`];
  for (const lead of leads) {
    const name =
      lead.company_name ||
      lead.title.replace(/^(Konkurs|Under avvikling):\s*/i, '');
    const category = lead.category || '';
    lines.push(`\u2022 ${name}${category ? ` \u2014 ${category}` : ''}`);
    lines.push(`  Mulighet: Utstyr kan kj\u00f8pes fra bo`);
  }
  return lines.join('\n');
}

function formatDemandMatchSection(leads: DigestLead[]): string {
  if (leads.length === 0) return '';
  const lines = [
    `\u{1F3AF} NOEN LETER ETTER DET VI HAR (${leads.length} stk)\n`,
  ];
  for (const lead of leads) {
    const title = lead.title || 'Uten tittel';
    lines.push(`\u2022 "${title}"`);

    // Parse matched_ads JSON for inventory match details
    let matchedAds: Array<{ title: string; price: number }> = [];
    if (lead.matched_ads) {
      try {
        matchedAds = JSON.parse(lead.matched_ads);
      } catch {
        // ignore parse errors
      }
    }
    if (matchedAds.length > 0) {
      const ad = matchedAds[0];
      lines.push(
        `  Vi har: ${ad.title} \u2014 ${ad.price != null ? `${ad.price} NOK` : 'pris ukjent'}`,
      );
    }
    if (lead.external_url) {
      lines.push(`  Finn-annonse: ${lead.external_url}`);
    }
  }
  return lines.join('\n');
}

function formatHiringSection(leads: DigestLead[]): string {
  if (leads.length === 0) return '';
  const lines = [
    `\u{1F3D7} FIRMA SOM ANSETTER OPERAT\u00d8RER (${leads.length} stk)\n`,
  ];

  // Group by company to identify multi-hire
  const byCompany = new Map<string, DigestLead[]>();
  for (const lead of leads) {
    const key = lead.company_name || 'Ukjent';
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(lead);
  }

  // Sort: multi-hire first
  const sorted = [...byCompany.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  for (const [company, companyLeads] of sorted) {
    const jobTitle =
      companyLeads[0].title.replace(/^S\u00f8ker:\s*/i, '') || 'operatør';
    const multiHire =
      companyLeads.length > 1 ? ` (${companyLeads.length} stillinger)` : '';
    lines.push(`\u2022 ${company}${multiHire} \u2014 ${jobTitle}`);
    lines.push(`  Signal: Kan trenge maskiner til nye prosjekter`);
  }
  return lines.join('\n');
}

/**
 * Send weekly digest of the most actionable leads from the past 7 days.
 */
export async function sendWeeklyDigest(db: Database.Database): Promise<void> {
  const b = getBot();
  if (!b) return;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const weekLeads = db
    .prepare(
      `SELECT id, source, signal_type, title, description, category,
              external_url, match_status, matched_ads, company_name, price
       FROM leads WHERE created_at >= ? ORDER BY created_at DESC`,
    )
    .all(weekAgo) as DigestLead[];

  const bankruptcies = weekLeads.filter((l) => l.source === 'brreg_bankrupt');
  const demandMatches = weekLeads.filter(
    (l) => l.source === 'finn_wanted' && l.match_status === 'has_match',
  );
  const hiringLeads = weekLeads.filter((l) => l.source === 'finn_jobs');

  const sections = [
    formatBankruptcySection(bankruptcies),
    formatDemandMatchSection(demandMatches),
    formatHiringSection(hiringLeads),
  ].filter(Boolean);

  if (sections.length === 0) {
    try {
      await b.api.sendMessage(
        NOTIFY_CHAT_ID,
        `\u{1F4CB} Ukentlig lead-digest\n\nIngen nye leads av interesse denne uken.`,
      );
      logger.info('Weekly digest sent (empty)');
    } catch (err) {
      logger.error({ err }, 'Failed to send empty weekly digest');
    }
    return;
  }

  const header = `\u{1F4CB} *Ukentlig lead-digest*\n_${weekLeads.length} leads siste 7 dager_\n`;
  const fullMessage = [header, ...sections].join('\n\n');
  const chunks = splitMessage(fullMessage);

  try {
    for (const chunk of chunks) {
      await b.api.sendMessage(NOTIFY_CHAT_ID, chunk, {
        parse_mode: 'Markdown',
      });
    }
    logger.info(
      {
        bankruptcies: bankruptcies.length,
        demandMatches: demandMatches.length,
        hiring: hiringLeads.length,
        chunks: chunks.length,
      },
      'Weekly digest sent',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to send weekly digest');
  }
}

/**
 * Schedule the weekly digest. Runs every minute, fires on the configured day/hour.
 */
export function scheduleWeeklyDigest(db: Database.Database): NodeJS.Timeout {
  let lastSentWeek = '';

  return setInterval(async () => {
    const now = new Date();
    // ISO week identifier: year + week number
    const yearWeek = `${now.getFullYear()}-W${String(getISOWeek(now)).padStart(2, '0')}`;
    if (
      now.getDay() === WEEKLY_DIGEST_DAY &&
      now.getHours() === WEEKLY_DIGEST_HOUR &&
      lastSentWeek !== yearWeek
    ) {
      lastSentWeek = yearWeek;
      await sendWeeklyDigest(db);
    }
  }, 60_000);
}

/**
 * Get ISO week number for a date.
 */
function getISOWeek(date: Date): number {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
