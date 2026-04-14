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
  if (queryToken && safeTokenMatch(queryToken, LEAD_DASHBOARD_TOKEN)) return true;
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
