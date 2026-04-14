# ATS Feed Cache — Design

## Sammendrag

En lokal SQLite-cache med FTS5-fulltekstsøk over alle ATS Norway-annonser. Et frittstående sync-script paginerer API-et og holder cachen oppdatert. `ats-feed.sh` søker i cachen i stedet for å kalle API-et live.

## Problemet

ATS-API-et (`api3.ats.no/api/v3/ad`) har 21 500+ annonser over 1 000+ sider. Det finnes ingen server-side søk — kun paginering med `?page=N` (20 per side). Å søke live krever å laste mange sider, noe som er tregt og upålitelig. Direkte oppslag (`GET /api/v3/ad/{id}`) fungerer, men krever at man vet ID-en.

## Løsning

### Sync-script (`scripts/sync-ats-feed.ts`)

En langlevd bakgrunnsprosess som bygger og vedlikeholder cachen.

**Full sync (oppstart + hver time):**
1. Hent `meta.last_page` fra side 1
2. Paginer gjennom alle sider sekvensielt
3. For hver annonse med `status: "published"`: upsert i `ads`-tabellen
4. Fjern annonser som ikke lenger finnes i API-et (slett der `synced_at < denne sync-kjøringens timestamp`)
5. Logg antall nye, oppdaterte og fjernede annonser

**Inkrementell sync (hvert 90. sekund):**
1. Hent de siste 5 sidene (nyeste 100 annonser)
2. Upsert publiserte annonser
3. Marker slettede/lukkede annonser som `status = 'removed'` hvis de ikke lenger er `published`

**Prosessmodell:** Startes av NanoClaw som child process ved oppstart når `AGENT_MODE=direct`. Dør med NanoClaw — ingen egen systemd-service.

### SQLite-database (`data/ats-feed-cache.sqlite`)

**Tabell `ads`:**

| Kolonne | Type | Beskrivelse |
|---------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Annonse-ID fra API-et |
| `status` | TEXT | `published` eller `removed` |
| `price` | INTEGER | Pris i NOK |
| `price_euro` | INTEGER | Pris i EUR |
| `year` | TEXT | Produksjonsår |
| `make_id` | INTEGER | Produsent-ID |
| `model_id` | INTEGER | Modell-ID |
| `category_id` | INTEGER | Kategori-ID |
| `title_no` | TEXT | Norsk beskrivelse (fts_nb_no) |
| `title_en` | TEXT | Engelsk beskrivelse (fts_en_us) |
| `title_de` | TEXT | Tysk beskrivelse (fts_de_de) |
| `county_id` | INTEGER | Fylke |
| `zipcode` | INTEGER | Postnummer |
| `published_at` | TEXT | Publiseringsdato fra API |
| `changed_at` | TEXT | Siste endring fra API |
| `synced_at` | TEXT | Når raden sist ble oppdatert av sync |

**FTS5 virtuell tabell `ads_fts`:**

Indekserer `title_no`, `title_en`, `title_de` fra `ads`-tabellen. Vedlikeholdes med triggere på INSERT/UPDATE/DELETE i `ads`.

FTS5 gir:
- Rask fulltekstsøk over alle 21 500+ annonser
- Flere søkeord: `"maur trippelkjerre"` matcher begge
- Prefix-søk: `"volv*"` matcher `"volvo"`
- Rangering etter relevans via `rank`

### Oppdatert `ats-feed.sh`

| Kommando | Før | Etter |
|----------|-----|-------|
| `search <query>` | Henter siste 10 sider fra API, filtrerer med jq | Spør `ads_fts` i lokal cache |
| `list [count]` | `GET /api/v3/ad?status=published&$top=N` | Spør `ads` sortert etter `published_at DESC` |
| `get <id>` | `GET /api/v3/ad/{id}` | Uendret — direkte API-kall for ferskest data |

Output-formatet er identisk med dagens format (JSON-objekter med id, title, price, etc.).

### Oppstart i container

NanoClaw spawner sync-scriptet som child process i `main()` når `AGENT_MODE=direct`:

```
if (AGENT_MODE === 'direct') {
  spawn('node', ['dist/scripts/sync-ats-feed.js'], { stdio: 'inherit' });
}
```

Scriptet logger til stdout (arver NanoClaw sin stdout i Docker). Dør automatisk når NanoClaw stopper.

### Dataflyt

```
API (api3.ats.no)
  │
  │ poll (full: hver time, inkr: hvert 90s)
  ▼
sync-ats-feed.ts ──write──▶ data/ats-feed-cache.sqlite
                                     │
                                     │ read (FTS5 query)
                                     ▼
ats-feed.sh search "maur" ──▶ SQLite ──▶ JSON output
ats-feed.sh list 20        ──▶ SQLite ──▶ JSON output
ats-feed.sh get 21420      ──▶ API direkte (uendret)
```

## Avhengigheter

- `better-sqlite3` — allerede i prosjektet
- `sqlite3` CLI — trengs i containeren for `ats-feed.sh` (legges til i Dockerfile)

## Ikke inkludert

- Fuzzy/fonetisk matching (FTS5 dekker behovet)
- API-autentisering (API-et er åpent)
- Webhook/push-oppdatering (API-et støtter ikke dette)
- Søk i spesifikasjoner/vegvesen-data (kun fritekstbeskrivelser)
