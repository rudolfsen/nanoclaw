import { describe, it, expect } from 'vitest';
import { sanitizeEmailForAgent } from './email-sanitizer.js';

describe('sanitizeEmailForAgent', () => {
  it('wraps email in <external-email> XML delimiters', () => {
    const result = sanitizeEmailForAgent({
      from: 'sender@example.com',
      subject: 'Hello',
      body: 'Some body text',
    });

    expect(result).toMatch(/^<external-email>\n/);
    expect(result).toMatch(/\n<\/external-email>$/);
  });

  it('preserves sender and subject', () => {
    const result = sanitizeEmailForAgent({
      from: 'alice@example.com',
      subject: 'Meeting tomorrow',
      body: 'Details here',
    });

    expect(result).toContain('From: alice@example.com');
    expect(result).toContain('Subject: Meeting tomorrow');
  });

  it('includes body content when within 4000 chars', () => {
    const body = 'Short body';
    const result = sanitizeEmailForAgent({
      from: 'sender@example.com',
      subject: 'Test',
      body,
    });

    expect(result).toContain(body);
    expect(result).not.toContain('...[truncated]');
  });

  it('truncates body to 4000 chars and appends truncation marker', () => {
    const body = 'a'.repeat(5000);
    const result = sanitizeEmailForAgent({
      from: 'sender@example.com',
      subject: 'Long email',
      body,
    });

    expect(result).toContain('a'.repeat(4000) + '...[truncated]');
    expect(result).not.toContain('a'.repeat(4001));
  });

  it('does not truncate body that is exactly 4000 chars', () => {
    const body = 'b'.repeat(4000);
    const result = sanitizeEmailForAgent({
      from: 'sender@example.com',
      subject: 'Exact length',
      body,
    });

    expect(result).toContain(body);
    expect(result).not.toContain('...[truncated]');
  });
});
