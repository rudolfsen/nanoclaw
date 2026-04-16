import Anthropic from '@anthropic-ai/sdk';

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

// Words that indicate the listing is NOT about real machinery
const NOISE_WORDS = new Set([
  // Leker og modeller
  'lego',
  'playmobil',
  'leketøy',
  'leke',
  'brio',
  'bruder',
  'siku',
  'dickie',
  'teama',
  'orlandoo',
  'rc4wd',
  'tamiya',
  'modellbil',
  'miniatyr',
  'diecast',
  '1:32',
  '1:50',
  '1:87',
  '1:16',
  'collection',
  'at collection',
  'hardplast',
  'trekkvogn',
  // Bøker, brosjyrer, media
  'bok',
  'bøker',
  'brosjyre',
  'dvd',
  'cd',
  'spill',
  'instruksjonsbok',
  'manual',
  'katalog',
  'plakat',
  'poster',
  // Klær og tilbehør
  'klær',
  'sko',
  'støvletter',
  'jakke',
  'bukse',
  'caps',
  't-skjorte',
  // Møbler og interiør
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
  // Barn og fritid
  'barnevogn',
  'sykkel',
  'ski',
  'sparkesykkel',
  // Elektronikk
  'iphone',
  'samsung',
  'laptop',
  'tv',
  'playstation',
  'xbox',
  'nintendo',
  'telefon',
  'nettbrett',
  // Samleobjekter og modeller
  'majorette',
  'matchbox',
  'hot wheels',
  'hotwheels',
  'corgi',
  'tonka',
  'blikkbil',
  'vintage',
  'retro',
  'made in france',
  'made in japan',
  'made in china',
  'serie 200',
  'pysjheltene',
  'paw patrol',
  'for rc',
  'rc bil',
  'rc lastebil',
  'rc traktor',
  // Klær med merkenavn
  'størrelse',
  'str.',
  // Treleker og lekelastebiler
  'i tre',
  'tre:',
  'tråtraktor',
  'tråbil',
  'lekebil',
  'lekekjøretøy',
  'helikopter',
  // Deler og tilbehør (ikke hele maskiner)
  'deler til',
  'deler for',
  'diverse deler',
  'reservedeler',
  'navkapsel',
  'framskjermer',
  'bakskjermer',
  'arbeidslys',
  'hengerfeste',
  'panser',
  'starter',
  'dekk ',
  'hjulsett',
  'felg',
  'krok',
  'kniv til',
  'bremsebelegg',
  'eksospotte',
  'turbo til',
  'generator til',
  'dynamo',
  'girskifte',
  'clutch',
  'feiekost',
  'jordfres',
  // Gis bort
  'gis bort',
  'gratis',
  // Verktøy/småting
  'vater',
  'vaterpass',
  // Verktøy som matcher maskin-nøkkelord
  'sagblad',
  'hole dozer',
  'milwaukee',
  'bosch',
  'dewalt',
  'makita',
  'boresett',
  'bits',
  // Lego/Space
  'sealed',
  'space dozer',
  'lego ',
  // Utleie (ikke kjøp)
  'til leie',
  'utleie',
  'leies ut',
  // Hage/småmaskiner
  'hagetraktor',
  'gressklipp',
  'robotklipper',
  // Tråtraktorer (leker)
  'trå traktor',
  'tråtraktor',
  'pedal',
  // Deler (utvidet)
  'bakhjul til',
  'framhjul til',
  'bremseklokke',
  'braketter',
  'tenningslås',
  'hydraulikkslange',
  'oljefilter',
  'luftfilter',
  'registerreim',
  'toppakning',
  'sylinderforing',
  'stempelring',
  'snøskjær',
  'skjærs plog',
  // Dødsbo/konkursbo (salg, ikke kjøp)
  'dødsbo',
  'konkursbo',
  'fra bo',
  // Andre irrelevante
  'falkberget',
  'trollmannen',
  'disney',
  'julegave',
]);

function isRelevant(title: string): boolean {
  const lower = title.toLowerCase();
  // Check noise words
  for (const noise of NOISE_WORDS) {
    if (lower.includes(noise)) return false;
  }
  // Filter model scale patterns (1:32, 1:50, etc.)
  if (/\b1:\d{2}\b/.test(lower)) return false;
  // Filter "selges" / "til salgs" listings (supply, not demand)
  if (
    (lower.includes('selges') ||
      lower.includes('til salgs') ||
      lower.includes('som ny') ||
      lower.includes('på lager') ||
      lower.includes('kampanje')) &&
    !lower.includes('ønskes')
  )
    return false;
  // Filter single-word titles (too vague)
  if (
    lower
      .replace(/[^\w\sæøå]/g, '')
      .trim()
      .split(/\s+/).length <= 1
  )
    return false;
  // Positive signal: boost relevance if the ad contains buy-intent words
  // If it has none and doesn't mention a known equipment type, it's likely a misplaced sales ad
  const hasBuyIntent =
    lower.includes('ønskes') ||
    lower.includes('kjøpes') ||
    lower.includes('kjøpe') ||
    lower.includes('søker') ||
    lower.includes('trenger') ||
    lower.includes('leter etter') ||
    lower.includes('bud ønskes');
  const hasEquipmentType =
    /gravemaskin|minigraver|hjullaster|dumper|lastebil|trekkvogn|tippbil|traktor|tresker|plog|harv|frontlaster|tilhenger|semitrailer/.test(
      lower,
    );
  // If no buy intent and no equipment type — likely a misplaced ad
  if (!hasBuyIntent && !hasEquipmentType) return false;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const url = `https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      });
      clearTimeout(timeout);
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
      clearTimeout(timeout);
      console.error(
        `[lead-scanner] Finn scrape error for "${query}": ${(err as Error).message}`,
      );
    }
  }

  // AI classification: filter to only real buy-intent for whole machines
  if (allSignals.length === 0) return allSignals;

  try {
    const client = new Anthropic();
    const titles = allSignals.map((s) => s.title);

    // Batch classify in chunks of 50
    const classified: boolean[] = [];
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const numbered = batch
        .map((t, idx) => `${i + idx + 1}. ${t}`)
        .join('\n');

      const response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: `Du er en klassifiserer for en maskin- og utstyrsforhandler (ATS Norway / Landbrukssalg).

Se på disse Finn.no "ønskes kjøpt"-annonsene og avgjør for HVER om det er en person som GENUINT VIL KJØPE en hel maskin, traktor, lastebil eller stort utstyr.

Svar BARE med numrene på de som er reelle kjøps-leads. Ignorer:
- Reservedeler, tilbehør, dekk, felger, deler
- Leker, modeller, bøker, klær, DJ-utstyr
- Salgsannonser feilplassert som "ønskes kjøpt"
- Utleie-annonser
- Hagemaskiner, robotklippere, småverktøy
- Dekorasjon, pynt
- Alt som ikke er en hel maskin/kjøretøy noen vil KJØPE

Annonser:
${numbered}

Svar med bare numrene separert av komma (f.eks. "1,3,7,12"). Hvis ingen er relevante, svar "INGEN".`,
          },
        ],
      });

      const text =
        response.content[0].type === 'text' ? response.content[0].text : '';

      if (text.trim() === 'INGEN') {
        classified.push(...batch.map(() => false));
      } else {
        const validNumbers = new Set(
          text
            .split(/[,\s]+/)
            .map((n) => parseInt(n.trim(), 10))
            .filter((n) => !isNaN(n)),
        );
        for (let j = 0; j < batch.length; j++) {
          classified.push(validNumbers.has(i + j + 1));
        }
      }
    }

    const filtered = allSignals.filter((_, idx) => classified[idx]);
    console.log(
      `[lead-scanner] Finn AI filter: ${allSignals.length} → ${filtered.length} (${allSignals.length - filtered.length} removed)`,
    );
    return filtered;
  } catch (err) {
    console.error(
      `[lead-scanner] Finn AI classification failed, returning unfiltered: ${(err as Error).message}`,
    );
    return allSignals;
  }
}
