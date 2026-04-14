import { RawSignal } from './types.js';

const BRREG_API = 'https://data.brreg.no/enhetsregisteret/api';

// NACE codes where new companies signal equipment demand
const TARGET_NACE_CODES = ['41', '42', '43', '01', '49'];

const NACE_DESCRIPTIONS: Record<string, string> = {
  '41': 'Bygg — oppforing av bygninger',
  '42': 'Anlegg — anleggsvirksomhet',
  '43': 'Spesialisert bygge- og anleggsvirksomhet',
  '01': 'Jordbruk',
  '49': 'Landtransport',
};

interface BrregEntity {
  organisasjonsnummer: string;
  navn: string;
  organisasjonsform: { kode: string; beskrivelse: string };
  registreringsdatoEnhetsregisteret: string;
  naeringskode1?: { kode: string; beskrivelse: string };
  forretningsadresse?: {
    postnummer: string;
    poststed: string;
    adresse: string[];
    kommune: string;
  };
  konkurs: boolean;
  konkursdato?: string;
  underAvvikling: boolean;
  underAvviklingDato?: string;
  epostadresse?: string;
  aktivitet?: string[];
  antallAnsatte?: number;
}

interface BrregPage {
  _embedded: { enheter: BrregEntity[] };
  page: { totalElements: number; totalPages: number; number: number };
}

async function fetchNewRegistrations(
  naceCode: string,
  fromDate: string,
): Promise<BrregEntity[]> {
  const url = new URL(`${BRREG_API}/enheter`);
  url.searchParams.set('naeringskode', naceCode);
  url.searchParams.set('fraRegistreringsdatoEnhetsregisteret', fromDate);
  url.searchParams.set('size', '50');
  url.searchParams.set('page', '0');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Brreg API failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as BrregPage;
  return data._embedded?.enheter ?? [];
}

async function fetchBankruptcies(naceCode: string): Promise<BrregEntity[]> {
  const entities: BrregEntity[] = [];

  // Fetch actual bankruptcies (konkurs=true)
  const konkursUrl = new URL(`${BRREG_API}/enheter`);
  konkursUrl.searchParams.set('naeringskode', naceCode);
  konkursUrl.searchParams.set('konkurs', 'true');
  konkursUrl.searchParams.set('size', '50');
  konkursUrl.searchParams.set('page', '0');

  const konkursRes = await fetch(konkursUrl.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (konkursRes.ok) {
    const data = (await konkursRes.json()) as BrregPage;
    entities.push(...(data._embedded?.enheter ?? []));
  }

  // Fetch companies under voluntary dissolution
  const avviklingUrl = new URL(`${BRREG_API}/enheter`);
  avviklingUrl.searchParams.set('naeringskode', naceCode);
  avviklingUrl.searchParams.set('underAvvikling', 'true');
  avviklingUrl.searchParams.set('size', '50');
  avviklingUrl.searchParams.set('page', '0');

  const avviklingRes = await fetch(avviklingUrl.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (avviklingRes.ok) {
    const data = (await avviklingRes.json()) as BrregPage;
    entities.push(...(data._embedded?.enheter ?? []));
  }

  return entities;
}

export async function scanBrreg(): Promise<RawSignal[]> {
  const signals: RawSignal[] = [];
  const seenOrgnr = new Set<string>();

  // Look back 14 days for new registrations
  const fromDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // --- New registrations (growth signals) ---
  for (const nace of TARGET_NACE_CODES) {
    try {
      const entities = await fetchNewRegistrations(nace, fromDate);
      for (const entity of entities) {
        if (seenOrgnr.has(entity.organisasjonsnummer)) continue;
        seenOrgnr.add(entity.organisasjonsnummer);

        const naceDesc =
          NACE_DESCRIPTIONS[nace] ??
          entity.naeringskode1?.beskrivelse ??
          '';
        const addr = entity.forretningsadresse;

        signals.push({
          source: 'brreg_new',
          externalUrl: `https://data.brreg.no/enhetsregisteret/api/enheter/${entity.organisasjonsnummer}`,
          title: `Nyregistrert: ${entity.navn} (${naceDesc})`,
          description: [
            `Org.nr: ${entity.organisasjonsnummer}`,
            `Type: ${entity.organisasjonsform.beskrivelse}`,
            `Bransje: ${entity.naeringskode1?.beskrivelse ?? nace}`,
            entity.aktivitet?.join(', '),
            addr
              ? `Adresse: ${addr.adresse?.join(', ')}, ${addr.poststed}`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
          category: naceDesc,
          price: null,
          contactName: entity.navn,
          contactInfo: entity.epostadresse ?? null,
          publishedAt: entity.registreringsdatoEnhetsregisteret,
          externalId: `brreg-new-${entity.organisasjonsnummer}`,
          companyName: entity.navn,
          companyOrgnr: entity.organisasjonsnummer,
          naceCode: entity.naeringskode1?.kode ?? nace,
          location: addr?.poststed,
        });
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(
        `[lead-scanner] Brreg new-reg scan error NACE=${nace}: ${(err as Error).message}`,
      );
    }
  }

  // --- Bankruptcies and dissolutions (change/supply signals) ---
  const seenBankrupt = new Set<string>();

  for (const nace of TARGET_NACE_CODES) {
    try {
      const entities = await fetchBankruptcies(nace);
      for (const entity of entities) {
        if (seenBankrupt.has(entity.organisasjonsnummer)) continue;
        seenBankrupt.add(entity.organisasjonsnummer);

        // Only include recent bankruptcies (last 30 days)
        const eventDate = entity.konkursdato ?? entity.underAvviklingDato;
        if (eventDate) {
          const eventTime = new Date(eventDate).getTime();
          const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
          if (eventTime < thirtyDaysAgo) continue;
        }

        const isBankrupt = entity.konkurs;
        const label = isBankrupt ? 'Konkurs' : 'Under avvikling';
        const naceDesc =
          NACE_DESCRIPTIONS[nace] ??
          entity.naeringskode1?.beskrivelse ??
          '';
        const addr = entity.forretningsadresse;

        signals.push({
          source: 'brreg_bankrupt',
          externalUrl: `https://data.brreg.no/enhetsregisteret/api/enheter/${entity.organisasjonsnummer}`,
          title: `${label}: ${entity.navn} (${naceDesc})`,
          description: [
            `Org.nr: ${entity.organisasjonsnummer}`,
            `Status: ${label}`,
            eventDate ? `Dato: ${eventDate}` : null,
            `Bransje: ${entity.naeringskode1?.beskrivelse ?? nace}`,
            entity.aktivitet?.join(', '),
            entity.antallAnsatte
              ? `Ansatte: ${entity.antallAnsatte}`
              : null,
            addr
              ? `Adresse: ${addr.adresse?.join(', ')}, ${addr.poststed}`
              : null,
            '-- Mulig utstyr til salgs --',
          ]
            .filter(Boolean)
            .join('\n'),
          category: naceDesc,
          price: null,
          contactName: entity.navn,
          contactInfo: entity.epostadresse ?? null,
          publishedAt: eventDate ?? new Date().toISOString().slice(0, 10),
          externalId: `brreg-bankrupt-${entity.organisasjonsnummer}`,
          companyName: entity.navn,
          companyOrgnr: entity.organisasjonsnummer,
          naceCode: entity.naeringskode1?.kode ?? nace,
          location: addr?.poststed,
        });
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(
        `[lead-scanner] Brreg bankruptcy scan error NACE=${nace}: ${(err as Error).message}`,
      );
    }
  }

  return signals;
}
