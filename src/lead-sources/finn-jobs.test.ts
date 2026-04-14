import { describe, it, expect } from 'vitest';
import { parseJobListings } from './finn-jobs.js';

const SAMPLE_HTML = `
<article class="flex h-full w-full" id="card-345678">
  <a href="/job/345678">
    <h2>Maskinfører — Gravemaskinist</h2>
  </a>
  <span class="employer">Veidekke ASA</span>
  <div class="s-text-subtle"><span>Oslo</span></div>
</article>

<article class="flex h-full w-full" id="card-999111">
  <a href="/job/999111">
    <h2>Anleggsmaskinfører</h2>
  </a>
  <span class="employer">Adecco Norge</span>
  <div class="s-text-subtle"><span>Bergen</span></div>
</article>

<article class="flex h-full w-full" id="card-222333">
  <a href="/job/222333">
    <h2>Kranfører</h2>
  </a>
  <span class="employer">AF Gruppen</span>
  <div class="s-text-subtle"><span>Trondheim</span></div>
</article>
`;

describe('parseJobListings', () => {
  it('extracts job listings from HTML', () => {
    const signals = parseJobListings(SAMPLE_HTML);
    // Adecco is filtered out as recruitment agency
    expect(signals).toHaveLength(2);
  });

  it('extracts correct fields from a listing', () => {
    const signals = parseJobListings(SAMPLE_HTML);
    const veidekke = signals.find((s) => s.title.includes('Veidekke'));
    expect(veidekke).toBeDefined();
    expect(veidekke!.source).toBe('finn_jobs');
    expect(veidekke!.externalId).toBe('finn-job-345678');
    expect(veidekke!.companyName).toBe('Veidekke ASA');
    expect(veidekke!.category).toBe('Stillingsannonse');
    expect(veidekke!.price).toBeNull();
  });

  it('filters out recruitment agencies', () => {
    const signals = parseJobListings(SAMPLE_HTML);
    const adecco = signals.find((s) => s.title.includes('Adecco'));
    expect(adecco).toBeUndefined();
  });

  it('handles listings with no title gracefully', () => {
    const html = `
      <article class="flex h-full w-full" id="card-111222">
        <a href="/job/111222">
          <h2></h2>
        </a>
      </article>
    `;
    const signals = parseJobListings(html);
    expect(signals).toHaveLength(0);
  });

  it('deduplicates by external ID', () => {
    const doubleHtml = SAMPLE_HTML + SAMPLE_HTML;
    const signals = parseJobListings(doubleHtml);
    const ids = signals.map((s) => s.externalId);
    expect(ids.filter((id) => id === 'finn-job-345678')).toHaveLength(2);
  });

  it('returns empty array for HTML with no job listings', () => {
    const signals = parseJobListings('<html><body>No results</body></html>');
    expect(signals).toHaveLength(0);
  });
});
