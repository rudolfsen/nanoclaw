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

  // Finn job listings use article tags with card IDs
  const adPattern =
    /<article[^>]*id="card-(\d+)"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const cardId = match[1];
    const block = match[2];
    const externalId = `finn-job-${cardId}`;

    // Extract link
    const linkMatch = block.match(/href="([^"]*\/job[^"]*)"/);
    const url = linkMatch
      ? (linkMatch[1].startsWith('http')
          ? linkMatch[1]
          : `https://www.finn.no${linkMatch[1]}`)
      : `https://www.finn.no/job/${cardId}`;

    // Extract title
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    // Extract company name — Finn jobs uses various class names
    const companyMatch =
      block.match(/class="[^"]*employer[^"]*"[^>]*>([^<]+)</) ??
      block.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)</) ??
      block.match(/class="[^"]*organization[^"]*"[^>]*>([^<]+)</) ??
      block.match(/<span[^>]*>([^<]{3,40})<\/span>\s*<span[^>]*>[^<]*<\/span>\s*$/m);
    const company = companyMatch ? companyMatch[1].trim() : '';

    // Extract location
    const locMatch = block.match(
      /s-text-subtle[^>]*>[\s\S]*?<span[^>]*>([^<]+)</,
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
          'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)',
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
