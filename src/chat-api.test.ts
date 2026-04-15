import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
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

import {
  _sessions as sessions,
  _rateLimits as rateLimits,
  _handleChat as handleChat,
  _isRateLimited as isRateLimited,
  _getCorsOrigin as getCorsOrigin,
  _loadSystemPrompt as loadSystemPrompt,
  _getToolsForSite as getToolsForSite,
  MAX_MESSAGES_PER_SESSION,
} from './chat-api.js';

describe('Chat API', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    sessions.clear();
    rateLimits.clear();
  });

  describe('getToolsForSite', () => {
    it('returns only ats_feed for ats site', () => {
      const tools = getToolsForSite('ats');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('ats_feed');
    });

    it('returns only lbs_feed for lbs site', () => {
      const tools = getToolsForSite('lbs');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('lbs_feed');
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

    it('returns null when no origin header', () => {
      const req = { headers: {} };
      expect(getCorsOrigin(req as any)).toBeNull();
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
      expect(data.reply).toBe('Vi har mange maskiner!');
      expect(data.sessionId).toBeTruthy();

      // Session should exist
      expect(sessions.has(data.sessionId)).toBe(true);
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
      expect(secondData.reply).toBe('Second reply');

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
      expect((result.data as { reply: string }).reply).toBe(
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
});
