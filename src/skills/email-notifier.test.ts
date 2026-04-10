import { describe, it, expect } from 'vitest';
import { formatEmailNotification } from './email-notifier';

describe('formatEmailNotification', () => {
  it('formats viktig notification with correct icon and label', () => {
    const result = formatEmailNotification(
      'viktig',
      'kollega@firma.no',
      'Møte i morgen?',
      'Har du tid til et kort møte i morgen formiddag?',
    );

    expect(result).toContain('📩');
    expect(result).toContain('*Viktig*');
    expect(result).toContain('Fra: kollega@firma.no');
    expect(result).toContain('Emne: Møte i morgen?');
    expect(result).toContain('Har du tid til et kort møte i morgen formiddag?');
  });

  it('formats handling_kreves with warning icon', () => {
    const result = formatEmailNotification(
      'handling_kreves',
      'bank@dnb.no',
      'Faktura forfaller snart',
      'Din faktura på 1000 kr forfaller om 3 dager.',
    );

    expect(result).toContain('⚠️');
    expect(result).toContain('*Handling kreves*');
    expect(result).toContain('Fra: bank@dnb.no');
    expect(result).toContain('Emne: Faktura forfaller snart');
  });

  it('truncates long body preview to 200 chars', () => {
    const longBody = 'a'.repeat(300);
    const result = formatEmailNotification(
      'viktig',
      'sender@example.com',
      'Subject',
      longBody,
    );

    const preview = result.split('\n\n')[1];
    expect(preview.length).toBe(200);
  });

  it('replaces newlines in preview with spaces', () => {
    const bodyWithNewlines = 'First line\nSecond line\n\nThird line';
    const result = formatEmailNotification(
      'viktig',
      'sender@example.com',
      'Subject',
      bodyWithNewlines,
    );

    const preview = result.split('\n\n')[1];
    expect(preview).not.toContain('\n');
    expect(preview).toBe('First line Second line Third line');
  });
});
