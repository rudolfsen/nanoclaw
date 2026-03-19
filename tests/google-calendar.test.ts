import { describe, it, expect } from 'vitest';
import { formatEvent, parseEventRequest } from '../src/skills/google-calendar';

describe('Google Calendar', () => {
  it('should format a calendar event for display', () => {
    const event = {
      summary: 'Team standup',
      start: { dateTime: '2026-03-19T09:00:00+01:00' },
      end: { dateTime: '2026-03-19T09:15:00+01:00' },
      location: 'Zoom',
    };
    const formatted = formatEvent(event);
    expect(formatted).toContain('Team standup');
    expect(formatted).toContain('09:00');
  });

  it('should parse natural language event request', () => {
    const parsed = parseEventRequest('Book møte med Anders tirsdag kl 10');
    expect(parsed.summary).toContain('Anders');
    expect(parsed.hour).toBe(10);
  });
});
