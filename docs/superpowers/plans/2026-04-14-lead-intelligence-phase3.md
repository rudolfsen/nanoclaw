# Lead Intelligence Phase 3 — Public Data & Social Signals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan public procurement databases (Doffin), the national business registry (Bronnøysund), and job listings (Finn jobs) for indirect signals that indicate demand for machinery. New companies in construction/agriculture = growth signal. Bankruptcies = supply signal (equipment for sale). Public contracts = upcoming demand. Job postings for operators = active equipment need.

**Architecture:** Three new source modules plug into the existing lead scanner (`src/lead-scanner.ts`). Each source returns `RawSignal[]` using the established interface (extended with new source types). The Doffin and Bronnøysund sources use structured JSON APIs. Finn jobs uses HTML scraping (same pattern as `finn-wanted.ts`). A new `company_name` field and `nace_code` field on `RawSignal` carry business metadata for these institutional sources.

**Tech Stack:** TypeScript, better-sqlite3, SQLite, Node.js fetch (Doffin API, Bronnøysund API, Finn HTML scraping)

**Spec:** `docs/superpowers/specs/2026-04-14-lead-intelligence-design.md` (Fase 2/3 sections)

---

## API Research Summary

### Doffin (Public Procurement)

Doffin runs as a SPA backed by a JSON API. No authentication required.

**Search endpoint (POST):**
```
POST https://api.doffin.no/webclient/api/v2/search-api/search
Content-Type: application/json
Origin: https://doffin.no
```

**Request body:**
```json
{
  "numHitsPerPage": 20,
  "page": 1,
  "searchString": "",
  "sortBy": "RELEVANCE",
  "facets": {
    "cpvCodesId": { "checkedItems": ["45000000"] },
    "type": { "checkedItems": ["ANNOUNCEMENT_OF_COMPETITION"] },
    "status": { "checkedItems": ["ACTIVE"] },
    "contractNature": { "checkedItems": [] },
    "publicationDate": { "from": "2026-04-01", "to": null },
    "location": { "checkedItems": [] },
    "buyer": { "checkedItems": [] },
    "winner": { "checkedItems": [] }
  }
}
```

**Response (key fields per hit):**
```json
{
  "id": "2026-106721",
  "heading": "Rehabilitering og nybygg - E913 Sceneteknikk",
  "description": "Full description text...",
  "buyer": [{ "id": "...", "organizationId": "971045698", "name": "Rogaland fylkeskommune" }],
  "estimatedValue": { "currencyCode": "NOK", "amount": 15500000.0 },
  "type": "ANNOUNCEMENT_OF_COMPETITION",
  "status": "ACTIVE",
  "issueDate": "2026-04-14T08:56:38Z",
  "deadline": "2026-05-07T10:00:58Z",
  "publicationDate": "2026-04-14",
  "placeOfPerformance": ["Rogaland"],
  "locationId": ["NO0A1"]
}
```

**Notice detail endpoint (GET):**
```
GET https://api.doffin.no/webclient/api/v2/notices-api/notices/{id}
```

Returns full notice with `allCpvCodes`, `directCpvCodes`, `awardedNames`, `changeNotices`, `procurementTimeline`.

**Relevant CPV codes for construction/infrastructure:**
- `45000000` — Construction work (main)
- `45200000` — Works for complete or part construction and civil engineering
- `45230000` — Construction work for pipelines, communication and power lines, for highways, roads, airfields and railways
- `43000000` — Machinery for mining, quarrying, construction equipment
- `16000000` — Agricultural machinery
- `34000000` — Transport equipment and auxiliary products to transportation

**Facet values for type:**
- `ANNOUNCEMENT_OF_COMPETITION` — active tenders (primary interest)
- `RESULT` / `ANNOUNCEMENT_OF_CONCLUSION_OF_CONTRACT` — awarded contracts (winners = companies that need equipment)
- `PLANNING` / `ADVISORY_NOTICE` — upcoming projects

### Bronnøysund Enhetsregisteret

Fully open REST API. No authentication required. JSON responses with HAL links.

**Base URL:** `https://data.brreg.no/enhetsregisteret/api`

**Endpoints:**
- `GET /enheter` — search/filter entities
- `GET /enheter/{orgnr}` — single entity detail
- `GET /oppdateringer/enheter` — change feed (new registrations, changes, deletions)

**Key query parameters for `/enheter`:**
| Parameter | Example | Description |
|-----------|---------|-------------|
| `naeringskode` | `41` | Filter by NACE code prefix |
| `fraRegistreringsdatoEnhetsregisteret` | `2026-04-01` | Registration date from (yyyy-MM-dd) |
| `tilRegistreringsdatoEnhetsregisteret` | `2026-04-14` | Registration date to |
| `konkurs` | `true` | Filter bankruptcies only |
| `underAvvikling` | `true` | Filter companies under dissolution |
| `underTvangsavviklingEllerTvangsopplosning` | `true` | Filter forced dissolution |
| `size` | `20` | Page size |
| `page` | `0` | Page number (0-indexed) |

**Response per entity (key fields):**
```json
{
  "organisasjonsnummer": "937513275",
  "navn": "ANDREAS KARLSSON",
  "organisasjonsform": { "kode": "AS", "beskrivelse": "Aksjeselskap" },
  "registreringsdatoEnhetsregisteret": "2026-04-11",
  "naeringskode1": { "kode": "41.000", "beskrivelse": "Oppforing av bygninger" },
  "forretningsadresse": {
    "postnummer": "2390", "poststed": "MOELV",
    "adresse": ["Puttenvegen 6"], "kommune": "RINGSAKER"
  },
  "konkurs": false,
  "konkursdato": null,
  "underAvvikling": false,
  "underAvviklingDato": null,
  "epostadresse": "post@example.no",
  "aktivitet": ["Tomrer, oppforing og vedlikehold av bygninger."]
}
```

**Updates endpoint:**
```
GET /oppdateringer/enheter?dato=2026-04-13T00:00:00.000Z&size=100
```

Returns change events with `endringstype`: `"Ny"`, `"Endring"`, `"Sletting"`. Each event has `organisasjonsnummer` linked to the entity endpoint.

**Target NACE codes:**
| Code | Description | Signal type |
|------|-------------|-------------|
| `41` | Oppforing av bygninger | growth |
| `42` | Anleggsvirksomhet | growth |
| `43` | Spesialisert bygge- og anleggsvirksomhet | growth |
| `01` | Jordbruk og tjenester tilknyttet jordbruk, jakt | growth |
| `49` | Landtransport og roertransport | growth |

### Finn Stillingsannonser

Finn.no job listings are server-rendered HTML. No public JSON API for job search results (the `search-qf` endpoint requires internal auth). HTML scraping is required, same approach as existing `finn-wanted.ts`.

**Search URL pattern:**
```
https://www.finn.no/job/fulltime/search.html?q={query}&page={page}
```

**Relevant search queries:**
- `maskinforer` — machine operator
- `anleggsmaskinforer` — construction machine operator
- `gravemaskinforer` — excavator operator
- `hjullasterforer` — wheel loader operator
- `lastebilsjafor` — truck driver
- `traktorsjaafor` — tractor driver
- `kranforer` — crane operator
- `anleggsleder` — construction site manager
- `driftsleder anlegg` — operations manager construction

**URL filter parameters (from page analysis):**
- `occupation=0.23` — Transport og logistikk
- `occupation=0.68` — Bygg og anlegg
- `industry=14` — Construction
- `page=N` — Pagination

**HTML structure:** Same `<article>` pattern as BAP listings — articles with class `sf-search-ad`, containing `<h2>` titles, `<a>` links with `/job/fulltime/ad.html?finnkode=NNNN`, company name, and location spans.

### Landbruksdirektoratet / SSB Farm Demographics

No direct API from Landbruksdirektoratet. However, SSB (Statistics Norway) provides farm operator age data via their open API.

**SSB API:**
```
POST https://data.ssb.no/api/v0/no/table/13366
```

Table 13366: "Jordbruksbedrifter med personleg brukar, etter driftsform, alder" (2010-2020).

Age brackets: Under 40, 40-49, 50-59, 60-69, 70+. Broken down by farm type (grain, dairy, beef, sheep, etc.) and region.

**Assessment:** This data is static (published yearly, last update 2020). Not suitable for real-time scanning. Useful as background intelligence for seasonal prioritization, but not worth a dedicated scanner module. Recommend: download once, use as reference data for lead scoring in Phase 4.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lead-sources/types.ts` | Modify | Extend `RawSignal` source union and add optional company metadata fields |
| `src/lead-sources/doffin.ts` | Create | Scan Doffin API for public procurement contracts |
| `src/lead-sources/brreg.ts` | Create | Scan Bronnøysund for new registrations and bankruptcies |
| `src/lead-sources/finn-jobs.ts` | Create | Scrape Finn job listings for operator/driver postings |
| `src/lead-scanner.ts` | Modify | Add Phase 3 sources to scan loop, add `company_name`/`nace_code` columns |
| `src/lead-scanner.test.ts` | Modify | Tests for Phase 3 sources and new signal types |
| `container/skills/leads/leads.sh` | Modify | Add `growth`, `changes` commands |

---

### Task 1: Extend types and DB schema for Phase 3 sources

Add new source types and optional business metadata to the shared types and database schema.

**Files:**
- Modify: `src/lead-sources/types.ts`
- Modify: `src/lead-scanner.ts`
- Modify: `src/lead-scanner.test.ts`

- [ ] **Step 1: Extend RawSignal source union**

In `src/lead-sources/types.ts`, add the new source identifiers to the `source` union type and add optional company metadata fields:

```typescript
export interface RawSignal {
  source:
    | 'finn_wanted'
    | 'finn_supply'
    | 'mascus'
    | 'machineryline'
    | 'doffin'
    | 'brreg_new'
    | 'brreg_bankrupt'
    | 'finn_jobs';
  externalUrl: string;
  title: string;
  description: string;
  category: string;
  price: number | null;
  contactName: string | null;
  contactInfo: string | null;
  publishedAt: string;
  externalId: string;
  // Phase 3 — business metadata (optional for backward compat)
  companyName?: string;
  companyOrgnr?: string;
  naceCode?: string;
  location?: string;
}
```

- [ ] **Step 2: Add DB columns for company metadata**

In `src/lead-scanner.ts`, update `initLeadDb` to add columns for Phase 3 data. Use `ALTER TABLE ... ADD COLUMN` with `IF NOT EXISTS`-safe pattern (catch error on duplicate column):

```typescript
// After the main CREATE TABLE block, add migration:
const migrationColumns = [
  { name: 'company_name', type: 'TEXT' },
  { name: 'company_orgnr', type: 'TEXT' },
  { name: 'nace_code', type: 'TEXT' },
  { name: 'location', type: 'TEXT' },
];

for (const col of migrationColumns) {
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col.name} ${col.type}`);
  } catch {
    // Column already exists — safe to ignore
  }
}
```

Update `insertLead` to include the new fields:

```typescript
export function insertLead(
  db: Database.Database,
  signal: RawSignal,
  signalType: 'demand' | 'supply' | 'growth' | 'change',
  match: MatchResult,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO leads
      (source, signal_type, external_id, external_url, title, description,
       category, price, contact_name, contact_info, published_at,
       match_status, matched_ads, price_diff_pct, status, created_at,
       company_name, company_orgnr, nace_code, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
    )
    .run(
      signal.source,
      signalType,
      signal.externalId,
      signal.externalUrl,
      signal.title,
      signal.description,
      signal.category,
      signal.price,
      signal.contactName,
      signal.contactInfo,
      signal.publishedAt,
      match.matchStatus,
      JSON.stringify(match.matchedAds),
      match.priceDiffPct,
      new Date().toISOString(),
      signal.companyName ?? null,
      signal.companyOrgnr ?? null,
      signal.naceCode ?? null,
      signal.location ?? null,
    );
  return result.changes > 0;
}
```

- [ ] **Step 3: Add tests for new signal types**

In `src/lead-scanner.test.ts`, add tests:

```typescript
it('inserts a growth signal from doffin', () => {
  const signal = makeSignal({
    source: 'doffin',
    externalId: 'doffin-2026-106721',
    title: 'Veibygging E39 Mandal-Lyngdal',
    companyName: 'Statens vegvesen',
    companyOrgnr: '971032081',
    naceCode: '42',
    location: 'Agder',
  });
  const ok = insertLead(db, signal, 'growth', makeMatch({ matchStatus: 'no_match', matchedAds: [] }));
  expect(ok).toBe(true);
  const row = db.prepare('SELECT * FROM leads WHERE external_id = ?').get('doffin-2026-106721') as any;
  expect(row.signal_type).toBe('growth');
  expect(row.company_name).toBe('Statens vegvesen');
});

it('inserts a change signal from brreg bankruptcy', () => {
  const signal = makeSignal({
    source: 'brreg_bankrupt',
    externalId: 'brreg-934349148',
    title: '2T4 BYGG AS - Konkurs',
    companyName: '2T4 BYGG AS',
    companyOrgnr: '934349148',
    naceCode: '41.000',
    location: 'LARVIK',
  });
  const ok = insertLead(db, signal, 'change', makeMatch({ matchStatus: 'no_match', matchedAds: [] }));
  expect(ok).toBe(true);
  const row = db.prepare('SELECT * FROM leads WHERE external_id = ?').get('brreg-934349148') as any;
  expect(row.signal_type).toBe('change');
  expect(row.source).toBe('brreg_bankrupt');
});
```

---

### Task 2: Doffin scanner — public procurement contracts

Scan the Doffin API for active construction/infrastructure tenders and awarded contracts.

**Files:**
- Create: `src/lead-sources/doffin.ts`

- [ ] **Step 1: Create Doffin API client and type definitions**

Create `src/lead-sources/doffin.ts`:

```typescript
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
```

- [ ] **Step 2: Implement the search function**

```typescript
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

  const data: DoffinSearchResponse = await res.json();
  return data.hits;
}
```

- [ ] **Step 3: Implement the main export function**

```typescript
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
```

---

### Task 3: Bronnøysund scanner — new registrations and bankruptcies

Scan the Enhetsregisteret API for new companies in relevant NACE codes and for bankruptcies/dissolutions.

**Files:**
- Create: `src/lead-sources/brreg.ts`

- [ ] **Step 1: Create Bronnøysund API client and constants**

Create `src/lead-sources/brreg.ts`:

```typescript
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
```

- [ ] **Step 2: Implement new company registration scanner**

```typescript
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

  const data: BrregPage = await res.json();
  return data._embedded?.enheter ?? [];
}
```

- [ ] **Step 3: Implement bankruptcy/dissolution scanner**

```typescript
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
    const data: BrregPage = await konkursRes.json();
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
    const data: BrregPage = await avviklingRes.json();
    entities.push(...(data._embedded?.enheter ?? []));
  }

  return entities;
}
```

- [ ] **Step 4: Implement main export function**

```typescript
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

        const naceDesc = NACE_DESCRIPTIONS[nace] ?? entity.naeringskode1?.beskrivelse ?? '';
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
            addr ? `Adresse: ${addr.adresse?.join(', ')}, ${addr.poststed}` : null,
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
  // Reset seen set — a company can appear as both new and bankrupt (different orgnr)
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
        const naceDesc = NACE_DESCRIPTIONS[nace] ?? entity.naeringskode1?.beskrivelse ?? '';
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
            entity.antallAnsatte ? `Ansatte: ${entity.antallAnsatte}` : null,
            addr ? `Adresse: ${addr.adresse?.join(', ')}, ${addr.poststed}` : null,
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
```

---

### Task 4: Finn jobs scanner — operator/driver job postings

Scrape Finn.no job listings for postings that indicate a company needs equipment operators (which implies they have or are acquiring equipment).

**Files:**
- Create: `src/lead-sources/finn-jobs.ts`

- [ ] **Step 1: Create search queries and parser**

Create `src/lead-sources/finn-jobs.ts`:

```typescript
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
```

- [ ] **Step 2: Implement HTML parser for job listings**

```typescript
function parseJobListings(html: string): RawSignal[] {
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
    const companyMatch = block.match(
      /class="[^"]*employer[^"]*"[^>]*>([^<]+)</,
    ) ?? block.match(
      /class="[^"]*company[^"]*"[^>]*>([^<]+)</,
    );
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
```

- [ ] **Step 3: Implement main export function**

```typescript
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
```

**Note:** If Finn renders job results client-side (no HTML in response), fall back to using the occupation filter URLs which may server-render: `https://www.finn.no/job/fulltime/search.html?occupation=0.68` (Bygg og anlegg). The parser should handle both patterns. If neither works, a headless browser approach may be needed in a follow-up.

---

### Task 5: Integrate Phase 3 sources into the scan loop

Wire the three new sources into the existing `scanAllSources` function in `src/lead-scanner.ts`.

**Files:**
- Modify: `src/lead-scanner.ts`

- [ ] **Step 1: Add imports for new sources**

At the top of `src/lead-scanner.ts`, add:

```typescript
import { scanDoffin } from './lead-sources/doffin.js';
import { scanBrreg } from './lead-sources/brreg.js';
import { scanFinnJobs } from './lead-sources/finn-jobs.js';
```

- [ ] **Step 2: Add source scans to scanAllSources**

After the existing Machineryline scan block, add:

```typescript
  // --- Phase 3 sources ---

  // Doffin — public procurement contracts (growth signals)
  const beforeDoffin = totalNew;
  try {
    const doffinSignals = await scanDoffin();
    for (const signal of doffinSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'growth', match)) totalNew++;
    }
    console.log(
      `[lead-scanner] Doffin: ${doffinSignals.length} found, ${totalNew - beforeDoffin} new`,
    );
  } catch (err) {
    console.error(
      `[lead-scanner] Doffin scan failed: ${(err as Error).message}`,
    );
  }

  // Bronnøysund — new registrations (growth) and bankruptcies (change)
  const beforeBrreg = totalNew;
  try {
    const brregSignals = await scanBrreg();
    for (const signal of brregSignals) {
      const signalType = signal.source === 'brreg_bankrupt' ? 'change' : 'growth';
      const match = matchSignal(signal);
      if (insertLead(db, signal, signalType as any, match)) totalNew++;
    }
    console.log(
      `[lead-scanner] Brreg: ${brregSignals.length} found, ${totalNew - beforeBrreg} new`,
    );
  } catch (err) {
    console.error(
      `[lead-scanner] Brreg scan failed: ${(err as Error).message}`,
    );
  }

  // Finn jobs — operator/driver postings (growth signals)
  const beforeFinnJobs = totalNew;
  try {
    const finnJobSignals = await scanFinnJobs();
    for (const signal of finnJobSignals) {
      const match = matchSignal(signal);
      if (insertLead(db, signal, 'growth', match)) totalNew++;
    }
    console.log(
      `[lead-scanner] Finn jobs: ${finnJobSignals.length} found, ${totalNew - beforeFinnJobs} new`,
    );
  } catch (err) {
    console.error(
      `[lead-scanner] Finn jobs scan failed: ${(err as Error).message}`,
    );
  }
```

---

### Task 6: Extend leads skill with growth/change commands

Add commands to the container skill for querying Phase 3 signal types.

**Files:**
- Modify: `container/skills/leads/leads.sh`

- [ ] **Step 1: Add `growth` command**

```bash
growth)
  sqlite3 -header -column "$DB" \
    "SELECT id, source, title, company_name, location, published_at, status
     FROM leads
     WHERE signal_type = 'growth'
     ORDER BY created_at DESC
     LIMIT ${2:-20};"
  ;;
```

- [ ] **Step 2: Add `changes` command**

```bash
changes)
  sqlite3 -header -column "$DB" \
    "SELECT id, source, title, company_name, nace_code, location, published_at, status
     FROM leads
     WHERE signal_type = 'change'
     ORDER BY created_at DESC
     LIMIT ${2:-20};"
  ;;
```

- [ ] **Step 3: Add `companies` command for searching by company**

```bash
companies)
  sqlite3 -header -column "$DB" \
    "SELECT id, source, signal_type, company_name, company_orgnr, nace_code, location, published_at
     FROM leads
     WHERE company_name IS NOT NULL
       AND (company_name LIKE '%${2}%' OR company_orgnr = '${2}')
     ORDER BY created_at DESC
     LIMIT 20;"
  ;;
```

---

### Task 7: Tests for source modules

Add unit tests for the new source parsers.

**Files:**
- Modify: `src/lead-scanner.test.ts`

- [ ] **Step 1: Add Doffin response parsing test**

Test that the Doffin module correctly transforms API responses into `RawSignal[]`. Mock the fetch call with a sample response.

```typescript
import { scanDoffin } from './lead-sources/doffin.js';

describe('scanDoffin', () => {
  it('transforms doffin hits into RawSignal with company metadata', async () => {
    // Integration test — calls live API, skip in CI
    // For unit test: mock fetch with sample response
  });
});
```

- [ ] **Step 2: Add Bronnøysund parsing test**

```typescript
import { scanBrreg } from './lead-sources/brreg.js';

describe('scanBrreg', () => {
  it('separates new registrations from bankruptcies', async () => {
    // Integration test — calls live API
  });
});
```

- [ ] **Step 3: Add Finn jobs HTML parsing test**

Create a test with sample HTML to verify the job listing parser extracts correct fields and filters out recruitment agencies.

---

## Dependencies

- Phase 1 must be implemented first (lead scanner, DB schema, types, matcher)
- Phase 2 (price history) is independent and can be done in parallel with Phase 3
- The `insertLead` signature change (`signalType` union expansion) is backward compatible

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Doffin API changes (undocumented, reverse-engineered) | Monitor for 404/schema changes, log errors per-source without crashing scanner |
| Finn job listings may be client-rendered (empty HTML) | Fall back to occupation-filtered URLs; if needed, use headless browser in follow-up |
| Bronnøysund API rate limits | 200ms delay between calls; API is designed for bulk access, no documented limits |
| Too many Brreg results (25K+ per NACE code) | Only fetch recent registrations (14 days) and recent bankruptcies (30 days) |
| Doffin CPV code overlap produces duplicates | Dedup by `externalId` (Doffin notice ID) via `INSERT OR IGNORE` |

## Not Included (Phase 4)

- Lead scoring / priority ranking
- Automated outreach to leads
- Dashboard / webapp
- Facebook group monitoring
- Seasonal signal weighting
- SSB farm demographics as scoring input
