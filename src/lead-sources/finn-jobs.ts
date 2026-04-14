import { RawSignal } from './types.js';

// Job titles that signal machinery/equipment need
const JOB_SEARCHES = [
  'maskinforer',
  'anleggsmaskinforer',
  'gravemaskinforer',
  'hjullasterforer',
  'lastebilsjafor',
  'kranforer',
  'traktorsjaafor',
  'dumpersjaafor',
  'anleggsleder',
  'driftsleder anlegg',
  'maskinoperator',
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

  // Finn job listings use the same article pattern as BAP
  const adPattern =
    /<article[^>]*class="[^"]*sf-search-ad[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const block = match[1];

    // Extract link and Finn ID
    const linkMatch = block.match(
      /href="([^"]*(?:\/job\/fulltime\/ad\.html\?finnkode=|\/item\/)(\d+)[^"]*)"/,
    );
    if (!linkMatch) continue;
    const url = linkMatch[1].startsWith('http')
      ? linkMatch[1]
      : `https://www.finn.no${linkMatch[1]}`;
    const externalId = `finn-job-${linkMatch[2]}`;

    // Extract title
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    // Extract company name (typically in a span or div before location)
    const companyMatch =
      block.match(/class="[^"]*employer[^"]*"[^>]*>([^<]+)</) ??
      block.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)</);
    const company = companyMatch ? companyMatch[1].trim() : '';

    // Extract location
    const locMatch = block.match(
      /s-text-subtle[^>]*>[\s\S]*?<span[^>]*>([^<]+)</,
    );
    const location = locMatch ? locMatch[1].trim() : '';

    if (title && company && !isRecruitmentAgency(company)) {
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
    try {
      const url = `https://www.finn.no/job/fulltime/search.html?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)',
        },
      });
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
      console.error(
        `[lead-scanner] Finn jobs scrape error for "${query}": ${(err as Error).message}`,
      );
    }
  }

  return allSignals;
}
