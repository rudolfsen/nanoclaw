import { describe, it, expect } from 'vitest';
import { getGraphBase, buildDraftMessage } from './outlook.js';

describe('getGraphBase', () => {
  it('returns /me endpoint when no shared mailbox is provided', () => {
    expect(getGraphBase()).toBe('https://graph.microsoft.com/v1.0/me');
  });

  it('returns /me endpoint when undefined is passed', () => {
    expect(getGraphBase(undefined)).toBe('https://graph.microsoft.com/v1.0/me');
  });

  it('returns /users/{mailbox} endpoint when shared mailbox is provided', () => {
    expect(getGraphBase('shared@company.com')).toBe(
      'https://graph.microsoft.com/v1.0/users/shared@company.com',
    );
  });

  it('returns /users/{mailbox} for any non-empty string', () => {
    expect(getGraphBase('info@ats.no')).toBe(
      'https://graph.microsoft.com/v1.0/users/info@ats.no',
    );
  });
});

describe('buildDraftMessage', () => {
  it('builds basic draft message without optional fields', () => {
    const msg = buildDraftMessage({
      to: 'to@example.com',
      subject: 'Test Subject',
      body: 'Hello',
    });
    expect(msg).toEqual({
      subject: 'Test Subject',
      body: { contentType: 'text', content: 'Hello' },
      toRecipients: [{ emailAddress: { address: 'to@example.com' } }],
      isDraft: true,
    });
  });

  it('includes conversationId when provided', () => {
    const msg = buildDraftMessage({
      to: 'to@example.com',
      subject: 'Re: Thread',
      body: 'Reply body',
      conversationId: 'conv-123',
    });
    expect(msg.conversationId).toBe('conv-123');
  });

  it('omits conversationId when not provided', () => {
    const msg = buildDraftMessage({
      to: 'to@example.com',
      subject: 'Subject',
      body: 'Body',
    });
    expect(msg).not.toHaveProperty('conversationId');
  });

  it('includes from field when fromAddress is provided', () => {
    const msg = buildDraftMessage({
      to: 'to@example.com',
      subject: 'Subject',
      body: 'Body',
      fromAddress: 'shared@company.com',
    });
    expect(msg.from).toEqual({
      emailAddress: { address: 'shared@company.com' },
    });
  });

  it('omits from field when fromAddress is not provided', () => {
    const msg = buildDraftMessage({
      to: 'to@example.com',
      subject: 'Subject',
      body: 'Body',
    });
    expect(msg).not.toHaveProperty('from');
  });

  it('includes both conversationId and from when both provided', () => {
    const msg = buildDraftMessage({
      to: 'to@example.com',
      subject: 'Re: Thread',
      body: 'Reply',
      conversationId: 'conv-456',
      fromAddress: 'info@ats.no',
    });
    expect(msg.conversationId).toBe('conv-456');
    expect(msg.from).toEqual({
      emailAddress: { address: 'info@ats.no' },
    });
    expect(msg.subject).toBe('Re: Thread');
    expect(msg.isDraft).toBe(true);
  });
});

describe('EMAIL_CLASSIFICATION_ENABLED', () => {
  it('is true by default', async () => {
    const { EMAIL_CLASSIFICATION_ENABLED } = await import('../config.js');
    expect(EMAIL_CLASSIFICATION_ENABLED).toBe(true);
  });
});
