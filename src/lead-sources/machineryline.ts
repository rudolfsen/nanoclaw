import { RawSignal } from './types.js';

const ML_URLS = [
  'https://www.machineryline.com/-/excavators--c163',
  'https://www.machineryline.com/-/wheel-loaders--c164',
  'https://www.machineryline.com/-/tractors--c185',
  'https://www.machineryline.com/-/dump-trucks--c167',
];

function parseListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];

  // Match each sl-item div using data-code attribute
  const adPattern = /<div[^>]*class="[^"]*sl-item[^"]*"[^>]*data-code="(\d+)"[^>]*data-name="([^"]*)"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*sl-item[^"]*"|<\/section>)/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const externalId = `ml-${match[1]}`;
    const title = match[2];
    const block = match[3];

    // Extract link
    const linkMatch = block.match(/href="(\/[^"]*sale[^"]*)"/);
    const url = linkMatch
      ? `https://www.machineryline.com${linkMatch[1]}`
      : `https://www.machineryline.com`;

    // Extract price
    const priceMatch = block.match(/price-value[^>]*title="Price"[^>]*>([^<]+)/);
    let price: number | null = null;
    if (priceMatch) {
      const raw = priceMatch[1].replace(/[^0-9.,]/g, '');
      price = parseInt(raw.replace(/[.,]/g, ''), 10);
      // Machineryline shows EUR by default for .com
      if (price && !priceMatch[1].includes('NOK')) {
        price = Math.round(price * 11.1);
      }
    }

    // Extract location
    const locMatch = block.match(/location-text[^>]*>([^<]+)/);
    const location = locMatch ? locMatch[1].trim() : '';

    // Extract year and hours
    const yearMatch = block.match(/title="year"[^>]*>([^<]+)/);
    const hoursMatch = block.match(/title="running hours"[^>]*>([^<]+)/);
    const year = yearMatch ? yearMatch[1].trim() : '';
    const hours = hoursMatch ? hoursMatch[1].trim() : '';

    if (title) {
      signals.push({
        source: 'machineryline',
        externalUrl: url,
        title,
        description: `${title} ${year} ${hours} — ${location}`.trim(),
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

export async function scrapeMachineryline(): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];

  for (const url of ML_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      allSignals.push(...parseListings(html));
    } catch (err) {
      console.error(`[lead-scanner] Machineryline scrape error: ${(err as Error).message}`);
    }
  }

  return allSignals;
}
