import { RawSignal } from './types.js';

const MASCUS_URLS = [
  'https://www.mascus.no/anlegg/gravemaskiner',
  'https://www.mascus.no/anlegg/hjullastere',
  'https://www.mascus.no/landbruk/traktorer',
  'https://www.mascus.no/transport/lastebiler',
];

function parseListings(html: string): RawSignal[] {
  const signals: RawSignal[] = [];

  // Match listing blocks using data-index attribute
  const adPattern =
    /<div[^>]*data-index="(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]*data-index="|$)/gi;
  let match;

  while ((match = adPattern.exec(html)) !== null) {
    const block = match[2];

    // Extract link
    const linkMatch = block.match(/href="(\/[^"]*\.html)"/);
    if (!linkMatch) continue;
    const url = `https://www.mascus.no${linkMatch[1]}`;
    const externalId = `mascus-${linkMatch[1].replace(/[^a-zA-Z0-9]/g, '-')}`;

    // Extract title from h3
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    // Extract price
    const priceMatch = block.match(/heading5[^>]*>([\d\s,.]+)\s*(NOK|EUR)/i);
    let price: number | null = null;
    if (priceMatch) {
      price = parseInt(priceMatch[1].replace(/[\s,.]/g, ''), 10);
      if (priceMatch[2].toUpperCase() === 'EUR')
        price = Math.round(price * 11.1);
    }

    // Extract specs (year, hours, location)
    const specsMatch = block.match(/basicText2Style[^>]*>([^<]+)/);
    const specs = specsMatch ? specsMatch[1].trim() : '';

    if (title) {
      signals.push({
        source: 'mascus',
        externalUrl: url,
        title,
        description: `${title} — ${specs}`,
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

export async function scrapeMascus(): Promise<RawSignal[]> {
  const allSignals: RawSignal[] = [];

  for (const url of MASCUS_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const html = await res.text();
      allSignals.push(...parseListings(html));
    } catch (err) {
      clearTimeout(timeout);
      console.error(
        `[lead-scanner] Mascus scrape error: ${(err as Error).message}`,
      );
    }
  }

  return allSignals;
}
