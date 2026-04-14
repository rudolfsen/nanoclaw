import { RawSignal } from './types.js';

const FINN_URLS = [
  'https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&category=0.67',  // Landbruk
  'https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&category=0.69',  // Næringsvirksomhet
];

function parseListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];
  // Match each article.sf-search-ad block
  const adPattern = /<article[^>]*class="[^"]*sf-search-ad[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const block = match[1];

    // Extract link and ID
    const linkMatch = block.match(/href="([^"]*\/item\/(\d+)[^"]*)"/);
    if (!linkMatch) continue;
    const url = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.finn.no${linkMatch[1]}`;
    const externalId = `finn-${linkMatch[2]}`;

    // Extract title
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    // Extract price
    const priceMatch = block.match(/font-bold[^>]*>[\s\S]*?<span[^>]*>([\d\s]+)\s*kr/);
    const price = priceMatch
      ? parseInt(priceMatch[1].replace(/\s/g, ''), 10)
      : null;

    // Extract location
    const locMatch = block.match(/s-text-subtle[^>]*>[\s\S]*?<span[^>]*>([^<]+)</);
    const location = locMatch ? locMatch[1].trim() : '';

    if (title) {
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

  for (const baseUrl of FINN_URLS) {
    try {
      // Fetch first 2 pages
      for (let page = 1; page <= 2; page++) {
        const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
        });
        if (!res.ok) break;
        const html = await res.text();
        allSignals.push(...parseListings(html));
      }
    } catch (err) {
      console.error(`[lead-scanner] Finn scrape error: ${(err as Error).message}`);
    }
  }

  return allSignals;
}
