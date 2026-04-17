import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'http';

vi.mock('./config.js', () => ({
  COWORK_API_PORT: 0,
  COWORK_API_TOKEN: 'test-token-12345678901234567890',
}));

const TEST_TOKEN = 'test-token-12345678901234567890';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    OUTLOOK_TENANT_ID: 'tenant',
    OUTLOOK_CLIENT_ID: 'client',
    OUTLOOK_CLIENT_SECRET: 'secret',
    OUTLOOK_REFRESH_TOKEN: 'refresh',
  })),
}));

vi.mock('./channels/outlook.js', () => ({
  getOutlookAccessToken: vi.fn(async () => 'fake-graph-token'),
}));

import {
  _rateLimits as rateLimits,
  _isRateLimited as isRateLimited,
  _checkAuth as checkAuth,
  _handleSearch as handleSearch,
  _handleGetMessage as handleGetMessage,
  _handleGetThread as handleGetThread,
  _handleCreateDraft as handleCreateDraft,
  _toEnvelope as toEnvelope,
  _invalidateTokenCache as invalidateTokenCache,
} from './cowork-api.js';

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function graphOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function graphEmpty(status = 200): Response {
  const body = status === 204 ? null : '';
  return new Response(body, { status });
}

describe('cowork-api — auth', () => {
  it('rejects request without Authorization header', () => {
    expect(checkAuth(mockReq())).toBe(false);
  });

  it('rejects request with non-Bearer Authorization', () => {
    expect(checkAuth(mockReq({ authorization: 'Basic abc' }))).toBe(false);
  });

  it('rejects request with wrong token', () => {
    expect(
      checkAuth(mockReq({ authorization: 'Bearer wrong-token-of-same-len' })),
    ).toBe(false);
  });

  it('accepts request with correct Bearer token', () => {
    expect(checkAuth(mockReq({ authorization: `Bearer ${TEST_TOKEN}` }))).toBe(
      true,
    );
  });

  it('rejects short token without throwing (length mismatch path)', () => {
    // timingSafeEqual throws on length mismatch — implementation must guard.
    expect(() =>
      checkAuth(mockReq({ authorization: 'Bearer short' })),
    ).not.toThrow();
    expect(checkAuth(mockReq({ authorization: 'Bearer short' }))).toBe(false);
  });

  it('rejects long token without throwing', () => {
    const long = 'x'.repeat(200);
    expect(() =>
      checkAuth(mockReq({ authorization: `Bearer ${long}` })),
    ).not.toThrow();
  });
});

describe('cowork-api — rate limiting', () => {
  beforeEach(() => {
    rateLimits.clear();
  });

  it('allows up to 60 requests per minute per IP', () => {
    for (let i = 0; i < 60; i++) {
      expect(isRateLimited('1.2.3.4')).toBe(false);
    }
  });

  it('returns true on the 61st request within the window', () => {
    for (let i = 0; i < 60; i++) isRateLimited('5.6.7.8');
    expect(isRateLimited('5.6.7.8')).toBe(true);
  });

  it('tracks separate IPs independently', () => {
    for (let i = 0; i < 60; i++) isRateLimited('ip-a');
    expect(isRateLimited('ip-a')).toBe(true);
    expect(isRateLimited('ip-b')).toBe(false);
  });
});

describe('cowork-api — envelope shape', () => {
  it('extracts basic fields and truncates preview to 300 chars', () => {
    const longPreview = 'a'.repeat(500);
    const env = toEnvelope({
      id: 'msg-1',
      conversationId: 'conv-1',
      subject: 'Hello',
      from: { emailAddress: { name: 'Ola', address: 'ola@example.com' } },
      toRecipients: [
        { emailAddress: { name: 'Kari', address: 'kari@example.com' } },
      ],
      receivedDateTime: '2026-04-17T10:00:00Z',
      bodyPreview: longPreview,
    });
    expect(env.id).toBe('msg-1');
    expect(env.conversationId).toBe('conv-1');
    expect(env.subject).toBe('Hello');
    expect(env.from).toEqual({ name: 'Ola', email: 'ola@example.com' });
    expect(env.to).toEqual([{ name: 'Kari', email: 'kari@example.com' }]);
    expect(env.receivedAt).toBe('2026-04-17T10:00:00Z');
    expect(env.preview.length).toBe(300);
  });

  it('handles missing fields gracefully', () => {
    const env = toEnvelope({});
    expect(env.id).toBe('');
    expect(env.from).toEqual({ name: '', email: '' });
    expect(env.to).toEqual([]);
  });
});

describe('cowork-api — Graph calls', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invalidateTokenCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('handleSearch', () => {
    it('passes query + top through and returns trimmed envelopes', async () => {
      fetchMock.mockResolvedValueOnce(
        graphOk({
          value: [
            {
              id: 'a',
              conversationId: 'c-a',
              subject: 'Hei',
              from: { emailAddress: { name: 'X', address: 'x@y.no' } },
              toRecipients: [],
              receivedDateTime: '2026-04-17T09:00:00Z',
              bodyPreview: 'short',
            },
          ],
        }),
      );

      const result = await handleSearch('from:skogvold', 7);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toMatch(/graph\.microsoft\.com\/v1\.0\/me\/messages/);
      expect(url).toMatch(/%24search=%22from%3Askogvold%22/);
      expect(url).toMatch(/%24top=7/);
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toBe('Bearer fake-graph-token');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
      expect(result[0].preview).toBe('short');
    });
  });

  describe('handleGetMessage', () => {
    it('sanitizes body via sanitizeEmailForAgent', async () => {
      fetchMock.mockResolvedValueOnce(
        graphOk({
          id: 'msg-1',
          conversationId: 'c-1',
          subject: 'Subj',
          from: { emailAddress: { name: 'Ola', address: 'ola@x.no' } },
          toRecipients: [],
          receivedDateTime: '2026-04-17T10:00:00Z',
          bodyPreview: 'prev',
          body: { contentType: 'text', content: 'Hello world' },
        }),
      );

      const result = await handleGetMessage('msg-1');

      expect(result.bodyText).toContain('<external-email>');
      expect(result.bodyText).toContain('From: Ola <ola@x.no>');
      expect(result.bodyText).toContain('Subject: Subj');
      expect(result.bodyText).toContain('Hello world');
      expect(result.bodyHtml).toBeNull();
    });

    it('strips HTML when contentType is html', async () => {
      fetchMock.mockResolvedValueOnce(
        graphOk({
          id: 'msg-2',
          body: {
            contentType: 'html',
            content: '<p>Hello <b>there</b></p><script>evil()</script>',
          },
        }),
      );
      const result = await handleGetMessage('msg-2');
      expect(result.bodyText).toContain('Hello there');
      expect(result.bodyText).not.toContain('<p>');
      expect(result.bodyText).not.toContain('evil');
      expect(result.bodyHtml).toContain('<p>');
    });

    it('URL-encodes message IDs with special characters', async () => {
      fetchMock.mockResolvedValueOnce(graphOk({ id: 'x' }));
      await handleGetMessage('AAA=/bbb+');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('AAA%3D%2Fbbb%2B');
    });
  });

  describe('handleGetThread', () => {
    it('queries by conversationId and returns sanitized messages', async () => {
      fetchMock.mockResolvedValueOnce(
        graphOk({
          value: [
            {
              id: 'm1',
              conversationId: 'conv-abc',
              subject: 'Re: thread',
              from: { emailAddress: { name: '', address: 'a@b.no' } },
              toRecipients: [],
              receivedDateTime: '2026-04-17T08:00:00Z',
              bodyPreview: '',
              body: { contentType: 'text', content: 'first' },
            },
            {
              id: 'm2',
              conversationId: 'conv-abc',
              subject: 'Re: thread',
              from: { emailAddress: { name: '', address: 'a@b.no' } },
              toRecipients: [],
              receivedDateTime: '2026-04-17T09:00:00Z',
              bodyPreview: '',
              body: { contentType: 'text', content: 'second' },
            },
          ],
        }),
      );

      const result = await handleGetThread('conv-abc');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toMatch(/%24filter=conversationId\+eq\+%27conv-abc%27/);
      expect(url).toMatch(/%24orderby=receivedDateTime/);
      expect(result).toHaveLength(2);
      expect(result[0].bodyText).toContain('first');
      expect(result[1].bodyText).toContain('second');
    });

    it('escapes single quotes in conversationId', async () => {
      fetchMock.mockResolvedValueOnce(graphOk({ value: [] }));
      await handleGetThread("id'with'quotes");
      const [url] = fetchMock.mock.calls[0];
      // OData single quote is doubled → %27%27
      expect(url).toMatch(/id%27%27with%27%27quotes/);
    });
  });

  describe('handleCreateDraft', () => {
    it('POSTs to /messages (draft), never to /sendMail', async () => {
      fetchMock.mockResolvedValueOnce(
        graphOk({ id: 'draft-1', webLink: 'https://outlook…' }),
      );
      const result = await handleCreateDraft({
        subject: 'Test',
        body: 'Hello',
        to: ['kari@example.com'],
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages');
      expect(url).not.toMatch(/sendMail/i);
      expect(opts.method).toBe('POST');
      const sent = JSON.parse(opts.body);
      expect(sent.subject).toBe('Test');
      expect(sent.body).toEqual({ contentType: 'text', content: 'Hello' });
      expect(sent.toRecipients).toEqual([
        { emailAddress: { address: 'kari@example.com' } },
      ]);
      expect(sent).not.toHaveProperty('ccRecipients');
      expect(result.id).toBe('draft-1');
    });

    it('includes ccRecipients when cc provided', async () => {
      fetchMock.mockResolvedValueOnce(graphOk({ id: 'd' }));
      await handleCreateDraft({
        subject: 'S',
        body: 'B',
        to: ['a@x.no'],
        cc: ['b@x.no', 'c@x.no'],
      });
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.ccRecipients).toEqual([
        { emailAddress: { address: 'b@x.no' } },
        { emailAddress: { address: 'c@x.no' } },
      ]);
    });

    it('uses createReply + PATCH when replyToMessageId is set', async () => {
      fetchMock
        .mockResolvedValueOnce(graphOk({ id: 'reply-draft-1' }))
        .mockResolvedValueOnce(graphEmpty(204));
      const result = await handleCreateDraft({
        subject: 'Re: x',
        body: 'thanks',
        to: ['a@x.no'],
        replyToMessageId: 'original-msg-id',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [firstUrl, firstOpts] = fetchMock.mock.calls[0];
      expect(firstUrl).toMatch(/\/messages\/original-msg-id\/createReply$/);
      expect(firstOpts.method).toBe('POST');

      const [secondUrl, secondOpts] = fetchMock.mock.calls[1];
      expect(secondUrl).toMatch(/\/messages\/reply-draft-1$/);
      expect(secondOpts.method).toBe('PATCH');
      expect(result.id).toBe('reply-draft-1');
    });

    it('rejects missing subject', async () => {
      await expect(
        handleCreateDraft({ body: 'x', to: ['a@x.no'] }),
      ).rejects.toThrow(/subject/i);
    });

    it('rejects missing body', async () => {
      await expect(
        handleCreateDraft({ subject: 's', to: ['a@x.no'] }),
      ).rejects.toThrow(/body/i);
    });

    it('rejects empty to list', async () => {
      await expect(
        handleCreateDraft({ subject: 's', body: 'b', to: [] }),
      ).rejects.toThrow(/recipient/i);
    });

    it('rejects non-array to', async () => {
      await expect(
        handleCreateDraft({ subject: 's', body: 'b', to: 'a@x.no' }),
      ).rejects.toThrow(/recipient/i);
    });
  });

  describe('token caching', () => {
    it('reuses cached token across calls within TTL', async () => {
      const { getOutlookAccessToken } = await import('./channels/outlook.js');
      const tokenFn = getOutlookAccessToken as unknown as ReturnType<
        typeof vi.fn
      >;
      tokenFn.mockClear();

      fetchMock.mockImplementation(() => Promise.resolve(graphOk({ value: [] })));
      await handleSearch('q1', 5);
      await handleSearch('q2', 5);
      await handleSearch('q3', 5);

      expect(tokenFn).toHaveBeenCalledTimes(1);
    });
  });
});
