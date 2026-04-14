import { RawSignal } from './types.js';

// Job titles that signal machinery/equipment need
const JOB_SEARCHES = [
  'maskinfører',
  'anleggsmaskinfører',
  'gravemaskinfører',
  'hjullasterfører',
  'lastebilsjåfør',
  'kranfører',
  'traktorsjåfør',
  'dumpersjåfør',
  'anleggsleder',
  'driftsleder anlegg',
  'maskinoperatør',
  'maskinist',
];

// Company names that are recruitment agencies (not the actual employer)
const RECRUITMENT_AGENCIES = new Set([
  'manpower',
  'adecco',
  'randstad',
  'kelly services',
  'jobzone',
  'proffice',
  'personalhuset',
  'xtra personell',
]);

function isRecruitmentAgency(company: string): boolean {
  const lower = company.toLowerCase();
  for (const agency of RECRUITMENT_AGENCIES) {
    if (lower.includes(agency)) return true;
  }
  return false;
}

export function parseJobListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];

  // Finn job cards: <article id="card-{id}"> with job-card-link, <strong> for company,
  // and <ul class="job-card__pills"> for location
  const adPattern =
    /<article[^>]*id="card-(\d+)"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const cardId = match[1];
    const block = match[2];
    const externalId = `finn-job-${cardId}`;

    // Extract link and title from <a class="job-card-link ...">Title</a>
    const linkMatch = block.match(
      /<a[^>]*class="[^"]*job-card-link[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    const url = linkMatch
      ? linkMatch[1].startsWith('http')
        ? linkMatch[1]
        : `https://www.finn.no${linkMatch[1]}`
      : `https://www.finn.no/job/ad/${cardId}`;
    const title = linkMatch
      ? linkMatch[2].replace(/<[^>]+>/g, '').trim()
      : '';

    // Extract company name from <strong>CompanyName</strong> inside text-caption
    const companyMatch = block.match(/<strong>([^<]+)<\/strong>/);
    const company = companyMatch ? companyMatch[1].trim() : '';

    // Extract location from <ul class="job-card__pills"> first <li><span>Location</span></li>
    const locMatch = block.match(
      /job-card__pills[\s\S]*?<li[^>]*>\s*<span[^>]*>([^<]+)<\/span>/,
    );
    const location = locMatch ? locMatch[1].trim() : '';

    // Accept listings even without company name — the job title alone is a signal
    if (title && (!company || !isRecruitmentAgency(company))) {
      signals.push({
        source: 'finn_jobs',
        externalUrl: url,
        title: `Søker: ${title} — ${company}`,
        description: [
          `Stilling: ${title}`,
          `Arbeidsgiver: ${company}`,
          `Sted: ${location}`,
          'Firma som ansetter operatorer trenger utstyr',
        ]
          .filter(Boolean)
          .join('\n'),
        category: 'Stillingsannonse',
        price: null,
        contactName: company,
        contactInfo: null,
        publishedAt: new Date().toISOString().slice(0, 10),
        externalId,
        companyName: company,
        location,
      });
    }
  }

  return signals;
}

export async function scanFinnJobs(): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  const seenIds = new Set<string>();

  for (const query of JOB_SEARCHES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const url = `https://www.finn.no/job/search?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const html = await res.text();
      const listings = parseJobListings(html);

      for (const signal of listings) {
        if (!seenIds.has(signal.externalId)) {
          seenIds.add(signal.externalId);
          allSignals.push(signal);
        }
      }

      // Rate limit between searches
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      clearTimeout(timeout);
      console.error(
        `[lead-scanner] Finn jobs scrape error for "${query}": ${(err as Error).message}`,
      );
    }
  }

  return allSignals;
}
