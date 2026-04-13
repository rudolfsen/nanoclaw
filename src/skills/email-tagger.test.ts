import { describe, it, expect } from 'vitest';
import { extractDomainTag, extractSubjectKeywords } from './email-tagger.js';

describe('extractDomainTag', () => {
  it('extracts company name from domain', () => {
    expect(extractDomainTag('beate@gyldendal.no')).toBe('Gyldendal');
  });

  it('strips common prefixes', () => {
    expect(extractDomainTag('noreply@mail.bonnier.com')).toBe('Bonnier');
  });

  it('returns null for generic email domains', () => {
    expect(extractDomainTag('user@gmail.com')).toBeNull();
  });

  it('returns null for automated senders on generic domains', () => {
    expect(extractDomainTag('noreply@notifications.com')).toBeNull();
  });

  it('handles metamail domain', () => {
    expect(extractDomainTag('noreply@global.metamail.com')).toBeNull();
  });
});

describe('extractSubjectKeywords', () => {
  it('strips reply prefixes', () => {
    const keywords = extractSubjectKeywords('Re: SV: Bundling e-bok og pbok');
    expect(keywords).not.toContain('Re');
    expect(keywords).not.toContain('SV');
  });

  it('filters stopwords and short words', () => {
    const keywords = extractSubjectKeywords('Oppgradering av metadata-synk og status');
    expect(keywords).toContain('Oppgradering');
    expect(keywords).toContain('metadata');
    expect(keywords).toContain('synk');
    expect(keywords).toContain('status');
    expect(keywords).not.toContain('av');
    expect(keywords).not.toContain('og');
  });

  it('returns empty array for empty subject', () => {
    expect(extractSubjectKeywords('')).toEqual([]);
  });
});
