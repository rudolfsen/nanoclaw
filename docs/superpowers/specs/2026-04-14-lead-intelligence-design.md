# Lead Intelligence Agent — Design

## Sammendrag

En bakgrunnsagent som scanner eksterne markedsplasser for to typer signaler:
1. **Kjøpssignaler** — folk som leter etter utstyr ATS/LBS selger (potensielle kunder)
2. **Innkjøpsmuligheter** — utstyr til salgs på andre plattformer til lavere pris enn ATS/LBS-nivå (arbitrasje)

Resultatene lagres som leads i NanoClaw. Bjørnar kan spørre agenten "vis nye leads" via chat.

## Kilder

### Fase 1

| Kilde | Type signal | Tilgang | Hva vi henter |
|-------|-------------|---------|---------------|
| **Finn.no "ønskes kjøpt"** | Kjøpssignal | Scrape (forutsigbare URLer) | Hva personen søker, kontaktinfo, kategori |
| **Finn.no tilbud** | Innkjøpsmulighet | Scrape | Utstyr til salgs, pris, sammenlign med ATS/LBS |
| **Mascus.no** | Innkjøpsmulighet | Scrape | Bruktmaskin-annonser, priser |
| **Machineryline.no** | Innkjøpsmulighet | Scrape | Bruktmaskin-annonser, priser |

### Fase 2 — indirekte signaler og flere kilder

**Vekstsignaler (firma som trenger utstyr):**

| Kilde | Signal | Tilgang |
|-------|--------|---------|
| **Doffin.no** | Offentlige anbud i anlegg/vei/bygg — vinnere trenger maskiner | Åpent API (TED/Doffin) |
| **Brønnøysund (Enhetsregisteret)** | Nyetableringer i relevante bransjer (NACE 41-43 bygg/anlegg, 01 landbruk, 49 transport) | Åpent API |
| **Finn.no stillingsannonser** | Firma som søker maskinførere/operatører — trenger utstyr | Scrape |

**Endringssignaler (innkjøpsmuligheter):**

| Kilde | Signal | Tilgang |
|-------|--------|---------|
| **Brønnøysund (Konkursregisteret)** | Konkurser i relevante bransjer — utstyr til salgs | Åpent API |
| **Brønnøysund (Eierskifter)** | Eierskifter — nye eiere oppdaterer maskinpark | Åpent API |

**Sesongbaserte signaler:**

| Sesong | Signal | Utstyr |
|--------|--------|--------|
| Vår (mars-mai) | Landbrukssesong starter | Traktorer, ploger, såmaskiner |
| Høst (sept-nov) | Vintervedlikehold-forberedelse | Brøyteutstyr, strømaskiner |
| Hele året | Byggeboom / store infrastrukturprosjekter | Gravemaskiner, dumpere, transport |

**Flere markedsplasser:**

- Facebook-grupper (krever innlogging — manuell eller API)
- Google Alerts for spesifikke søkeord
- Tradus.com, MachineryTrader.com

## Arkitektur

### Scanner-modul (`src/lead-scanner.ts`)

Langlevd bakgrunnsprosess (samme mønster som ats-feed-sync.ts). Spawnes av NanoClaw i direct mode.

For hver kilde:
1. Hent nye annonser (scrape HTML, parse)
2. Klassifiser: kjøpssignal eller innkjøpsmulighet
3. For kjøpssignaler: match mot ATS/LBS FTS5-cache
4. For innkjøpsmuligheter: sammenlign pris med lignende i ATS/LBS-cache
5. Lagre som lead i SQLite

Scan-intervall: hver 30. minutt per kilde.

### Kilde-parsere

Hver kilde får sin egen parser-funksjon som returnerer et felles format:

```typescript
interface RawSignal {
  source: 'finn_wanted' | 'finn_supply' | 'mascus' | 'machineryline';
  externalUrl: string;
  title: string;
  description: string;
  category: string;
  price: number | null;        // Kun for innkjøpsmuligheter
  contactName: string | null;
  contactInfo: string | null;  // Telefon, e-post, eller profil-URL
  publishedAt: string;
  externalId: string;          // Unik ID fra kilden (for dedup)
}
```

### Lead-database

Ny SQLite-database: `data/leads.sqlite`

**Tabell `leads`:**

| Kolonne | Type | Beskrivelse |
|---------|------|-------------|
| id | INTEGER PK | Auto-increment |
| source | TEXT | finn_wanted, finn_supply, mascus, machineryline, doffin, brreg, finn_jobs |
| signal_type | TEXT | "demand" (kjøpssignal), "supply" (innkjøpsmulighet), "growth" (vekstsignal), "change" (endringssignal) |
| external_id | TEXT UNIQUE | Unik ID fra kilden (dedup) |
| external_url | TEXT | Lenke til original-annonsen |
| title | TEXT | Tittel/beskrivelse av hva de søker/selger |
| description | TEXT | Full beskrivelse |
| category | TEXT | Utstyrskategori |
| price | REAL | Pris (kun for supply-signaler) |
| contact_name | TEXT | Kontaktperson |
| contact_info | TEXT | Telefon/e-post |
| published_at | TEXT | Når annonsen ble publisert |
| match_status | TEXT | "has_match", "no_match", "price_opportunity" |
| matched_ads | TEXT | JSON-array med matchede ATS/LBS annonse-IDer og priser |
| price_diff_pct | REAL | Prisdifferanse i prosent (for innkjøpsmuligheter) |
| status | TEXT | "new", "contacted", "ignored" |
| created_at | TEXT | Når leaden ble oppdaget |

FTS5-tabell `leads_fts` på `title` og `description` for søk.

### Agent-verktøy (`leads`)

Nytt verktøy for direct agent og container agent:

- `leads list [count]` — vis nyeste leads
- `leads search <query>` — søk i leads
- `leads demand` — vis kun kjøpssignaler
- `leads opportunities` — vis kun innkjøpsmuligheter med prisdiff
- `leads stats` — oppsummering: antall nye, per kilde, per kategori

### Matching og prisdifferanse

**Kjøpssignaler (demand):**
1. Ekstraher nøkkelord fra "ønskes kjøpt"-annonsen (merke, modell, kategori)
2. Søk i ATS/LBS FTS5-cache
3. Hvis treff: `match_status = "has_match"`, lagre matchede annonser med priser
4. Hvis ingen treff: `match_status = "no_match"` — signal for innkjøp

**Innkjøpsmuligheter (supply):**
1. Parse pris og utstyrstype fra ekstern annonse
2. Søk i ATS/LBS FTS5-cache for lignende utstyr
3. Beregn prisdifferanse: `(ats_pris - ekstern_pris) / ats_pris * 100`
4. Hvis ekstern pris er vesentlig lavere (>15%): `match_status = "price_opportunity"`
5. Lagre prisdiff og matchede annonser

### Finn.no scraping

**"Ønskes kjøpt" URLer:**
```
https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&category=0.67    # Landbruk
https://www.finn.no/bap/forsale/search.html?search_type=SEARCH_ID_BAP_WANTED&category=0.69    # Næringsvirksomhet
```

**Tilbudsannonser:**
```
https://www.finn.no/bap/forsale/search.html?category=0.67    # Landbruk til salgs
https://www.finn.no/bap/forsale/search.html?category=0.69    # Næringsvirksomhet til salgs
```

Parse HTML med regex eller enkel DOM-parsing. Ekstraher: tittel, pris, lenke, Finn-ID (for dedup), publiseringsdato.

### Mascus/Machineryline scraping

Lignende tilnærming: hent listesider, parse HTML, ekstraher annonsedata. Bruk `externalId` for å unngå duplikater mellom scans.

## Oppstart

Scannet startes som child process av NanoClaw i direct mode, likt ats-feed-sync og lbs-feed-sync.

## Faser

**Fase 1 (nå):** Finn "ønskes kjøpt" + Mascus/Machineryline prissammenligning. Leads i NanoClaw.

**Fase 2:** Doffin anbud, Brønnøysund nyetableringer/konkurser, Finn stillingsannonser. Sesongbasert prioritering.

**Fase 3:** Dashboard, automatisk outreach, Facebook-grupper, lead-scoring.

## Ikke inkludert

- Automatisk outreach til leads (fase 3)
- Dashboard/webapp (fase 3)
- Lead-scoring / prioritering (fase 3)
- Varsling (Slack/e-post) — Bjørnar spør agenten manuelt i fase 1
