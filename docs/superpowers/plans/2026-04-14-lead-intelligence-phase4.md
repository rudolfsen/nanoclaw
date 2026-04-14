# Lead Intelligence Phase 4 — Dashboard & Automation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide Bjornar with a mobile-friendly web dashboard to browse, filter, and act on leads — plus automated Telegram notifications for high-value leads and daily summaries. Add lead scoring so the most important leads surface first.

**Architecture:** A lightweight Express server (inside the NanoClaw process) serves a single-page HTML dashboard and a REST API that reads directly from `data/leads.sqlite`. Authentication is a bearer token from `.env`. Automated notifications use the existing Telegram channel to push alerts. Lead scoring is a computed column derived from signal type, match status, price diff, and age.

**Tech Stack:** TypeScript, Express (already indirect dep via grammy; add explicitly), better-sqlite3, vanilla HTML/CSS/JS (no framework), Telegram Bot API (via grammy)

**Spec:** `docs/superpowers/specs/2026-04-14-lead-intelligence-design.md` (Phase 4)

**Dependencies:** Phase 1 complete (leads table, scanner running). Phase 2/3 data (price_history, Doffin, Bronnøysund) enhances dashboard but is not required — the dashboard will gracefully handle missing columns.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lead-dashboard.ts` | Create | Express server: REST API + static file serving |
| `src/lead-dashboard.test.ts` | Create | Tests for API endpoints and auth |
| `src/lead-scoring.ts` | Create | Scoring function: ranks leads by value |
| `src/lead-scoring.test.ts` | Create | Tests for scoring logic |
| `src/lead-notifications.ts` | Create | Telegram alerts for high-value leads and daily summaries |
| `src/lead-notifications.test.ts` | Create | Tests for notification logic |
| `dashboard/index.html` | Create | Single-page dashboard (HTML + embedded CSS + JS) |
| `src/index.ts` | Modify | Start dashboard server, start notification scheduler |
| `src/lead-scanner.ts` | Modify | Call notification hook after each scan |
| `src/config.ts` | Modify | Add dashboard port and notification config |

---

### Task 1: Lead scoring module

Create a pure function that scores leads based on their attributes. No DB dependency — takes a lead row and returns a numeric score.

**Files:**
- Create: `src/lead-scoring.ts`
- Create: `src/lead-scoring.test.ts`

- [ ] **Step 1: Create scoring module**

Create `src/lead-scoring.ts`:

```typescript
/**
 * Lead Scoring — ranks leads by estimated value.
 *
 * Score range: 0-100
 * Factors:
 *   - Signal type (demand > supply > growth > change)
 *   - Match status (has_match >> price_opportunity > no_match)
 *   - Price diff magnitude (larger = better for supply)
 *   - Freshness (newer = higher)
 *   - Contact info availability
 */

export interface LeadRow {
  id: number;
  source: string;
  signal_type: string;
  match_status: string;
  price_diff_pct: number | null;
  status: string;
  contact_info: string | null;
  contact_name: string | null;
  created_at: string;
}

export function scoreLead(lead: LeadRow): number {
  let score = 0;

  // Signal type weight (0-30)
  switch (lead.signal_type) {
    case 'demand':  score += 30; break;  // Someone wants to buy — highest value
    case 'supply':  score += 20; break;  // Price opportunity
    case 'growth':  score += 15; break;  // Growth signal (Phase 3)
    case 'change':  score += 10; break;  // Change signal (Phase 3)
  }

  // Match status (0-30)
  switch (lead.match_status) {
    case 'has_match':         score += 30; break;  // We have what they want
    case 'price_opportunity': score += 25; break;  // Arbitrage opportunity
    case 'no_match':          score += 0;  break;  // No match in our inventory
  }

  // Price diff bonus for supply signals (0-15)
  if (lead.signal_type === 'supply' && lead.price_diff_pct != null) {
    const diffScore = Math.min(15, Math.abs(lead.price_diff_pct) / 3);
    score += diffScore;
  }

  // Freshness — leads decay over time (0-15)
  const ageMs = Date.now() - new Date(lead.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) score += 15;
  else if (ageDays < 3) score += 12;
  else if (ageDays < 7) score += 8;
  else if (ageDays < 14) score += 4;
  else score += 0;

  // Contact info bonus (0-10)
  if (lead.contact_info) score += 7;
  if (lead.contact_name) score += 3;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Classify a score into a tier for display.
 */
export function scoreTier(score: number): 'hot' | 'warm' | 'cold' {
  if (score >= 60) return 'hot';
  if (score >= 30) return 'warm';
  return 'cold';
}
```

- [ ] **Step 2: Write scoring tests**

Create `src/lead-scoring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { scoreLead, scoreTier } from './lead-scoring.js';

function makeLead(overrides: Partial<import('./lead-scoring.js').LeadRow> = {}): import('./lead-scoring.js').LeadRow {
  return {
    id: 1,
    source: 'finn_wanted',
    signal_type: 'demand',
    match_status: 'has_match',
    price_diff_pct: null,
    status: 'new',
    contact_info: '99887766',
    contact_name: 'Ola Nordmann',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('scoreLead', () => {
  it('scores a hot lead (demand + has_match + fresh + contact)', () => {
    const score = scoreLead(makeLead());
    expect(score).toBeGreaterThanOrEqual(70);
    expect(scoreTier(score)).toBe('hot');
  });

  it('scores a cold lead (supply + no_match + old + no contact)', () => {
    const score = scoreLead(makeLead({
      signal_type: 'supply',
      match_status: 'no_match',
      contact_info: null,
      contact_name: null,
      created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    expect(score).toBeLessThanOrEqual(30);
    expect(scoreTier(score)).toBe('cold');
  });

  it('gives bonus for large price diff on supply signals', () => {
    const withDiff = scoreLead(makeLead({
      signal_type: 'supply',
      match_status: 'price_opportunity',
      price_diff_pct: 45,
    }));
    const withoutDiff = scoreLead(makeLead({
      signal_type: 'supply',
      match_status: 'price_opportunity',
      price_diff_pct: 5,
    }));
    expect(withDiff).toBeGreaterThan(withoutDiff);
  });

  it('returns score between 0 and 100', () => {
    const score = scoreLead(makeLead());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('scoreTier', () => {
  it('maps scores to tiers', () => {
    expect(scoreTier(80)).toBe('hot');
    expect(scoreTier(60)).toBe('hot');
    expect(scoreTier(45)).toBe('warm');
    expect(scoreTier(30)).toBe('warm');
    expect(scoreTier(20)).toBe('cold');
    expect(scoreTier(0)).toBe('cold');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lead-scoring.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lead-scoring.ts src/lead-scoring.test.ts
git commit -m "feat: add lead scoring module"
```

---

### Task 2: Dashboard REST API

Create an Express server that exposes a JSON API for querying leads, plus serves the static dashboard HTML. Token-based authentication.

**Files:**
- Create: `src/lead-dashboard.ts`
- Create: `src/lead-dashboard.test.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add config values**

In `src/config.ts`, add after the existing exports:

```typescript
export const LEAD_DASHBOARD_PORT = parseInt(
  process.env.LEAD_DASHBOARD_PORT || '3002',
  10,
);
export const LEAD_DASHBOARD_TOKEN = process.env.LEAD_DASHBOARD_TOKEN || '';
```

- [ ] **Step 2: Create the dashboard server**

Create `src/lead-dashboard.ts`:

```typescript
/**
 * Lead Dashboard Server
 * Lightweight Express-like HTTP server for the lead intelligence dashboard.
 * Uses Node.js built-in http module — no Express dependency needed.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
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

/**
 * Authenticate request via bearer token or ?token= query param.
 * Returns true if auth is valid (or if no token is configured).
 */
function authenticate(req: IncomingMessage, url: URL): boolean {
  if (!LEAD_DASHBOARD_TOKEN) return true; // No auth configured
  const bearer = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = url.searchParams.get('token');
  return bearer === LEAD_DASHBOARD_TOKEN || queryToken === LEAD_DASHBOARD_TOKEN;
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
function handleListLeads(db: Database.Database, url: URL, res: ServerResponse): void {
  const status = url.searchParams.get('status');
  const source = url.searchParams.get('source');
  const type = url.searchParams.get('type');
  const match = url.searchParams.get('match');
  const search = url.searchParams.get('search');
  const since = url.searchParams.get('since');
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10));
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) { conditions.push('l.status = ?'); params.push(status); }
  if (source) { conditions.push('l.source = ?'); params.push(source); }
  if (type) { conditions.push('l.signal_type = ?'); params.push(type); }
  if (match) { conditions.push('l.match_status = ?'); params.push(match); }
  if (since) { conditions.push('l.created_at >= ?'); params.push(since); }

  let fromClause = 'leads l';
  if (search) {
    fromClause = 'leads_fts f JOIN leads l ON l.id = f.rowid';
    conditions.push("leads_fts MATCH ?");
    params.push(`"${search.replace(/"/g, '""')}"`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total for pagination
  const countRow = db.prepare(
    `SELECT count(*) as total FROM ${fromClause} ${where}`
  ).get(...params) as { total: number };

  // Fetch leads
  const rows = db.prepare(
    `SELECT l.* FROM ${fromClause} ${where}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as LeadRow[];

  // Compute scores and attach
  const leads = rows.map(row => ({
    ...row,
    matched_ads: row.matched_ads ? JSON.parse(row.matched_ads as string) : [],
    score: scoreLead(row),
    score_tier: scoreTier(scoreLead(row)),
  }));

  // Sort by score if requested (default)
  const sort = url.searchParams.get('sort') || 'score';
  const order = url.searchParams.get('order') || 'desc';
  if (sort === 'score') {
    leads.sort((a, b) => order === 'desc' ? b.score - a.score : a.score - b.score);
  }

  json(res, { leads, total: countRow.total, limit, offset });
}

/**
 * GET /api/leads/stats — aggregate statistics
 */
function handleStats(db: Database.Database, res: ServerResponse): void {
  const total = (db.prepare('SELECT count(*) as n FROM leads').get() as any).n;
  const byStatus = db.prepare(
    'SELECT status, count(*) as n FROM leads GROUP BY status'
  ).all();
  const bySource = db.prepare(
    'SELECT source, count(*) as n FROM leads GROUP BY source'
  ).all();
  const byType = db.prepare(
    'SELECT signal_type, count(*) as n FROM leads GROUP BY signal_type'
  ).all();
  const byMatch = db.prepare(
    'SELECT match_status, count(*) as n FROM leads GROUP BY match_status'
  ).all();
  const newToday = (db.prepare(
    "SELECT count(*) as n FROM leads WHERE created_at >= date('now')"
  ).get() as any).n;
  const newThisWeek = (db.prepare(
    "SELECT count(*) as n FROM leads WHERE created_at >= date('now', '-7 days')"
  ).get() as any).n;

  json(res, { total, newToday, newThisWeek, byStatus, bySource, byType, byMatch });
}

/**
 * PATCH /api/leads/:id — update lead status
 * Body: { "status": "contacted" | "ignored" }
 */
function handleUpdateLead(
  db: Database.Database, id: number, body: string, res: ServerResponse
): void {
  try {
    const { status } = JSON.parse(body);
    if (!['new', 'contacted', 'ignored'].includes(status)) {
      json(res, { error: 'Invalid status. Use: new, contacted, ignored' }, 400);
      return;
    }
    const result = db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
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
  const rows = db.prepare('SELECT DISTINCT source FROM leads ORDER BY source').all();
  json(res, rows.map((r: any) => r.source));
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

export function startDashboardServer(port = LEAD_DASHBOARD_PORT): Promise<Server> {
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
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
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
        } else if (req.method === 'PATCH' && pathname.match(/^\/api\/leads\/\d+$/)) {
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
```

Key design decisions:
- **No Express dependency.** Uses Node.js built-in `http.createServer`. Zero additional deps.
- **Same process.** Runs inside the NanoClaw process, not a separate service.
- **WAL mode.** The lead scanner writes while the dashboard reads — SQLite WAL handles this safely.
- **Score computed on read.** Scores are not stored — computed per request so they reflect current time (freshness decay).
- **Auth via query param.** Mobile-friendly: Bjornar bookmarks `http://ip:3002/?token=xxx` on his phone.

- [ ] **Step 3: Write API tests**

Create `src/lead-dashboard.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import Database from 'better-sqlite3';
import { initLeadDb } from './lead-scanner.js';

// Test helpers
function insertTestLead(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const defaults = {
    source: 'finn_wanted',
    signal_type: 'demand',
    external_id: `test-${Math.random()}`,
    external_url: 'https://finn.no/123',
    title: 'Ønskes kjøpt: Volvo gravemaskin',
    description: 'Ser etter brukt gravemaskin',
    category: 'gravemaskin',
    price: null,
    contact_name: 'Test Person',
    contact_info: '99887766',
    published_at: '2026-04-14T00:00:00Z',
    match_status: 'has_match',
    matched_ads: '[]',
    price_diff_pct: null,
    status: 'new',
    created_at: new Date().toISOString(),
    ...overrides,
  };
  db.prepare(`INSERT INTO leads (source, signal_type, external_id, external_url,
    title, description, category, price, contact_name, contact_info, published_at,
    match_status, matched_ads, price_diff_pct, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    defaults.source, defaults.signal_type, defaults.external_id,
    defaults.external_url, defaults.title, defaults.description,
    defaults.category, defaults.price, defaults.contact_name,
    defaults.contact_info, defaults.published_at, defaults.match_status,
    defaults.matched_ads, defaults.price_diff_pct, defaults.status,
    defaults.created_at
  );
}

describe('Lead Dashboard API', () => {
  // Unit tests for the handler logic using in-memory DB.
  // Full integration tests (HTTP server) would be added if needed.

  let db: Database.Database;

  beforeEach(() => {
    db = initLeadDb(':memory:');
    insertTestLead(db, { external_id: 'lead-1', signal_type: 'demand', match_status: 'has_match' });
    insertTestLead(db, { external_id: 'lead-2', signal_type: 'supply', match_status: 'price_opportunity', price_diff_pct: 25 });
    insertTestLead(db, { external_id: 'lead-3', signal_type: 'demand', match_status: 'no_match', status: 'contacted' });
  });

  afterEach(() => {
    db.close();
  });

  it('queries leads with status filter', () => {
    const rows = db.prepare("SELECT * FROM leads WHERE status = 'new'").all();
    expect(rows).toHaveLength(2);
  });

  it('queries leads with source filter', () => {
    const rows = db.prepare("SELECT * FROM leads WHERE source = 'finn_wanted'").all();
    expect(rows).toHaveLength(3);
  });

  it('updates lead status', () => {
    const result = db.prepare("UPDATE leads SET status = 'contacted' WHERE id = 1").run();
    expect(result.changes).toBe(1);
    const row = db.prepare('SELECT status FROM leads WHERE id = 1').get() as any;
    expect(row.status).toBe('contacted');
  });

  it('gets stats', () => {
    const total = (db.prepare('SELECT count(*) as n FROM leads').get() as any).n;
    expect(total).toBe(3);
    const byType = db.prepare('SELECT signal_type, count(*) as n FROM leads GROUP BY signal_type').all();
    expect(byType).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lead-dashboard.test.ts src/lead-scoring.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lead-dashboard.ts src/lead-dashboard.test.ts src/config.ts
git commit -m "feat: add lead dashboard REST API with token auth"
```

---

### Task 3: Dashboard frontend

Create a single self-contained HTML file with embedded CSS and JS. No build step, no framework. Mobile-first design.

**Files:**
- Create: `dashboard/index.html`

- [ ] **Step 1: Create the dashboard HTML**

Create `dashboard/index.html`. The file should be a single self-contained HTML page (~400-500 lines) with:

**Layout (mobile-first):**
- Top bar: "Lead Intelligence" title, last-updated timestamp, refresh button
- Stats row: 4 cards showing total leads, new today, demand signals, price opportunities
- Filter bar: dropdowns for source, signal type, match status, status. Date range picker. Search input.
- Lead list: card-based layout (not a table — cards work better on mobile)
- Each card shows: score badge (color-coded hot/warm/cold), title, source, type, match status, price diff (if applicable), age, action buttons (mark contacted / ignore)

**Styling:**
- Dark theme (easier on eyes, modern look)
- CSS variables for colors: `--hot: #ef4444`, `--warm: #f59e0b`, `--cold: #6b7280`
- Score badges: circular, color-coded by tier
- Cards: rounded corners, subtle border, slightly elevated
- Responsive: single column on mobile, 2 columns on tablet+
- No external CSS frameworks — all inline/embedded

**JavaScript:**
- On load: fetch `/api/leads/stats` and `/api/leads?limit=50` with token from URL
- Token extracted from `window.location.search` and stored in memory
- Filter changes trigger re-fetch with appropriate query params
- Action buttons (contacted/ignored) send `PATCH /api/leads/:id` and update card in-place
- Auto-refresh every 60 seconds
- Pull-to-refresh on mobile (optional, nice-to-have)

**Key implementation notes:**
```javascript
// Token handling — extract from URL, use for all API calls
const params = new URLSearchParams(window.location.search);
const TOKEN = params.get('token') || '';

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Score badge rendering
function scoreBadge(score, tier) {
  const colors = { hot: '#ef4444', warm: '#f59e0b', cold: '#6b7280' };
  return `<span class="score-badge" style="background:${colors[tier]}">${score}</span>`;
}
```

- [ ] **Step 2: Verify the dashboard loads**

Start the dashboard server locally and open in browser:
```bash
LEAD_DASHBOARD_TOKEN=test npm run dev &
# Open http://localhost:3002/?token=test
```

Verify: stats load, leads display, filters work, action buttons work.

- [ ] **Step 3: Commit**

```bash
git add dashboard/index.html
git commit -m "feat: add lead intelligence dashboard frontend"
```

---

### Task 4: Automated Telegram notifications

Send Telegram alerts when high-value leads are detected and a daily summary.

**Files:**
- Create: `src/lead-notifications.ts`
- Create: `src/lead-notifications.test.ts`
- Modify: `src/lead-scanner.ts`

- [ ] **Step 1: Create notification module**

Create `src/lead-notifications.ts`:

```typescript
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

import { resolveLeadDbPath, initLeadDb } from './lead-scanner.js';
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
function formatLeadAlert(lead: LeadRow & { score: number }): string {
  const emoji = lead.signal_type === 'demand' ? '🎯' : '💰';
  const tier = scoreTier(lead.score);
  const tierEmoji = tier === 'hot' ? '🔥' : tier === 'warm' ? '🟡' : '⚪';
  const lines = [
    `${emoji} *Ny lead* (score: ${lead.score} ${tierEmoji})`,
    ``,
    `*${lead.title}*`,
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
export async function notifyNewHotLeads(db: Database.Database, since: string): Promise<number> {
  const b = getBot();
  if (!b) return 0;

  const rows = db.prepare(
    `SELECT * FROM leads WHERE created_at >= ? AND status = 'new' ORDER BY created_at DESC`
  ).all(since) as LeadRow[];

  let sent = 0;
  for (const row of rows) {
    const score = scoreLead(row);
    if (score >= HOT_LEAD_THRESHOLD) {
      const msg = formatLeadAlert({ ...row, score });
      try {
        await b.api.sendMessage(NOTIFY_CHAT_ID, msg, { parse_mode: 'Markdown' });
        sent++;
      } catch (err) {
        logger.error({ err, leadId: row.id }, 'Failed to send lead notification');
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

  const total = (db.prepare('SELECT count(*) as n FROM leads').get() as any).n;
  const newToday = (db.prepare(
    'SELECT count(*) as n FROM leads WHERE created_at >= ?'
  ).get(todayStr) as any).n;
  const hotToday = db.prepare(
    `SELECT * FROM leads WHERE created_at >= ? AND status = 'new'`
  ).all(todayStr) as LeadRow[];

  const hotCount = hotToday.filter(l => scoreLead(l) >= HOT_LEAD_THRESHOLD).length;
  const demandCount = (db.prepare(
    "SELECT count(*) as n FROM leads WHERE created_at >= ? AND signal_type = 'demand'"
  ).get(todayStr) as any).n;
  const priceOppCount = (db.prepare(
    "SELECT count(*) as n FROM leads WHERE created_at >= ? AND match_status = 'price_opportunity'"
  ).get(todayStr) as any).n;

  const lines = [
    `📊 *Daglig lead-oppsummering*`,
    ``,
    `Nye leads i dag: *${newToday}*`,
    `🔥 Hot leads: *${hotCount}*`,
    `🎯 Kjøpssignaler: *${demandCount}*`,
    `💰 Prismuligheter: *${priceOppCount}*`,
    ``,
    `Totalt i databasen: ${total}`,
  ];

  if (hotCount > 0) {
    lines.push(``, `Se dashboard for detaljer.`);
  }

  try {
    await b.api.sendMessage(NOTIFY_CHAT_ID, lines.join('\n'), { parse_mode: 'Markdown' });
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
```

- [ ] **Step 2: Write notification tests**

Create `src/lead-notifications.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initLeadDb } from './lead-scanner.js';

// Test the notification formatting logic (not the actual Telegram send)
import { scoreLead, scoreTier } from './lead-scoring.js';

describe('Lead notification logic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initLeadDb(':memory:');
  });

  afterEach(() => db.close());

  it('identifies hot leads from recent scans', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, created_at, contact_info, contact_name)
      VALUES ('finn_wanted', 'demand', 'test-1', 'Ønskes: Volvo EC220', 'Test',
      'has_match', '[]', 'new', ?, '99887766', 'Ola')`).run(now);

    const rows = db.prepare(
      "SELECT * FROM leads WHERE created_at >= ? AND status = 'new'"
    ).all(now) as any[];

    const hot = rows.filter(r => scoreLead(r) >= 60);
    expect(hot).toHaveLength(1);
    expect(scoreTier(scoreLead(hot[0]))).toBe('hot');
  });

  it('does not flag cold leads', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO leads (source, signal_type, external_id, title, description,
      match_status, matched_ads, status, created_at)
      VALUES ('mascus', 'supply', 'test-2', 'Gammel maskin', 'Test',
      'no_match', '[]', 'new', ?)`).run(oldDate);

    const rows = db.prepare("SELECT * FROM leads WHERE status = 'new'").all() as any[];
    const hot = rows.filter(r => scoreLead(r) >= 60);
    expect(hot).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Integrate notifications into lead scanner**

In `src/lead-scanner.ts`, modify `scanAllSources()` to call the notification hook:

```typescript
// At the top, add import:
import { notifyNewHotLeads } from './lead-notifications.js';

// In scanAllSources(), record the start time and call notify at the end:
async function scanAllSources(db: Database.Database): Promise<void> {
  const scanStart = new Date().toISOString();
  console.log('[lead-scanner] Starting scan...');
  // ... existing scan code ...
  console.log(`[lead-scanner] Scan complete: ${totalNew} new leads total`);

  // Notify on new hot leads
  if (totalNew > 0) {
    try {
      await notifyNewHotLeads(db, scanStart);
    } catch (err) {
      console.error(`[lead-scanner] Notification error: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lead-notifications.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lead-notifications.ts src/lead-notifications.test.ts src/lead-scanner.ts
git commit -m "feat: add Telegram notifications for hot leads and daily summaries"
```

---

### Task 5: Wire everything into NanoClaw

Start the dashboard server and notification scheduler from `src/index.ts`.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Start dashboard server in main()**

In `src/index.ts`, add after the lead scanner spawn (around the existing `leadScanScript` block):

```typescript
import { startDashboardServer } from './lead-dashboard.js';
import { scheduleDailySummary } from './lead-notifications.js';
import { initLeadDb, resolveLeadDbPath } from './lead-scanner.js';

// Inside main(), after lead scanner is spawned:

// Start lead dashboard
if (process.env.LEAD_DASHBOARD_TOKEN) {
  try {
    await startDashboardServer();
    logger.info('Lead dashboard available on port ' + (process.env.LEAD_DASHBOARD_PORT || 3002));
  } catch (err) {
    logger.error({ err }, 'Failed to start lead dashboard');
  }
}

// Start daily summary scheduler
if (process.env.LEAD_NOTIFY_CHAT_ID && process.env.TELEGRAM_BOT_TOKEN) {
  try {
    const leadDb = initLeadDb(resolveLeadDbPath());
    scheduleDailySummary(leadDb);
    logger.info('Lead daily summary scheduler started');
  } catch (err) {
    logger.error({ err }, 'Failed to start lead notification scheduler');
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean build, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire dashboard server and notification scheduler into NanoClaw"
```

---

### Task 6: Deploy and configure on VPS

Deploy the dashboard and configure environment variables.

- [ ] **Step 1: Add environment variables on VPS**

```bash
ssh root@204.168.178.32 'cat >> /opt/assistent/.env << EOF

# Lead Dashboard
LEAD_DASHBOARD_PORT=3002
LEAD_DASHBOARD_TOKEN=<generate-a-random-token>

# Lead Notifications
LEAD_NOTIFY_CHAT_ID=<bjornars-telegram-chat-id>
LEAD_SUMMARY_HOUR=7
EOF'
```

- [ ] **Step 2: Open firewall port**

```bash
ssh root@204.168.178.32 'ufw allow 3002/tcp comment "Lead dashboard"'
```

- [ ] **Step 3: Deploy**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && systemctl restart nanoclaw'
```

- [ ] **Step 4: Verify dashboard loads**

Open `http://204.168.178.32:3002/?token=<token>` in browser. Verify:
1. Stats cards show correct numbers
2. Lead cards render with scores
3. Filters work
4. Action buttons update lead status
5. Works on mobile (test on phone)

- [ ] **Step 5: Verify notifications**

Trigger a manual scan and check Telegram for hot lead alerts:
```bash
ssh root@204.168.178.32 'journalctl -u nanoclaw --no-pager -n 20 | grep notification'
```

- [ ] **Step 6: Commit deploy notes**

```bash
git add .env.example  # Document new env vars (never commit actual .env)
git commit -m "docs: add lead dashboard env vars to .env.example"
```

---

### Task 7 (spec only): Auto-outreach templates

This is a future consideration. Spec the design, do not implement.

**Design notes for future implementation:**

1. **Template system:** Markdown templates in `groups/ats/templates/` per signal type:
   - `demand-has-match.md` — "Vi har det du leter etter" with matched ads
   - `demand-no-match.md` — "Vi kan hjelpe deg finne det" (softer)
   - `price-opportunity.md` — Internal notification to Bjornar about buy opportunity

2. **Approval workflow:**
   - Lead scanner detects hot demand lead with match
   - System generates draft email from template, filling in lead details and matched ads
   - Sends Telegram message to Bjornar: "Draft klar for [lead title]. Godkjenn?"
   - Bjornar replies "ok" or "skip"
   - On approval: email sent via Gmail channel
   - On skip: lead marked as "skipped"

3. **Safeguards:**
   - Never send without explicit human approval
   - Rate limit: max 5 outreach emails per day
   - Cool-off: never contact same person twice within 30 days
   - All outreach logged in leads table (new status: "outreach_sent")

4. **Required changes:**
   - New `outreach_templates` table or file-based templates
   - New statuses: `draft_ready`, `outreach_sent`, `outreach_skipped`
   - Telegram inline keyboard for approve/reject buttons
   - Gmail draft creation and send-on-approval

This will be implemented in a later phase after the dashboard and notifications prove their value.

---

## Environment Variables Summary

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LEAD_DASHBOARD_PORT` | No | `3002` | Port for the dashboard HTTP server |
| `LEAD_DASHBOARD_TOKEN` | Yes | — | Bearer token for dashboard auth |
| `LEAD_NOTIFY_CHAT_ID` | No | — | Telegram chat ID for lead notifications |
| `LEAD_SUMMARY_HOUR` | No | `7` | Hour (0-23) to send daily summary |
| `TELEGRAM_BOT_TOKEN` | Exists | — | Already configured for Telegram channel |

## Security Notes

- Dashboard token is a shared secret — good enough for a single-user internal tool. If more users are added later, upgrade to per-user tokens.
- Dashboard binds to `0.0.0.0` so it's accessible externally. The firewall (`ufw`) restricts to port 3002 only.
- Consider adding HTTPS via Caddy reverse proxy if the dashboard will be used over untrusted networks. For now, the VPS is accessed directly and the token provides auth.
- The dashboard opens the SQLite database in WAL mode (read-only intent). Concurrent writes from the scanner are safe.
