/**
 * Cowork API — Outlook bridge for the Claude desktop agent ("Cowork").
 *
 * Exposes a small, authenticated HTTP surface over the existing Outlook/Graph
 * integration so Cowork can search, read, and draft mail for magnus@allvit.no
 * without re-implementing OAuth.
 *
 * Drafts only. This file never calls Microsoft Graph /sendMail — every write
 * path targets /messages (creates a draft) or /messages/{id}/createReply
 * (returns a draft). Enforced by code review + test coverage.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { timingSafeEqual } from 'crypto';

import { COWORK_API_PORT, COWORK_API_TOKEN } from './config.js';
import { getOutlookAccessToken } from './channels/outlook.js';
import { sanitizeEmailForAgent } from './skills/email-sanitizer.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const TOKEN_TTL_MS = 55 * 60 * 1000; // access tokens live ~60 min
const PREVIEW_LEN = 300;
const MAX_BODY = 256 * 1024;
const MAX_TOP = 50;

// --- Rate limiting ---------------------------------------------------------

interface RateEntry {
  count: number;
  windowStart: number;
}

const rateLimits = new Map<string, RateEntry>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// --- Auth ------------------------------------------------------------------

// Constant-time token compare. On length mismatch we still perform a
// timingSafeEqual against a fixed-size pad so the rejection path doesn't
// leak the configured token length.
function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return false;
  }
  if (!COWORK_API_TOKEN) {
    return false;
  }
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(COWORK_API_TOKEN);
  if (presented.length !== expected.length) {
    // Dummy compare to equalise timing with the valid-length branch.
    timingSafeEqual(Buffer.alloc(expected.length), Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(presented, expected);
}

// --- Outlook creds + token cache -------------------------------------------

interface OutlookCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function loadOutlookCreds(): OutlookCreds {
  const envVars = readEnvFile([
    'OUTLOOK_TENANT_ID',
    'OUTLOOK_CLIENT_ID',
    'OUTLOOK_CLIENT_SECRET',
    'OUTLOOK_REFRESH_TOKEN',
  ]);
  return {
    tenantId: process.env.OUTLOOK_TENANT_ID || envVars.OUTLOOK_TENANT_ID || '',
    clientId: process.env.OUTLOOK_CLIENT_ID || envVars.OUTLOOK_CLIENT_ID || '',
    clientSecret:
      process.env.OUTLOOK_CLIENT_SECRET || envVars.OUTLOOK_CLIENT_SECRET || '',
    refreshToken:
      process.env.OUTLOOK_REFRESH_TOKEN || envVars.OUTLOOK_REFRESH_TOKEN || '',
  };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getGraphAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }
  const creds = loadOutlookCreds();
  if (!creds.refreshToken) {
    throw new Error('Outlook credentials not configured');
  }
  const token = await getOutlookAccessToken(
    creds.tenantId,
    creds.clientId,
    creds.clientSecret,
    creds.refreshToken,
  );
  cachedToken = { token, expiresAt: now + TOKEN_TTL_MS };
  return token;
}

function invalidateTokenCache(): void {
  cachedToken = null;
}

// --- Graph request helpers -------------------------------------------------

type GraphJson = Record<string, unknown>;

async function graphRequest(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: GraphJson,
): Promise<GraphJson> {
  const token = await getGraphAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Token likely expired early — drop cache so next request refetches.
    invalidateTokenCache();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${res.status}: ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return {};
  return (await res.json()) as GraphJson;
}

// --- HTML → text -----------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Shapes ----------------------------------------------------------------

interface Address {
  name: string;
  email: string;
}

interface MailEnvelope {
  id: string;
  conversationId: string;
  subject: string;
  from: Address;
  to: Address[];
  receivedAt: string;
  preview: string;
}

interface FullMessage extends MailEnvelope {
  bodyText: string;
  bodyHtml: string | null;
}

function toAddress(recip: unknown): Address {
  const r = recip as { emailAddress?: { name?: string; address?: string } };
  return {
    name: r?.emailAddress?.name || '',
    email: r?.emailAddress?.address || '',
  };
}

function toEnvelope(msg: Record<string, unknown>): MailEnvelope {
  const toRecips = Array.isArray(msg.toRecipients)
    ? (msg.toRecipients as unknown[])
    : [];
  const preview = typeof msg.bodyPreview === 'string' ? msg.bodyPreview : '';
  return {
    id: String(msg.id || ''),
    conversationId: String(msg.conversationId || ''),
    subject: String(msg.subject || ''),
    from: toAddress(msg.from),
    to: toRecips.map(toAddress),
    receivedAt: String(msg.receivedDateTime || ''),
    preview: preview.slice(0, PREVIEW_LEN),
  };
}

function toFullMessage(msg: Record<string, unknown>): FullMessage {
  const envelope = toEnvelope(msg);
  const bodyField = (msg.body || {}) as { contentType?: string; content?: string };
  const contentType = bodyField.contentType || 'text';
  const rawContent = bodyField.content || '';
  const bodyText =
    contentType === 'html' ? stripHtml(rawContent) : rawContent;
  const sanitized = sanitizeEmailForAgent({
    from: `${envelope.from.name} <${envelope.from.email}>`,
    subject: envelope.subject,
    body: bodyText,
  });
  return {
    ...envelope,
    bodyText: sanitized,
    bodyHtml: contentType === 'html' ? rawContent : null,
  };
}

// --- Route handlers --------------------------------------------------------

async function handleSearch(q: string, top: number): Promise<MailEnvelope[]> {
  const params = new URLSearchParams({
    $search: `"${q}"`,
    $top: String(top),
    $select:
      'id,subject,from,toRecipients,receivedDateTime,conversationId,bodyPreview',
  });
  const data = await graphRequest('GET', `/messages?${params}`);
  const items = Array.isArray(data.value) ? (data.value as unknown[]) : [];
  return items.map((i) => toEnvelope(i as Record<string, unknown>));
}

async function handleGetMessage(id: string): Promise<FullMessage> {
  const data = await graphRequest(
    'GET',
    `/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,receivedDateTime,conversationId,bodyPreview,body`,
  );
  return toFullMessage(data);
}

async function handleGetThread(
  conversationId: string,
): Promise<FullMessage[]> {
  const escaped = conversationId.replace(/'/g, "''");
  const params = new URLSearchParams({
    $filter: `conversationId eq '${escaped}'`,
    $orderby: 'receivedDateTime',
    $select:
      'id,subject,from,toRecipients,receivedDateTime,conversationId,bodyPreview,body',
  });
  const data = await graphRequest('GET', `/messages?${params}`);
  const items = Array.isArray(data.value) ? (data.value as unknown[]) : [];
  return items.map((i) => toFullMessage(i as Record<string, unknown>));
}

interface DraftRequest {
  subject?: unknown;
  body?: unknown;
  to?: unknown;
  cc?: unknown;
  replyToMessageId?: unknown;
}

interface DraftResult {
  id: string;
  webLink?: string;
}

async function handleCreateDraft(input: DraftRequest): Promise<DraftResult> {
  if (typeof input.subject !== 'string' || !input.subject.trim()) {
    throw new Error('Missing subject');
  }
  if (typeof input.body !== 'string' || !input.body) {
    throw new Error('Missing body');
  }
  if (!Array.isArray(input.to) || input.to.length === 0) {
    throw new Error('At least one recipient required');
  }
  const toList = input.to.filter((v): v is string => typeof v === 'string');
  const ccList = Array.isArray(input.cc)
    ? input.cc.filter((v): v is string => typeof v === 'string')
    : [];
  if (toList.length === 0) {
    throw new Error('At least one recipient required');
  }

  const toRecipients = toList.map((email) => ({
    emailAddress: { address: email },
  }));
  const ccRecipients = ccList.map((email) => ({
    emailAddress: { address: email },
  }));

  // Reply path: /createReply returns a pre-threaded draft; we then PATCH
  // the caller's subject/body/recipients onto it.
  if (typeof input.replyToMessageId === 'string' && input.replyToMessageId) {
    const reply = await graphRequest(
      'POST',
      `/messages/${encodeURIComponent(input.replyToMessageId)}/createReply`,
      {},
    );
    const replyId = typeof reply.id === 'string' ? reply.id : '';
    const patchBody: GraphJson = {
      subject: input.subject,
      body: { contentType: 'text', content: input.body },
      toRecipients,
    };
    if (ccRecipients.length > 0) patchBody.ccRecipients = ccRecipients;
    await graphRequest('PATCH', `/messages/${encodeURIComponent(replyId)}`, patchBody);
    logger.info(
      { draftId: replyId, replyTo: input.replyToMessageId },
      'Cowork: reply draft created',
    );
    return { id: replyId };
  }

  // Fresh draft — POST /messages creates a draft (isDraft:true by default on
  // this endpoint). We never POST to /sendMail.
  const payload: GraphJson = {
    subject: input.subject,
    body: { contentType: 'text', content: input.body },
    toRecipients,
  };
  if (ccRecipients.length > 0) payload.ccRecipients = ccRecipients;

  const created = await graphRequest('POST', '/messages', payload);
  const id = typeof created.id === 'string' ? created.id : '';
  const webLink = typeof created.webLink === 'string' ? created.webLink : undefined;
  logger.info({ draftId: id, to: toList[0] }, 'Cowork: draft created');
  return { id, webLink };
}

// --- HTTP plumbing ---------------------------------------------------------

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function startCoworkApiServer(port = COWORK_API_PORT): Promise<Server> {
  if (!COWORK_API_TOKEN) {
    return Promise.reject(new Error('COWORK_API_TOKEN is not set'));
  }
  const host = process.env.COWORK_API_BIND || '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(
          req.url || '/',
          `http://${req.headers.host || 'localhost'}`,
        );
        const pathname = url.pathname;
        const ip = getClientIp(req);

        if (req.method === 'GET' && pathname === '/healthz') {
          json(res, { ok: true });
          return;
        }

        if (!checkAuth(req)) {
          json(res, { error: 'Unauthorized' }, 401);
          return;
        }

        if (isRateLimited(ip)) {
          res.setHeader('Retry-After', '60');
          json(res, { error: 'Too many requests' }, 429);
          return;
        }

        if (req.method === 'GET' && pathname === '/api/cowork/mail/search') {
          const q = url.searchParams.get('q');
          const top = Math.min(
            parseInt(url.searchParams.get('top') || '20', 10) || 20,
            MAX_TOP,
          );
          if (!q) {
            json(res, { error: 'Missing q' }, 400);
            return;
          }
          const messages = await handleSearch(q, top);
          json(res, { messages });
          return;
        }

        const threadMatch = pathname.match(
          /^\/api\/cowork\/mail\/thread\/(.+)$/,
        );
        if (req.method === 'GET' && threadMatch) {
          const conversationId = decodeURIComponent(threadMatch[1]);
          const messages = await handleGetThread(conversationId);
          json(res, { messages });
          return;
        }

        const messageMatch = pathname.match(
          /^\/api\/cowork\/mail\/message\/(.+)$/,
        );
        if (req.method === 'GET' && messageMatch) {
          const id = decodeURIComponent(messageMatch[1]);
          const msg = await handleGetMessage(id);
          json(res, msg);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/cowork/mail/draft') {
          let parsed: DraftRequest;
          try {
            const body = await readBody(req);
            parsed = JSON.parse(body) as DraftRequest;
          } catch (err) {
            logger.warn({ err }, 'Cowork: invalid draft body');
            json(res, { error: 'Invalid JSON' }, 400);
            return;
          }
          try {
            const result = await handleCreateDraft(parsed);
            json(res, result, 201);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ err: msg }, 'Cowork: draft rejected');
            json(res, { error: msg }, 400);
          }
          return;
        }

        json(res, { error: 'Not found' }, 404);
      } catch (err) {
        logger.error({ err, url: req.url }, 'Cowork API: request error');
        json(res, { error: 'Internal server error' }, 500);
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Cowork API server started');
      resolve(server);
    });
    server.on('error', reject);
  });
}

// Exported for testing.
export {
  rateLimits as _rateLimits,
  isRateLimited as _isRateLimited,
  checkAuth as _checkAuth,
  handleSearch as _handleSearch,
  handleGetMessage as _handleGetMessage,
  handleGetThread as _handleGetThread,
  handleCreateDraft as _handleCreateDraft,
  toEnvelope as _toEnvelope,
  toFullMessage as _toFullMessage,
  invalidateTokenCache as _invalidateTokenCache,
};
