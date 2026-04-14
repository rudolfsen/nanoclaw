import { RawSignal } from './types.js';

// Search for specific equipment types on Finn "ønskes kjøpt" instead of broad categories
const FINN_SEARCHES = [
  // Anleggsmaskiner
  'gravemaskin',
  'hjullaster',
  'dumper',
  'minigraver',
  'beltegraver',
  'dozer',
  // Transport
  'lastebil',
  'trekkvogn',
  'tippbil',
  'semitrailer',
  'tilhenger',
  // Landbruk
  'traktor',
  'tresker',
  'rundballepresse',
  'slåmaskin',
  'plog',
  'harv',
  'såmaskin',
  'frontlaster',
  'telehandler',
  // Merker
  'volvo maskin',
  'caterpillar',
  'komatsu',
  'hitachi',
  'john deere',
  'massey ferguson',
  'fendt',
  'claas',
  'scania',
];

// Words that indicate the listing is NOT about machinery
const NOISE_WORDS = new Set([
  'lego',
  'playmobil',
  'leketøy',
  'modell',
  'bok',
  'dvd',
  'spill',
  'klær',
  'sko',
  'møbler',
  'sofa',
  'stol',
  'bord',
  'hylle',
  'skap',
  'lampe',
  'garderobeskap',
  'kjøkken',
  'baderom',
  'seng',
  'madrass',
  'barnevogn',
  'sykkel',
  'ski',
  'iphone',
  'samsung',
  'laptop',
  'tv',
  'playstation',
  'xbox',
  'nintendo',
]);

function isRelevant(title: string): boolean {
  const lower = title.toLowerCase();
  for (const noise of NOISE_WORDS) {
    if (lower.includes(noise)) return false;
  }
  return true;
}

function parseListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];
  const adPattern =
    /<article[^>]*class="[^"]*sf-search-ad[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const block = match[1];

    const linkMatch = block.match(/href="([^"]*\/item\/(\d+)[^"]*)"/);
    if (!linkMatch) continue;
    const url = linkMatch[1].startsWith('http')
      ? linkMatch[1]
      : `https://www.finn.no${linkMatch[1]}`;
    const externalId = `finn-${linkMatch[2]}`;

    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    const priceMatch = block.match(
      /font-bold[^>]*>[\s\S]*?<span[^>]*>([\d\s]+)\s*kr/,
    );
    const price = priceMatch
      ? parseInt(priceMatch[1].replace(/\s/g, ''), 10)
      : null;

    const locMatch = block.match(
      /s-text-subtle[^>]*>[\s\S]*?<span[^>]*>([^<]+)</,
    );
    const location = locMatch ? locMatch[1].trim() : '';

    if (title && isRelevant(title)) {
      signals.push({
        source: 'finn_wanted',
        externalUrl: url,
        title,
        description: `${title} — ${location}`,
        category: '',
        price,
        contactName: null,
        contactInfo: null,
        publishedAt: new Date().toISOString().slice(0, 10),
        externalId,
      });
    }
  }

  return signals;
}

export async function scrapeFinnWanted(): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];
  const seenIds = new Set<string>();

  for (const query of FINN_SEARCHES) {
    try {
      const url = `https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const listings = parseListings(html);

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
        `[lead-scanner] Finn scrape error for "${query}": ${(err as Error).message}`,
      );
    }
  }

  return allSignals;
}
