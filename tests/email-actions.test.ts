import { describe, it, expect } from 'vitest';
import { getCategoryFolder, getCategoryLabel } from '../src/skills/email-actions';

describe('Email Actions', () => {
  it('should map category to Gmail label', () => {
    expect(getCategoryLabel('kvittering')).toBe('Kvitteringer');
    expect(getCategoryLabel('nyhetsbrev')).toBe('Nyhetsbrev');
    expect(getCategoryLabel('viktig')).toBe('Viktig');
  });

  it('should map category to Outlook folder', () => {
    expect(getCategoryFolder('kvittering')).toBe('Kvitteringer');
    expect(getCategoryFolder('nyhetsbrev')).toBe('Nyhetsbrev');
    expect(getCategoryFolder('viktig')).toBe('Viktig');
  });
});
