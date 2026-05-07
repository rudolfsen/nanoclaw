import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '# Test Chat CLAUDE.md'),
    },
  };
});

// Mock direct-agent executeAtsFeed
vi.mock('./direct-agent.js', () => ({
  executeAtsFeed: vi.fn(async () => 'Mock ATS result'),
}));

// Mock the Anthropic SDK
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

import Database from 'better-sqlite3';

import {
  _sessions as sessions,
  _rateLimits as rateLimits,
  _handleChat as handleChat,
  _isRateLimited as isRateLimited,
  _getCorsOrigin as getCorsOrigin,
  _loadSystemPrompt as loadSystemPrompt,
  _getToolsForSite as getToolsForSite,
  _renderMarkdown as renderMarkdown,
  _logSession as logSession,
  _initChatContactsTable as initChatContactsTable,
  _cleanupExpiredSessions as cleanupExpiredSessions,
  _flushAllSessions as flushAllSessions,
  _setContactDbForTest as setContactDbForTest,
  _executeChatTool as executeChatTool,
  MAX_MESSAGES_PER_SESSION,
  SESSION_TTL_MS,
} from './chat-api.js';

describe('Chat API', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    sessions.clear();
    rateLimits.clear();
  });

  describe('getToolsForSite', () => {
    it('returns only LBS tools (lbs_feed + save_contact) for lbs site', () => {
      const tools = getToolsForSite('lbs');
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['lbs_feed', 'save_contact']);
    });

    it('returns only ATS tools (ats_feed + save_contact) for ats site', () => {
      const tools = getToolsForSite('ats');
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['ats_feed', 'save_contact']);
    });

    it("does not leak the other site's feed", () => {
      const lbsNames = getToolsForSite('lbs').map((t) => t.name);
      const atsNames = getToolsForSite('ats').map((t) => t.name);
      expect(lbsNames).not.toContain('ats_feed');
      expect(atsNames).not.toContain('lbs_feed');
    });
  });

  describe('loadSystemPrompt', () => {
    it('reads CLAUDE.md from the correct group folder', () => {
      const prompt = loadSystemPrompt('ats');
      expect(prompt).toContain('Test Chat CLAUDE.md');
    });
  });

  describe('getCorsOrigin', () => {
    it('returns origin when allowed', () => {
      const req = { headers: { origin: 'http://localhost:3000' } };
      expect(getCorsOrigin(req as any)).toBe('http://localhost:3000');
    });

    it('returns null for disallowed origin', () => {
      const req = { headers: { origin: 'https://evil.com' } };
      expect(getCorsOrigin(req as any)).toBeNull();
    });

    it('returns * when no origin header', () => {
      const req = { headers: {} };
      expect(getCorsOrigin(req as any)).toBe('*');
    });
  });

  describe('isRateLimited', () => {
    it('allows first request', () => {
      expect(isRateLimited('1.2.3.4')).toBe(false);
    });

    it('blocks after 10 requests in a minute', () => {
      for (let i = 0; i < 10; i++) {
        isRateLimited('1.2.3.4');
      }
      expect(isRateLimited('1.2.3.4')).toBe(true);
    });

    it('tracks IPs independently', () => {
      for (let i = 0; i < 10; i++) {
        isRateLimited('1.2.3.4');
      }
      expect(isRateLimited('1.2.3.4')).toBe(true);
      expect(isRateLimited('5.6.7.8')).toBe(false);
    });
  });

  describe('handleChat', () => {
    it('returns 400 for invalid JSON', async () => {
      const result = await handleChat('not json', '1.2.3.4');
      expect(result.status).toBe(400);
      expect(result.data).toEqual({ error: 'Invalid JSON' });
    });

    it('returns 400 for missing message', async () => {
      const result = await handleChat('{}', '1.2.3.4');
      expect(result.status).toBe(400);
      expect(result.data).toEqual({
        error: 'Missing or empty "message" field',
      });
    });

    it('returns 429 when rate limited', async () => {
      // Exhaust rate limit
      for (let i = 0; i < 11; i++) {
        isRateLimited('10.0.0.1');
      }
      const result = await handleChat(
        JSON.stringify({ message: 'Hello', site: 'ats' }),
        '10.0.0.1',
      );
      expect(result.status).toBe(429);
    });

    it('creates session and returns reply on success', async () => {
      mockCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Vi har mange maskiner!' }],
      });

      const result = await handleChat(
        JSON.stringify({ message: 'Har dere Volvo-gravere?', site: 'ats' }),
        '1.2.3.4',
      );

      expect(result.status).toBe(200);
      const data = result.data as { reply: string; sessionId: string };
      expect(data.reply).toContain('Vi har mange maskiner!');
      expect(data.reply).toMatch(/^<p>/);
      expect(data.sessionId).toBeTruthy();

      // Session should exist
      expect(sessions.has(data.sessionId)).toBe(true);
    });

    it('honors client-provided sessionId so widget-generated IDs persist history', async () => {
      // The widget generates its own sessionId (e.g. "sess_abc123") and stores
      // it in localStorage. It does NOT read data.sessionId back from the
      // server. So the server MUST key its session map on the client-provided
      // ID — otherwise every request creates a fresh empty session and
      // history is lost between turns.
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'reply' }],
      });

      const clientSessionId = 'sess_clientgenerated123';

      const first = await handleChat(
        JSON.stringify({
          message: 'Selge utstyr',
          sessionId: clientSessionId,
          site: 'lbs',
        }),
        '1.2.3.4',
      );
      expect((first.data as { sessionId: string }).sessionId).toBe(
        clientSessionId,
      );
      expect(sessions.has(clientSessionId)).toBe(true);

      const second = await handleChat(
        JSON.stringify({
          message: 'Noah',
          sessionId: clientSessionId,
          site: 'lbs',
        }),
        '1.2.3.4',
      );
      expect((second.data as { sessionId: string }).sessionId).toBe(
        clientSessionId,
      );
      // History from first turn must survive into second turn.
      expect(sessions.get(clientSessionId)!.messages.length).toBe(4);
    });

    it('reuses existing session', async () => {
      // First message
      mockCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'First reply' }],
      });

      const first = await handleChat(
        JSON.stringify({ message: 'Hello', site: 'ats' }),
        '1.2.3.4',
      );
      const sessionId = (first.data as { sessionId: string }).sessionId;

      // Second message with same session
      mockCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Second reply' }],
      });

      const second = await handleChat(
        JSON.stringify({
          message: 'Follow up',
          sessionId,
          site: 'ats',
        }),
        '1.2.3.4',
      );
      const secondData = second.data as { sessionId: string; reply: string };
      expect(secondData.sessionId).toBe(sessionId);
      expect(secondData.reply).toContain('Second reply');

      // Session should have conversation history
      const session = sessions.get(sessionId)!;
      expect(session.messages.length).toBe(4); // user, assistant, user, assistant
    });

    it('resets session when message limit reached', async () => {
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Reply' }],
      });

      // Create a session and fill it to the limit
      const first = await handleChat(
        JSON.stringify({ message: 'Msg 1', site: 'ats' }),
        '1.2.3.4',
      );
      const sessionId = (first.data as { sessionId: string }).sessionId;

      // Manually fill session to the limit
      const session = sessions.get(sessionId)!;
      while (session.messages.length < MAX_MESSAGES_PER_SESSION) {
        session.messages.push({ role: 'user', content: 'filler' });
      }

      // Next message should trigger a reset
      await handleChat(
        JSON.stringify({
          message: 'After limit',
          sessionId,
          site: 'ats',
        }),
        '1.2.3.4',
      );

      // Session should have been reset (only the new messages)
      expect(session.messages.length).toBe(2); // user + assistant after reset
    });

    it('logs session as pending_classification before resetting on message limit', async () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);
      setContactDbForTest(db);

      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Reply' }],
      });

      const first = await handleChat(
        JSON.stringify({ message: 'Hei', site: 'ats' }),
        '1.2.3.4',
      );
      const sessionId = (first.data as { sessionId: string }).sessionId;
      const session = sessions.get(sessionId)!;
      while (session.messages.length < MAX_MESSAGES_PER_SESSION) {
        session.messages.push({ role: 'user', content: 'filler' });
      }

      await handleChat(
        JSON.stringify({
          message: 'After limit',
          sessionId,
          site: 'ats',
        }),
        '1.2.3.4',
      );

      const row = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending_classification');
      // Captured the pre-reset history (>=MAX_MESSAGES), not the post-reset 2.
      const conversation = JSON.parse(row!.conversation as string);
      expect(conversation.length).toBeGreaterThanOrEqual(
        MAX_MESSAGES_PER_SESSION,
      );

      setContactDbForTest(null);
    });

    it('handles tool use loop', async () => {
      // First call: Claude wants to use ats_feed
      mockCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tool_abc',
            name: 'ats_feed',
            input: { command: 'search', argument: 'volvo' },
          },
        ],
      });

      // Second call: Claude returns final text
      mockCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Vi har en Volvo EC220E.' }],
      });

      const result = await handleChat(
        JSON.stringify({
          message: 'Har dere Volvo-gravemaskiner?',
          site: 'ats',
        }),
        '1.2.3.4',
      );

      expect(result.status).toBe(200);
      expect((result.data as { reply: string }).reply).toContain(
        'Vi har en Volvo EC220E.',
      );
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('defaults to ats site for invalid site param', async () => {
      mockCreate.mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'OK' }],
      });

      const result = await handleChat(
        JSON.stringify({ message: 'Hello', site: 'invalid' }),
        '1.2.3.4',
      );

      expect(result.status).toBe(200);
      const sessionId = (result.data as { sessionId: string }).sessionId;
      expect(sessions.get(sessionId)!.site).toBe('ats');
    });

    it('returns 500 on API error', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API down'));

      const result = await handleChat(
        JSON.stringify({ message: 'Hello', site: 'ats' }),
        '1.2.3.4',
      );

      expect(result.status).toBe(500);
      expect(result.data).toEqual({ error: 'Internal server error' });
    });
  });

  describe('logSession', () => {
    function makeSession(id = 'sess_test1', site: 'ats' | 'lbs' = 'lbs') {
      return {
        id,
        site,
        messages: [
          { role: 'user' as const, content: 'Selge utstyr' },
          {
            role: 'assistant' as const,
            content:
              'Vi formidler alt — se https://landbrukssalg.no/123. Hva er navnet ditt?',
          },
          { role: 'user' as const, content: 'Noah' },
        ],
        lastActivity: Date.now(),
        loggedAt: null,
      };
    }

    it('writes a pending_classification row with session_id, conversation, and machine links', () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);

      const session = makeSession();
      logSession(db, session, 'pending_classification');

      const row = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .get(session.id) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.status).toBe('pending_classification');
      expect(row.site).toBe('lbs');
      // No contact info yet
      expect(row.name ?? '').toBe('');
      expect(row.phone ?? '').toBe('');
      expect(row.email ?? '').toBe('');

      const conversation = JSON.parse(row.conversation as string);
      expect(conversation).toHaveLength(3);
      expect(conversation[0]).toEqual({
        role: 'user',
        content: 'Selge utstyr',
      });

      const machines = JSON.parse(row.machines_shown as string);
      expect(machines).toEqual(['https://landbrukssalg.no/123']);
    });

    it('upserts on session_id so two calls produce a single row', () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);

      const session = makeSession();
      logSession(db, session, 'pending_classification');

      // Continue conversation, log again
      session.messages.push({
        role: 'assistant' as const,
        content: 'Hyggelig, Noah!',
      });
      logSession(db, session, 'pending_classification');

      const rows = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .all(session.id);
      expect(rows).toHaveLength(1);
      const conversation = JSON.parse(
        (rows[0] as Record<string, unknown>).conversation as string,
      );
      expect(conversation).toHaveLength(4);
    });

    it('promotes pending row to has_contact when contact info arrives', () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);

      const session = makeSession();
      logSession(db, session, 'pending_classification');
      logSession(db, session, 'has_contact', {
        name: 'Noah',
        phone: '99999999',
        interest: 'Selge dieseltank',
      });

      const rows = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .all(session.id) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('has_contact');
      expect(rows[0].name).toBe('Noah');
      expect(rows[0].phone).toBe('99999999');
      expect(rows[0].interest).toBe('Selge dieseltank');
    });

    it('does not downgrade has_contact back to pending', () => {
      // If save_contact runs first, then a TTL-cleanup tries to log the
      // session as pending, the has_contact flag must survive — losing it
      // would mean a real lead gets buried in the unclassified pile.
      const db = new Database(':memory:');
      initChatContactsTable(db);

      const session = makeSession();
      logSession(db, session, 'has_contact', { name: 'Noah' });
      logSession(db, session, 'pending_classification');

      const row = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .get(session.id) as Record<string, unknown>;
      expect(row.status).toBe('has_contact');
      expect(row.name).toBe('Noah');
    });
  });

  describe('save_contact tool', () => {
    it('upserts onto an existing pending row rather than creating a duplicate', async () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);
      setContactDbForTest(db);

      const session = {
        id: 'sess_savecontact1',
        site: 'lbs' as const,
        messages: [
          { role: 'user' as const, content: 'Selge dieseltank' },
          {
            role: 'assistant' as const,
            content: 'Vil du at jeg noterer kontaktinfoen din?',
          },
          { role: 'user' as const, content: 'ja' },
          { role: 'assistant' as const, content: 'Hva er navnet ditt?' },
          { role: 'user' as const, content: 'Noah' },
        ],
        lastActivity: Date.now(),
      };

      // Simulate that cleanup already logged this session as pending earlier.
      logSession(db, session, 'pending_classification');

      // Now save_contact runs in the same session.
      await executeChatTool(
        'save_contact',
        {
          name: 'Noah',
          phone: '99999999',
          interest: 'Selge dieseltank 2500 L',
          site: 'lbs',
        },
        session,
      );

      const rows = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .all(session.id) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('has_contact');
      expect(rows[0].name).toBe('Noah');
      expect(rows[0].phone).toBe('99999999');
      expect(rows[0].interest).toBe('Selge dieseltank 2500 L');

      setContactDbForTest(null);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('logs expired sessions as pending_classification before deleting them', () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);
      setContactDbForTest(db);

      const sessionId = 'sess_expired';
      sessions.set(sessionId, {
        id: sessionId,
        site: 'lbs',
        messages: [
          { role: 'user', content: 'Selge utstyr' },
          { role: 'assistant', content: 'Hva er navnet ditt?' },
          { role: 'user', content: 'Noah' },
        ],
        lastActivity: Date.now() - SESSION_TTL_MS - 1000,
      });

      cleanupExpiredSessions(Date.now());

      // Session is removed from in-memory map
      expect(sessions.has(sessionId)).toBe(false);

      // And persisted as pending_classification
      const row = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending_classification');
      expect(row!.site).toBe('lbs');
      const conversation = JSON.parse(row!.conversation as string);
      expect(conversation).toHaveLength(3);

      setContactDbForTest(null);
    });

    it('does not log or delete sessions that are still active', () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);
      setContactDbForTest(db);

      const sessionId = 'sess_active';
      sessions.set(sessionId, {
        id: sessionId,
        site: 'ats',
        messages: [{ role: 'user', content: 'Hei' }],
        lastActivity: Date.now(), // Just now — not expired
      });

      cleanupExpiredSessions(Date.now());

      expect(sessions.has(sessionId)).toBe(true);
      const row = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .get(sessionId);
      expect(row).toBeUndefined();

      setContactDbForTest(null);
    });

    it('does not log empty sessions (no user messages)', () => {
      // A session that was created but never used (e.g. preflight) should
      // not pollute the log.
      const db = new Database(':memory:');
      initChatContactsTable(db);
      setContactDbForTest(db);

      const sessionId = 'sess_empty';
      sessions.set(sessionId, {
        id: sessionId,
        site: 'ats',
        messages: [],
        lastActivity: Date.now() - SESSION_TTL_MS - 1000,
      });

      cleanupExpiredSessions(Date.now());

      expect(sessions.has(sessionId)).toBe(false);
      const row = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .get(sessionId);
      expect(row).toBeUndefined();

      setContactDbForTest(null);
    });
  });

  describe('flushAllSessions', () => {
    it('persists every active session with user messages on shutdown', () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);
      setContactDbForTest(db);

      sessions.set('sess_a', {
        id: 'sess_a',
        site: 'lbs',
        messages: [{ role: 'user', content: 'Selge plog' }],
        lastActivity: Date.now(),
      });
      sessions.set('sess_b', {
        id: 'sess_b',
        site: 'ats',
        messages: [{ role: 'user', content: 'Har dere Volvo?' }],
        lastActivity: Date.now(),
      });
      // Empty session — must not pollute the log.
      sessions.set('sess_empty', {
        id: 'sess_empty',
        site: 'ats',
        messages: [],
        lastActivity: Date.now(),
      });

      flushAllSessions();

      const rows = db
        .prepare('SELECT session_id, status FROM chat_contacts ORDER BY session_id')
        .all() as { session_id: string; status: string }[];
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.session_id).sort()).toEqual([
        'sess_a',
        'sess_b',
      ]);
      expect(rows.every((r) => r.status === 'pending_classification')).toBe(
        true,
      );

      setContactDbForTest(null);
    });

    it('does not downgrade has_contact rows during flush', () => {
      const db = new Database(':memory:');
      initChatContactsTable(db);
      setContactDbForTest(db);

      const session = {
        id: 'sess_with_contact',
        site: 'lbs' as const,
        messages: [
          { role: 'user' as const, content: 'Selge utstyr' },
          { role: 'user' as const, content: 'Noah' },
        ],
        lastActivity: Date.now(),
      };
      sessions.set(session.id, session);
      // save_contact already ran for this session.
      logSession(db, session, 'has_contact', { name: 'Noah' });

      flushAllSessions();

      const row = db
        .prepare('SELECT * FROM chat_contacts WHERE session_id = ?')
        .get(session.id) as Record<string, unknown>;
      expect(row.status).toBe('has_contact');
      expect(row.name).toBe('Noah');

      setContactDbForTest(null);
    });
  });

  describe('renderMarkdown', () => {
    it('returns empty string for empty input', () => {
      expect(renderMarkdown('')).toBe('');
    });

    it('wraps plain text in <p>', () => {
      expect(renderMarkdown('Bare en setning.')).toContain(
        '<p>Bare en setning.',
      );
    });

    it('renders bold and italic', () => {
      const html = renderMarkdown('**bold** and *italic*');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    it('renders GFM tables to HTML', () => {
      const md = '| Modell | Pris |\n|---|---|\n| 1030 | 49 000 kr |';
      const html = renderMarkdown(md);
      expect(html).toContain('<table>');
      expect(html).toContain('<th>Modell</th>');
      expect(html).toContain('<td>49 000 kr</td>');
    });

    it('renders unordered lists', () => {
      const html = renderMarkdown('- one\n- two');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>one</li>');
    });

    it('renders headings (h2-h4) but not h1', () => {
      const html = renderMarkdown('# top\n## sub\n### subsub');
      expect(html).not.toContain('<h1>');
      expect(html).toContain('<h2>sub</h2>');
      expect(html).toContain('<h3>subsub</h3>');
    });

    it('strips <script> tags', () => {
      const html = renderMarkdown('Hello <script>alert(1)</script> world');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert(1)');
    });

    it('strips javascript: links', () => {
      const html = renderMarkdown('[click](javascript:alert(1))');
      expect(html).not.toMatch(/href=["']javascript:/i);
    });

    it('preserves https links and adds target=_blank rel=noopener', () => {
      const html = renderMarkdown('[se annonse](https://landbrukssalg.no/123)');
      expect(html).toMatch(/href="https:\/\/landbrukssalg\.no\/123"/);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it('strips inline event handlers', () => {
      const html = renderMarkdown('<a href="x" onclick="alert(1)">x</a>');
      expect(html).not.toContain('onclick');
    });

    it('renders inline code', () => {
      const html = renderMarkdown('Try `npm test`');
      expect(html).toContain('<code>npm test</code>');
    });
  });
});
