import { describe, it, expect } from 'vitest';
import { parseJobListings } from './finn-jobs.js';

const SAMPLE_HTML = `
<article class="flex h-full w-full flex-col" id="card-345678">
  <div class="flex flex-col gap-8 job-card__body p-16 h-full">
    <div>
      <a class="job-card-link h4 mb-0 w-full" href="https://www.finn.no/job/ad/345678">
        <span class="inset-0 absolute" aria-hidden="true"></span>Maskinfører — Gravemaskinist
      </a>
      <div class="text-caption s-text-subtle"><strong>Veidekke ASA</strong></div>
    </div>
    <footer class="text-detail mt-auto flex flex-col gap-8">
      <ul class="job-card__pills m-0 p-0 s-text-subtle">
        <li class="min-w-0"><span class="block truncate">Oslo</span></li>
        <li class="shrink-0"><time datetime="2026-04-10T10:00:00Z">4 dager siden</time></li>
      </ul>
    </footer>
  </div>
</article>

<article class="flex h-full w-full flex-col" id="card-999111">
  <div class="flex flex-col gap-8 job-card__body p-16 h-full">
    <div>
      <a class="job-card-link h4 mb-0 w-full" href="https://www.finn.no/job/ad/999111">
        <span class="inset-0 absolute" aria-hidden="true"></span>Anleggsmaskinfører
      </a>
      <div class="text-caption s-text-subtle"><strong>Adecco Norge</strong></div>
    </div>
    <footer class="text-detail mt-auto flex flex-col gap-8">
      <ul class="job-card__pills m-0 p-0 s-text-subtle">
        <li class="min-w-0"><span class="block truncate">Bergen</span></li>
      </ul>
    </footer>
  </div>
</article>

<article class="flex h-full w-full flex-col" id="card-222333">
  <div class="flex flex-col gap-8 job-card__body p-16 h-full">
    <div>
      <a class="job-card-link h4 mb-0 w-full" href="https://www.finn.no/job/ad/222333">
        <span class="inset-0 absolute" aria-hidden="true"></span>Kranfører
      </a>
      <div class="text-caption s-text-subtle"><strong>AF Gruppen</strong></div>
    </div>
    <footer class="text-detail mt-auto flex flex-col gap-8">
      <ul class="job-card__pills m-0 p-0 s-text-subtle">
        <li class="min-w-0"><span class="block truncate">Trondheim</span></li>
      </ul>
    </footer>
  </div>
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
    expect(veidekke!.externalUrl).toBe('https://www.finn.no/job/ad/345678');
    expect(veidekke!.companyName).toBe('Veidekke ASA');
    expect(veidekke!.location).toBe('Oslo');
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
      <article class="flex h-full w-full flex-col" id="card-111222">
        <div class="flex flex-col gap-8 job-card__body p-16 h-full">
          <div>
            <a class="job-card-link h4" href="https://www.finn.no/job/ad/111222">
              <span class="inset-0 absolute" aria-hidden="true"></span>
            </a>
          </div>
        </div>
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
