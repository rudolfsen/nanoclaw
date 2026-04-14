import { describe, it, expect } from 'vitest';
import { scoreLead, scoreTier } from './lead-scoring.js';

function makeLead(
  overrides: Partial<import('./lead-scoring.js').LeadRow> = {},
): import('./lead-scoring.js').LeadRow {
  return {
    id: 1,
    source: 'finn_wanted',
    signal_type: 'demand',
    match_status: 'has_match',
    price_diff_pct: null,
    status: 'new',
    contact_info: '99887766',
    contact_name: 'Ola Nordmann',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('scoreLead', () => {
  it('scores a hot lead (demand + has_match + fresh + contact)', () => {
    const score = scoreLead(makeLead());
    expect(score).toBeGreaterThanOrEqual(70);
    expect(scoreTier(score)).toBe('hot');
  });

  it('scores a cold lead (supply + no_match + old + no contact)', () => {
    const score = scoreLead(
      makeLead({
        signal_type: 'supply',
        match_status: 'no_match',
        contact_info: null,
        contact_name: null,
        created_at: new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    );
    expect(score).toBeLessThanOrEqual(30);
    expect(scoreTier(score)).toBe('cold');
  });

  it('gives bonus for large price diff on supply signals', () => {
    const withDiff = scoreLead(
      makeLead({
        signal_type: 'supply',
        match_status: 'price_opportunity',
        price_diff_pct: 45,
      }),
    );
    const withoutDiff = scoreLead(
      makeLead({
        signal_type: 'supply',
        match_status: 'price_opportunity',
        price_diff_pct: 5,
      }),
    );
    expect(withDiff).toBeGreaterThan(withoutDiff);
  });

  it('returns score between 0 and 100', () => {
    const score = scoreLead(makeLead());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('scoreTier', () => {
  it('maps scores to tiers', () => {
    expect(scoreTier(80)).toBe('hot');
    expect(scoreTier(60)).toBe('hot');
    expect(scoreTier(45)).toBe('warm');
    expect(scoreTier(30)).toBe('warm');
    expect(scoreTier(20)).toBe('cold');
    expect(scoreTier(0)).toBe('cold');
  });
});
