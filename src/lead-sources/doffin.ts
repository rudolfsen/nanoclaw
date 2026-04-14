import { RawSignal } from './types.js';

const SEARCH_API = 'https://api.doffin.no/webclient/api/v2/search-api/search';

// CPV codes relevant to construction/infrastructure machinery needs
const CPV_CODES = [
  '45000000', // Construction work
  '45200000', // Complete/part construction and civil engineering
  '45230000', // Pipelines, highways, roads, airfields, railways
  '43000000', // Mining, quarrying, construction equipment
  '16000000', // Agricultural machinery
  '34000000', // Transport equipment
];

interface DoffinHit {
  id: string;
  heading: string;
  description: string;
  buyer: Array<{ id: string; organizationId: string; name: string }>;
  estimatedValue: { currencyCode: string; amount: number } | null;
  type: string;
  status: string;
  issueDate: string;
  deadline: string | null;
  publicationDate: string;
  placeOfPerformance: string[];
  locationId: string[];
}

interface DoffinSearchResponse {
  numHitsTotal: number;
  numHitsAccessible: number;
  hits: DoffinHit[];
}

async function searchDoffin(
  cpvCode: string,
  fromDate: string,
  noticeTypes: string[],
): Promise<DoffinHit[]> {
  const body = {
    numHitsPerPage: 50,
    page: 1,
    searchString: '',
    sortBy: 'PUBLICATION_DATE',
    facets: {
      cpvCodesId: { checkedItems: [cpvCode] },
      type: { checkedItems: noticeTypes },
      status: { checkedItems: [] },
      contractNature: { checkedItems: [] },
      publicationDate: { from: fromDate, to: null },
      location: { checkedItems: [] },
      buyer: { checkedItems: [] },
      winner: { checkedItems: [] },
    },
  };

  const res = await fetch(SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://doffin.no',
      Referer: 'https://doffin.no/',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Doffin search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as DoffinSearchResponse;
  return data.hits;
}

export async function scanDoffin(): Promise<RawSignal[]> {
  const signals: RawSignal[] = [];
  const seenIds = new Set<string>();

  // Look back 7 days for new notices
  const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // Scan active tenders (companies will need equipment to fulfill these)
  const activeTypes = ['ANNOUNCEMENT_OF_COMPETITION'];
  // Scan awarded contracts (winners definitely need equipment now)
  const awardedTypes = ['ANNOUNCEMENT_OF_CONCLUSION_OF_CONTRACT'];

  for (const cpv of CPV_CODES) {
    for (const types of [activeTypes, awardedTypes]) {
      try {
        const hits = await searchDoffin(cpv, fromDate, types);

        for (const hit of hits) {
          const id = `doffin-${hit.id}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);

          const buyerName = hit.buyer?.[0]?.name ?? 'Ukjent';
          const buyerOrgnr = hit.buyer?.[0]?.organizationId ?? null;
          const isAwarded = types === awardedTypes;

          signals.push({
            source: 'doffin',
            externalUrl: `https://doffin.no/notices/${hit.id}`,
            title: hit.heading,
            description: [
              hit.description?.slice(0, 500),
              hit.estimatedValue
                ? `Estimert verdi: ${hit.estimatedValue.amount.toLocaleString('no-NO')} ${hit.estimatedValue.currencyCode}`
                : null,
              hit.deadline ? `Frist: ${hit.deadline.slice(0, 10)}` : null,
              isAwarded ? 'TILDELT — vinner trenger utstyr' : null,
            ]
              .filter(Boolean)
              .join('\n'),
            category: cpv,
            price: hit.estimatedValue?.amount ?? null,
            contactName: buyerName,
            contactInfo: buyerOrgnr,
            publishedAt: hit.publicationDate,
            externalId: id,
            companyName: buyerName,
            companyOrgnr: buyerOrgnr ?? undefined,
            location: hit.placeOfPerformance?.[0],
          });
        }

        // Rate limit between API calls
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        console.error(
          `[lead-scanner] Doffin scan error CPV=${cpv}: ${(err as Error).message}`,
        );
      }
    }
  }

  return signals;
}
