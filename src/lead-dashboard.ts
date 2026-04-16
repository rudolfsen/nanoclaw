/**
 * Lead Dashboard Server
 * Lightweight HTTP server for the lead intelligence dashboard.
 * Uses Node.js built-in http module — no Express dependency needed.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { URL } from 'url';

import { LEAD_DASHBOARD_PORT, LEAD_DASHBOARD_TOKEN } from './config.js';
import { resolveLeadDbPath, initLeadDb } from './lead-scanner.js';
import { scoreLead, scoreTier, LeadRow } from './lead-scoring.js';
import { logger } from './logger.js';

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function unauthorized(res: ServerResponse): void {
  json(res, { error: 'Unauthorized' }, 401);
}

function notFound(res: ServerResponse): void {
  json(res, { error: 'Not found' }, 404);
}

function safeTokenMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Authenticate request via bearer token or ?token= query param.
 * Returns true if auth is valid (or if no token is configured).
 */
function authenticate(req: IncomingMessage, url: URL): boolean {
  if (!LEAD_DASHBOARD_TOKEN) return true; // No auth configured
  const bearer = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = url.searchParams.get('token');
  if (bearer && safeTokenMatch(bearer, LEAD_DASHBOARD_TOKEN)) return true;
  if (queryToken && safeTokenMatch(queryToken, LEAD_DASHBOARD_TOKEN))
    return true;
  return false;
}

/**
 * GET /api/leads — list leads with filtering, sorting, pagination
 *
 * Query params:
 *   status     — filter by status (new, contacted, ignored)
 *   source     — filter by source (finn_wanted, mascus, etc.)
 *   type       — filter by signal_type (demand, supply, growth, change)
 *   match      — filter by match_status (has_match, no_match, price_opportunity)
 *   search     — FTS5 search query
 *   since      — ISO date string, only leads after this date
 *   sort       — sort field: score, created_at, price_diff_pct (default: score)
 *   order      — asc or desc (default: desc)
 *   limit      — max results (default: 50, max: 200)
 *   offset     — pagination offset (default: 0)
 */
function handleListLeads(
  db: Database.Database,
  url: URL,
  res: ServerResponse,
): void {
  const status = url.searchParams.get('status');
  const source = url.searchParams.get('source');
  const type = url.searchParams.get('type');
  const match = url.searchParams.get('match');
  const search = url.searchParams.get('search');
  const since = url.searchParams.get('since');
  const limit = Math.min(
    200,
    parseInt(url.searchParams.get('limit') || '50', 10),
  );
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    conditions.push('l.status = ?');
    params.push(status);
  }
  if (source) {
    conditions.push('l.source = ?');
    params.push(source);
  }
  if (type) {
    conditions.push('l.signal_type = ?');
    params.push(type);
  }
  if (match) {
    conditions.push('l.match_status = ?');
    params.push(match);
  }
  if (since) {
    conditions.push('l.created_at >= ?');
    params.push(since);
  }

  let fromClause = 'leads l';
  if (search) {
    fromClause = 'leads_fts f JOIN leads l ON l.id = f.rowid';
    conditions.push('leads_fts MATCH ?');
    params.push(`"${search.replace(/"/g, '""')}"`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total for pagination
  const countRow = db
    .prepare(`SELECT count(*) as total FROM ${fromClause} ${where}`)
    .get(...params) as { total: number };

  // Fetch leads
  const rows = db
    .prepare(
      `SELECT l.* FROM ${fromClause} ${where}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as (LeadRow & {
    matched_ads?: string;
    external_url?: string;
  })[];

  // Compute scores and attach
  const leads = rows.map((row) => {
    const score = scoreLead(row);
    return {
      ...row,
      matched_ads: row.matched_ads ? JSON.parse(row.matched_ads as string) : [],
      score,
      score_tier: scoreTier(score),
    };
  });

  // Sort by score if requested (default)
  const sort = url.searchParams.get('sort') || 'score';
  const order = url.searchParams.get('order') || 'desc';
  if (sort === 'score') {
    leads.sort((a, b) =>
      order === 'desc' ? b.score - a.score : a.score - b.score,
    );
  }

  json(res, { leads, total: countRow.total, limit, offset });
}

/**
 * GET /api/leads/stats — aggregate statistics
 */
function handleStats(db: Database.Database, res: ServerResponse): void {
  const total = (
    db.prepare('SELECT count(*) as n FROM leads').get() as { n: number }
  ).n;
  const byStatus = db
    .prepare('SELECT status, count(*) as n FROM leads GROUP BY status')
    .all();
  const bySource = db
    .prepare('SELECT source, count(*) as n FROM leads GROUP BY source')
    .all();
  const byType = db
    .prepare(
      'SELECT signal_type, count(*) as n FROM leads GROUP BY signal_type',
    )
    .all();
  const byMatch = db
    .prepare(
      'SELECT match_status, count(*) as n FROM leads GROUP BY match_status',
    )
    .all();
  const newToday = (
    db
      .prepare(
        "SELECT count(*) as n FROM leads WHERE created_at >= date('now')",
      )
      .get() as { n: number }
  ).n;
  const newThisWeek = (
    db
      .prepare(
        "SELECT count(*) as n FROM leads WHERE created_at >= date('now', '-7 days')",
      )
      .get() as { n: number }
  ).n;

  json(res, {
    total,
    newToday,
    newThisWeek,
    byStatus,
    bySource,
    byType,
    byMatch,
  });
}

/**
 * PATCH /api/leads/:id — update lead status
 * Body: { "status": "contacted" | "ignored" }
 */
function handleUpdateLead(
  db: Database.Database,
  id: number,
  body: string,
  res: ServerResponse,
): void {
  try {
    const { status } = JSON.parse(body);
    if (!['new', 'contacted', 'ignored'].includes(status)) {
      json(res, { error: 'Invalid status. Use: new, contacted, ignored' }, 400);
      return;
    }
    const result = db
      .prepare('UPDATE leads SET status = ? WHERE id = ?')
      .run(status, id);
    if (result.changes === 0) {
      notFound(res);
      return;
    }
    json(res, { ok: true, id, status });
  } catch {
    json(res, { error: 'Invalid JSON body' }, 400);
  }
}

/**
 * GET /api/leads/sources — list distinct sources
 */
function handleSources(db: Database.Database, res: ServerResponse): void {
  const rows = db
    .prepare('SELECT DISTINCT source FROM leads ORDER BY source')
    .all();
  json(
    res,
    rows.map((r) => (r as Record<string, unknown>).source),
  );
}

// --- Call List (Ringeliste) ---

interface CallListItem {
  rank: number;
  score: number;
  type: 'chat_contact' | 'finn_wanted';
  name: string;
  phone: string | null;
  email: string | null;
  interest: string | null;
  url: string | null;
  matched_machines: {
    title: string;
    price: number | null;
    url: string | null;
  }[];
  source_site: string | null;
  age_hours: number;
  created_at: string;
}

function scoreCallListItem(
  ageHours: number,
  hasMatch: boolean,
  matchedAds: { title?: string; price?: number; url?: string }[],
): number {
  let score = 0;

  // Timing (40%)
  if (ageHours < 24) score += 40;
  else if (ageHours < 72) score += 25;
  else if (ageHours < 168) score += 10;

  // Match (35%)
  if (hasMatch) score += 35;

  // Value (25%) — max price from matched ads
  if (matchedAds.length > 0) {
    const prices = matchedAds
      .map((a) => a.price)
      .filter((p): p is number => typeof p === 'number' && p > 0);
    if (prices.length > 0) {
      const maxPrice = Math.max(...prices);
      if (maxPrice > 500_000) score += 25;
      else if (maxPrice >= 200_000) score += 15;
      else score += 5;
    } else {
      score += 10; // unknown price
    }
  } else if (hasMatch) {
    score += 10; // has match but no ads data
  }

  return Math.round(Math.min(100, Math.max(0, score)));
}

function parseMatchedAds(
  raw: string | null,
): { title?: string; price?: number; url?: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/call-list — daily ranked call list (ringeliste)
 */
function handleCallList(db: Database.Database, res: ServerResponse): void {
  ensureContactsTable(db);

  const items: CallListItem[] = [];

  // 1. Chat contacts with status='new'
  const contacts = db
    .prepare(
      `SELECT id, name, phone, email, interest, site, machines_shown, status, created_at
       FROM chat_contacts WHERE status = 'new' ORDER BY created_at DESC`,
    )
    .all() as Record<string, unknown>[];

  for (const c of contacts) {
    const ageMs = Date.now() - new Date(c.created_at as string).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const machinesShown = c.machines_shown
      ? (() => {
          try {
            return JSON.parse(c.machines_shown as string);
          } catch {
            return [];
          }
        })()
      : [];
    const matchedMachines = Array.isArray(machinesShown)
      ? machinesShown.map(
          (m: string | { title?: string; price?: number; url?: string }) =>
            typeof m === 'string'
              ? { title: m, price: null as number | null, url: m }
              : {
                  title: m.title || '',
                  price: m.price ?? null,
                  url: m.url || null,
                },
        )
      : [];
    const hasMatch = matchedMachines.length > 0;
    // Adapt for scoring function which uses optional fields
    const forScoring = matchedMachines.map((m) => ({
      title: m.title,
      price: m.price ?? undefined,
      url: m.url ?? undefined,
    }));

    items.push({
      rank: 0,
      score: scoreCallListItem(ageHours, hasMatch, forScoring),
      type: 'chat_contact',
      name: (c.name as string) || 'Ukjent',
      phone: (c.phone as string) || null,
      email: (c.email as string) || null,
      interest: (c.interest as string) || null,
      url: null,
      matched_machines: matchedMachines,
      source_site: (c.site as string) || null,
      age_hours: Math.round(ageHours),
      created_at: c.created_at as string,
    });
  }

  // 2. Finn demand leads with match
  const finnLeads = db
    .prepare(
      `SELECT id, title, contact_name, contact_info, external_url, matched_ads, match_status, created_at
       FROM leads
       WHERE source = 'finn_wanted' AND match_status = 'has_match' AND status = 'new'
       ORDER BY created_at DESC LIMIT 50`,
    )
    .all() as Record<string, unknown>[];

  for (const l of finnLeads) {
    const ageMs = Date.now() - new Date(l.created_at as string).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const matchedAds = parseMatchedAds(l.matched_ads as string | null);
    const matchedMachines = matchedAds.map((a) => ({
      title: a.title || '',
      price: a.price || null,
      url: a.url || null,
    }));

    // Extract phone from contact_info if available
    const contactInfo = (l.contact_info as string) || '';
    const phoneMatch = contactInfo.match(/(\d[\d\s]{7,})/);

    items.push({
      rank: 0,
      score: scoreCallListItem(ageHours, true, matchedAds),
      type: 'finn_wanted',
      name: (l.contact_name as string) || (l.title as string) || 'Ukjent',
      phone: phoneMatch ? phoneMatch[1].replace(/\s/g, '') : null,
      email: null,
      interest: (l.title as string) || null,
      url: (l.external_url as string) || null,
      matched_machines: matchedMachines,
      source_site: null,
      age_hours: Math.round(ageHours),
      created_at: l.created_at as string,
    });
  }

  // 3. Proactive matches — new machines matching previous inquiries
  try {
    const proactiveMatches = db
      .prepare(
        `SELECT mn.machine_id, mn.machine_source, mn.contact_type, mn.contact_id, mn.notified_at
         FROM matched_notifications mn
         WHERE mn.notified_at > datetime('now', '-7 days')
         ORDER BY mn.notified_at DESC LIMIT 30`,
      )
      .all() as Record<string, unknown>[];

    for (const pm of proactiveMatches) {
      const ageMs =
        Date.now() - new Date(pm.notified_at as string).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      const machineSource = pm.machine_source as string;
      const machineId = pm.machine_id as string;
      const contactType = pm.contact_type as string;
      const contactId = pm.contact_id as string;

      // Get machine details from cache
      let machineTitle = machineId;
      let machinePrice: number | null = null;
      let machineUrl: string | null = null;
      // Deduplicate: skip if same machine+contact already in items
      const dedupKey = `${machineSource}-${machineId}-${contactId}`;
      if (items.some((i) => `${i.source_site}-${i.url}-${i.name}` === dedupKey))
        continue;

      if (machineSource === 'ats') {
        machineUrl = `https://ats.no/no/gjenstand/${machineId}`;
      } else {
        machineUrl = `https://landbrukssalg.no/${machineId}`;
      }

      // Get contact details
      let contactName = '';
      let contactPhone: string | null = null;
      let contactInterest = '';

      if (contactType === 'chat') {
        const contact = db
          .prepare('SELECT name, phone, interest FROM chat_contacts WHERE id = ?')
          .get(parseInt(contactId, 10)) as Record<string, unknown> | undefined;
        if (contact) {
          contactName = (contact.name as string) || '';
          contactPhone = (contact.phone as string) || null;
          contactInterest = (contact.interest as string) || '';
        }
      } else if (contactType === 'finn') {
        const lead = db
          .prepare('SELECT title, contact_info FROM leads WHERE id = ?')
          .get(parseInt(contactId, 10)) as Record<string, unknown> | undefined;
        if (lead) {
          contactName = (lead.title as string) || '';
          const info = (lead.contact_info as string) || '';
          const phoneMatch = info.match(/(\d[\d\s]{7,})/);
          contactPhone = phoneMatch ? phoneMatch[1].replace(/\s/g, '') : null;
          contactInterest = (lead.title as string) || '';
        }
      }

      if (!contactName) continue;

      items.push({
        rank: 0,
        score: scoreCallListItem(ageHours, true, [
          { title: machineTitle, price: machinePrice ?? undefined, url: machineUrl ?? undefined },
        ]),
        type: 'proactive_match' as any,
        name: contactName,
        phone: contactPhone,
        email: null,
        interest: `Ny maskin inn: ${machineTitle} — matcher forespørsel: "${contactInterest}"`,
        url: machineUrl,
        matched_machines: [{ title: machineTitle, price: machinePrice, url: machineUrl }],
        source_site: machineSource,
        age_hours: Math.round(ageHours),
        created_at: pm.notified_at as string,
      });
    }
  } catch {
    // matched_notifications table may not exist yet
  }

  // Sort by score DESC, take top 10, assign ranks
  items.sort((a, b) => b.score - a.score);
  const top10 = items.slice(0, 10).map((item, i) => ({
    ...item,
    rank: i + 1,
  }));

  json(res, top10);
}

// --- Contact endpoints ---

/**
 * Ensure the chat_contacts table exists in the leads DB.
 */
function ensureContactsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      interest TEXT,
      site TEXT NOT NULL,
      conversation TEXT,
      machines_shown TEXT,
      status TEXT DEFAULT 'new',
      created_at TEXT NOT NULL
    );
  `);
}

/**
 * GET /api/contacts — list contacts with optional ?status= filter
 */
function handleListContacts(
  db: Database.Database,
  url: URL,
  res: ServerResponse,
): void {
  ensureContactsTable(db);
  const status = url.searchParams.get('status');
  const limit = Math.min(
    200,
    parseInt(url.searchParams.get('limit') || '50', 10),
  );
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db
    .prepare(`SELECT count(*) as total FROM chat_contacts ${where}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(
      `SELECT id, name, phone, email, interest, site, conversation, machines_shown, status, created_at
       FROM chat_contacts ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  const contacts = rows.map((row) => ({
    ...row,
    conversation: row.conversation
      ? JSON.parse(row.conversation as string)
      : [],
    machines_shown: row.machines_shown
      ? JSON.parse(row.machines_shown as string)
      : [],
  }));

  json(res, { contacts, total: countRow.total, limit, offset });
}

/**
 * PATCH /api/contacts/:id — update contact status
 * Body: { "status": "new" | "contacted" | "closed" }
 */
function handleUpdateContact(
  db: Database.Database,
  id: number,
  body: string,
  res: ServerResponse,
): void {
  ensureContactsTable(db);
  try {
    const { status } = JSON.parse(body);
    if (!['new', 'contacted', 'closed'].includes(status)) {
      json(res, { error: 'Invalid status. Use: new, contacted, closed' }, 400);
      return;
    }
    const result = db
      .prepare('UPDATE chat_contacts SET status = ? WHERE id = ?')
      .run(status, id);
    if (result.changes === 0) {
      notFound(res);
      return;
    }
    json(res, { ok: true, id, status });
  } catch {
    json(res, { error: 'Invalid JSON body' }, 400);
  }
}

/**
 * Serve the dashboard HTML file.
 */
function serveDashboard(res: ServerResponse): void {
  const htmlPath = path.resolve(process.cwd(), 'dashboard', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Dashboard not found');
    return;
  }
  const html = fs.readFileSync(htmlPath, 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function startDashboardServer(
  port = LEAD_DASHBOARD_PORT,
): Promise<Server> {
  const dbPath = resolveLeadDbPath();
  let db: Database.Database;

  try {
    db = initLeadDb(dbPath);
  } catch (err) {
    logger.error({ err }, 'Failed to open lead database for dashboard');
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );
      const pathname = url.pathname;

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        res.end();
        return;
      }

      // API routes require auth
      if (pathname.startsWith('/api/')) {
        if (!authenticate(req, url)) {
          unauthorized(res);
          return;
        }

        if (req.method === 'GET' && pathname === '/api/leads') {
          handleListLeads(db, url, res);
        } else if (req.method === 'GET' && pathname === '/api/leads/stats') {
          handleStats(db, res);
        } else if (req.method === 'GET' && pathname === '/api/leads/sources') {
          handleSources(db, res);
        } else if (
          req.method === 'PATCH' &&
          pathname.match(/^\/api\/leads\/\d+$/)
        ) {
          const id = parseInt(pathname.split('/').pop()!, 10);
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => handleUpdateLead(db, id, body, res));
        } else if (req.method === 'GET' && pathname === '/api/call-list') {
          handleCallList(db, res);
        } else if (req.method === 'GET' && pathname === '/api/contacts') {
          handleListContacts(db, url, res);
        } else if (
          req.method === 'PATCH' &&
          pathname.match(/^\/api\/contacts\/\d+$/)
        ) {
          const id = parseInt(pathname.split('/').pop()!, 10);
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => handleUpdateContact(db, id, body, res));
        } else {
          notFound(res);
        }
        return;
      }

      // Dashboard HTML (also requires auth via query param)
      if (pathname === '/' || pathname === '/dashboard') {
        if (!authenticate(req, url)) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized — append ?token=YOUR_TOKEN to the URL');
          return;
        }
        serveDashboard(res);
        return;
      }

      notFound(res);
    });

    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Lead dashboard server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
