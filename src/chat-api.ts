/**
 * Public Chat API for NanoClaw
 * HTTP server for website chat widgets. Uses Claude via Anthropic SDK
 * with ats_feed/lbs_feed tools only — no admin tools, no email drafts.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { executeAtsFeed } from './direct-agent.js';
import { logger } from './logger.js';

// --- Configuration ---

const CHAT_API_PORT = parseInt(process.env.CHAT_API_PORT || '3003', 10);

const DEFAULT_ORIGINS =
  'https://ats.no,https://landbrukssalg.no,http://localhost:3000';
const ALLOWED_ORIGINS = new Set(
  (process.env.CHAT_ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(',')
    .map((o) => o.trim()),
);

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_TURNS = 10;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGES_PER_SESSION = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // requests per window per IP

type SiteId = 'ats' | 'lbs';

// --- Session store ---

interface ChatSession {
  id: string;
  site: SiteId;
  messages: Anthropic.MessageParam[];
  lastActivity: number;
}

const sessions = new Map<string, ChatSession>();

// --- Rate limiting ---

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

// --- CORS ---

function getCorsOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (!origin) return '*'; // Allow requests with no origin (file://, curl, etc.)
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  return null;
}

function setCorsHeaders(res: ServerResponse, origin: string | null): void {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// --- Tool definitions (public-safe subset) ---

const ATS_TOOL: Anthropic.Tool = {
  name: 'ats_feed',
  description:
    'Query the ATS Norway product database. Commands: list [count], get <id>, search <query>.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'The command to run: list, get, or search',
        enum: ['list', 'get', 'search'],
      },
      argument: {
        type: 'string',
        description:
          'Optional argument for the command (count for list, id for get, query for search)',
      },
    },
    required: ['command'],
  },
};

const LBS_TOOL: Anthropic.Tool = {
  name: 'lbs_feed',
  description:
    'Query the Landbrukssalg.no agricultural equipment database. Commands: list [count], get <id>, search <query>, categories.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'The command to run: list, get, search, or categories',
        enum: ['list', 'get', 'search', 'categories'],
      },
      argument: {
        type: 'string',
        description:
          'Argument for the command (count for list, id for get, query for search)',
      },
    },
    required: ['command'],
  },
};

function getToolsForSite(site: SiteId): Anthropic.Tool[] {
  if (site === 'ats') return [ATS_TOOL];
  if (site === 'lbs') return [LBS_TOOL];
  return [ATS_TOOL, LBS_TOOL];
}

// --- System prompt ---

function loadSystemPrompt(site: SiteId): string {
  const groupFolder = site === 'ats' ? 'chat-ats' : 'chat-lbs';
  const groupPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  if (fs.existsSync(groupPath)) {
    return fs.readFileSync(groupPath, 'utf-8');
  }
  return `You are a helpful assistant for ${site === 'ats' ? 'ATS Norway' : 'Landbrukssalg AS'}. Help customers find machinery and equipment.`;
}

// --- Tool execution (public subset only) ---

async function executeChatTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (toolName === 'ats_feed') {
    return executeAtsFeed(
      input.command as string,
      input.argument as string | undefined,
    );
  }

  if (toolName === 'lbs_feed') {
    const { execFile } = await import('child_process');
    const scriptPath = path.join(
      process.cwd(),
      'container',
      'skills',
      'lbs-feed',
      'lbs-feed.sh',
    );
    if (!fs.existsSync(scriptPath)) {
      return 'Error: lbs-feed.sh not found';
    }
    return new Promise((resolve) => {
      const args = [input.command as string];
      if (input.argument) args.push(input.argument as string);
      execFile(
        scriptPath,
        args,
        { timeout: 30_000 },
        (error, stdout, stderr) => {
          if (error) resolve(`Error: ${stderr || error.message}`);
          else resolve(stdout || 'No results');
        },
      );
    });
  }

  return `Unknown tool: ${toolName}`;
}

// --- Chat handler ---

async function handleChat(
  body: string,
  clientIp: string,
): Promise<{ status: number; data: unknown }> {
  let parsed: { message?: string; sessionId?: string; site?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, data: { error: 'Invalid JSON' } };
  }

  const { message, sessionId: reqSessionId, site: siteRaw } = parsed;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return { status: 400, data: { error: 'Missing or empty "message" field' } };
  }

  const site: SiteId = siteRaw === 'ats' || siteRaw === 'lbs' ? siteRaw : 'ats';

  // Rate limiting
  if (isRateLimited(clientIp)) {
    return {
      status: 429,
      data: { error: 'Too many requests. Please wait a moment.' },
    };
  }

  // Session management
  let session: ChatSession;
  if (reqSessionId && sessions.has(reqSessionId)) {
    session = sessions.get(reqSessionId)!;
    session.lastActivity = Date.now();

    // If session hits max messages, start fresh
    if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
      session.messages = [];
    }
  } else {
    session = {
      id: randomUUID(),
      site,
      messages: [],
      lastActivity: Date.now(),
    };
    sessions.set(session.id, session);
  }

  // Add user message to conversation history
  session.messages.push({ role: 'user', content: message.trim() });

  try {
    const client = new Anthropic();
    const systemPrompt = loadSystemPrompt(session.site);
    const tools = getToolsForSite(session.site);

    let turns = 0;
    const messages = [...session.messages];

    while (turns < MAX_TOOL_TURNS) {
      turns++;

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools,
        messages,
      });

      const textParts: string[] = [];
      const toolUseBlocks: Anthropic.ContentBlock[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      // End turn — return final text
      if (response.stop_reason === 'end_turn') {
        const reply = textParts.join('\n').trim();
        // Save assistant response in session history
        session.messages.push({ role: 'assistant', content: reply || '...' });
        return {
          status: 200,
          data: { reply: reply || '...', sessionId: session.id },
        };
      }

      // Tool use — execute and continue loop
      if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          if (block.type === 'tool_use') {
            try {
              const result = await executeChatTool(
                block.name,
                block.input as Record<string, unknown>,
              );
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              });
            } catch (err) {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error: ${errorMessage}`,
                is_error: true,
              });
            }
          }
        }

        messages.push({ role: 'user', content: toolResults });
      } else {
        // Unexpected stop reason
        const reply = textParts.join('\n').trim();
        session.messages.push({ role: 'assistant', content: reply || '...' });
        return {
          status: 200,
          data: { reply: reply || '...', sessionId: session.id },
        };
      }
    }

    // Max turns — return whatever we have
    return {
      status: 200,
      data: {
        reply: 'Beklager, jeg trenger litt mer tid. Proov igjen.',
        sessionId: session.id,
      },
    };
  } catch (err) {
    logger.error({ err }, 'Chat API: Claude call failed');
    return { status: 500, data: { error: 'Internal server error' } };
  }
}

// --- Session cleanup ---

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startSessionCleanup(): void {
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(id);
        cleaned++;
      }
    }
    // Also clean stale rate limit entries
    for (const [ip, entry] of rateLimits) {
      if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
        rateLimits.delete(ip);
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Chat API: expired sessions cleaned');
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
}

// --- HTTP server ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 64 * 1024; // 64 KB
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

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function startChatApiServer(port = CHAT_API_PORT): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );
      const pathname = url.pathname;
      const origin = getCorsOrigin(req);
      setCorsHeaders(res, origin);

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Serve test page
      if (req.method === 'GET' && (pathname === '/test' || pathname === '/test/lbs')) {
        const site = pathname === '/test/lbs' ? 'lbs' : 'ats';
        const color = site === 'ats' ? '#1a56db' : '#15803d';
        const name = site === 'ats' ? 'ATS Norway' : 'Landbrukssalg';
        const html = `<!DOCTYPE html><html lang="no"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${name} — Chat Test</title><style>body{font-family:system-ui,sans-serif;padding:40px;background:#f5f5f5}h1{color:${color}}p{color:#666;max-width:600px;line-height:1.6}</style></head><body><h1>${name}</h1><p>Testside for chat-widget. Klikk på boblen nede til høyre.</p><p>Prøv: "Har dere noen gravemaskiner?" eller "Finn traktorer under 500 000"</p><script src="/widget.js" data-site="${site}"></script></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // Serve chat widget JS
      if (req.method === 'GET' && pathname === '/widget.js') {
        const widgetPath = path.join(process.cwd(), 'widget', 'chat-widget.js');
        try {
          const js = fs.readFileSync(widgetPath, 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(js);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Widget not found');
        }
        return;
      }

      // Health check
      if (req.method === 'GET' && pathname === '/api/health') {
        json(res, { ok: true, sessions: sessions.size });
        return;
      }

      // Chat endpoint
      if (req.method === 'POST' && pathname === '/api/chat') {
        try {
          const body = await readBody(req);
          const clientIp = getClientIp(req);
          const result = await handleChat(body, clientIp);
          json(res, result.data, result.status);
        } catch (err) {
          logger.error({ err }, 'Chat API: request error');
          json(res, { error: 'Internal server error' }, 500);
        }
        return;
      }

      // Not found
      json(res, { error: 'Not found' }, 404);
    });

    startSessionCleanup();

    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Chat API server started');
      resolve(server);
    });

    server.on('error', reject);

    // Cleanup on server close
    server.on('close', () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    });
  });
}

// Exported for testing
export {
  sessions as _sessions,
  rateLimits as _rateLimits,
  handleChat as _handleChat,
  isRateLimited as _isRateLimited,
  getCorsOrigin as _getCorsOrigin,
  loadSystemPrompt as _loadSystemPrompt,
  getToolsForSite as _getToolsForSite,
  executeChatTool as _executeChatTool,
  SESSION_TTL_MS,
  MAX_MESSAGES_PER_SESSION,
};
