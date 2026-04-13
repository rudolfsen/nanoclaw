# E-post Intelligence — klassifisering, læring og svarutkast

## Oversikt

Gjøre begge e-postkanalene (Outlook: magnus@allvit.no, Gmail: privat) intelligente: klassifisere e-post, sortere, lære hva som er viktig over tid, og foreslå svarutkast i brukerens egen stil. Agenten sender aldri e-post — bare utkast.

Gmail har allerede grunnleggende klassifisering og sanitisering. Denne specen bringer Outlook opp til samme nivå, og utvider begge kanalene med AI-fallback, implisitt læring, skrivestil-læring og svarutkast.

## 1. Outlook-kanal: grunnforbedringer

### Hente body

Dagens OutlookChannel henter bare envelope (fra/emne/dato). Utvid `fetchRecent()` til å hente `BODY[TEXT]` eller `BODY[]` via IMAP slik at vi har faktisk e-postinnhold for klassifisering og utkast.

### Klassifisering

Gjenbruk `categorizeEmail()` fra `src/skills/email-sorter.ts`. Kjør på hver ny e-post. Sanitiser innhold med `sanitizeEmailForAgent()` før levering til Telegram.

Bare e-poster klassifisert som "viktig" eller "handling_kreves" leveres til agenten via Telegram.

### IMAP-mappesortering

Etter klassifisering, flytt e-post til riktig IMAP-mappe:

| Kategori | IMAP-mappe |
|----------|------------|
| `viktig` | `Viktig` |
| `handling_kreves` | `Viktig` |
| `kvittering` | `Kvitteringer` |
| `nyhetsbrev` | `Nyhetsbrev` |
| `reklame` | `Reklame` |
| `annet` | `Annet` |

Mapper opprettes automatisk ved første bruk (IMAP CREATE). E-poster fjernes fra INBOX etter flytting.

### Ikke marker som lest

E-poster skal IKKE markeres som lest av agenten. Brukeren vil beholde ulest-status for å holde oversikt i Outlook-klienten. Fjern eksisterende `markAsRead()`-kall fra polling-loopen.

### Deduplisering

Erstatt in-memory `processedUids` Set med SQLite-tabell:

```sql
CREATE TABLE IF NOT EXISTS outlook_processed (
  uid INTEGER PRIMARY KEY,
  processed_at TEXT DEFAULT (datetime('now'))
);
```

Ved oppstart, les siste 100 UIDs fra DB for å unngå re-prosessering. Rydd opp poster eldre enn 30 dager periodisk.

## 2. AI-fallback klassifisering

### Flyt

1. `categorizeEmail()` kjører (mønsterbasert, ingen kostnad)
2. Hvis `needsAI: true` → sjekk `email_categories` i DB for kjent avsender
3. Treff i DB → bruk lagret kategori
4. Ingen treff → send til Claude med klassifiseringsprompt
5. Lagre resultat i `email_categories` med avsender + kategori

### Klassifiseringsprompt

Input: avsender, emne, første 300 tegn av body.
Output: én kategori fra listen (viktig, handling_kreves, kvittering, nyhetsbrev, reklame, annet).

Kort og fokusert — minimalt token-bruk per kall.

### Kostnad

Bare ukjente avsendere trigger AI-kall. Etter de første dagene dekker DB-oppslag de fleste. Forventet steady-state: <5 AI-kall per dag.

## 3. Implisitt læring

### Hva observeres

Systemet sporer brukerens respons på e-poster som leveres til Telegram:

| Handling | Signal | Effekt |
|----------|--------|--------|
| Godkjenner utkast | Sterk "viktig" | `response_count++`, confidence opp |
| Redigerer utkast | Sterk "viktig" + stildata | `response_count++`, confidence opp, diff lagres |
| Forkaster utkast | Svak "viktig" | Avsender fortsatt relevant, men lavere |
| Ignorerer (24t) | Negativ | `ignore_count++`, confidence ned |

### DB-skjema

Utvid eksisterende `email_categories`-tabell:

```sql
ALTER TABLE email_categories ADD COLUMN response_count INTEGER DEFAULT 0;
ALTER TABLE email_categories ADD COLUMN ignore_count INTEGER DEFAULT 0;
ALTER TABLE email_categories ADD COLUMN last_response_at TEXT;
```

### Ignore-deteksjon

En scheduled task (f.eks. daglig) sjekker leverte e-poster som ikke har fått respons innen 24 timer. Disse markeres som ignorert og `ignore_count` økes for avsenderen.

Tabell for å spore leveranser:

```sql
CREATE TABLE IF NOT EXISTS outlook_deliveries (
  uid INTEGER PRIMARY KEY,
  sender TEXT NOT NULL,
  delivered_at TEXT DEFAULT (datetime('now')),
  responded INTEGER DEFAULT 0
);
```

Ved godkjent/redigert utkast → `responded = 1`. Daglig jobb finner rader der `responded = 0` og `delivered_at < now - 24h`.

### Terskler

- `response_count >= 3` og `ignore_count == 0` → avsender auto-klassifiseres som "viktig" (confidence 0.95)
- `ignore_count >= 5` og `response_count == 0` → avsender nedgraderes til "annet" (confidence 0.8)
- Blandede signaler → behold AI-fallback

## 4. Skrivestil-læring

### Eksempelbank

Fil: `groups/privat/wiki/email-style-examples.md`

Lagrer brukerens godkjente og redigerte svar som referanse. Format:

```markdown
## Eksempel: [emne] → [mottaker]
Kontekst: [formell/uformell], [norsk/engelsk]
---
[svarinnhold]
---
```

Maks 20 eksempler. Når grensen nås, fjernes de eldste. Redigerte svar er ekstra verdifulle — lagre både utkast og endelig versjon for å fange opp korreksjonene.

### Stilguide

Fil: `groups/privat/wiki/email-style-guide.md`

Bygges automatisk etter ≥10 eksempler i banken. Oppdateres når nye eksempler avviker merkbart fra eksisterende guide. Innhold:

- Foretrukket tone (formell vs. uformell)
- Typiske hilsener og avslutninger
- Formalitetsnivå per konteksttype (kollegaer vs. eksterne)
- Språkvalg (norsk vs. engelsk, per mottaker/domene)
- Typiske formuleringer og uttrykk

Agenten bruker stilguiden som system-kontekst ved utkastgenerering.

## 5. Utkast-flyt

### Trigger

Når en e-post klassifiseres som "viktig" eller "handling_kreves":

1. E-posten leveres til Telegram (sanitisert, som i dag)
2. Agenten leser stilguide + relevante eksempler
3. Agenten genererer et svarutkast
4. Utkastet sendes som separat melding i Telegram, tydelig markert som utkast

### Brukerinteraksjon

Via Telegram kan brukeren:

- **Godkjenne** → utkastet lagres som draft i Outlook (IMAP Drafts-mappe)
- **Redigere** → brukeren sender redigert versjon → lagres som draft + diff brukes til stiloppdatering
- **Forkaste** → ingen draft opprettes

### IMAP Draft-lagring

Container-agenten har ikke direkte IMAP-tilgang. Draft-lagring går via IPC: agenten skriver en `save-draft`-kommando til IPC-mappen, host-prosessen plukker den opp og bruker IMAP APPEND til Drafts-mappen med riktige headers (To, Subject, In-Reply-To, References) slik at draftet vises som et svar i riktig tråd når brukeren åpner det i Outlook.

### Brukerinteraksjon — mekanikk

Agenten i containeren håndterer godkjenn/rediger/forkast naturlig via samtalen i Telegram. Brukeren svarer i fritekst (f.eks. "send det", "endre til ...", "dropp det"). Agenten tolker intensjonen og handler deretter — ingen knapper eller strukturerte kommandoer nødvendig.

### Avgrensning

- Utkast lages KUN for "viktig" og "handling_kreves"
- Agenten sender ALDRI e-post direkte
- Brukeren må selv åpne Outlook og trykke send

## 6. Gmail — oppgradering til paritet

Gmail har allerede klassifisering og sanitisering. Følgende legges til:

### AI-fallback

Samme flyt som Outlook (del 2). `categorizeEmail()` kjører først, AI-fallback ved `needsAI: true`. Deler samme `email_categories`-tabell.

### Implisitt læring

Samme mekanisme som Outlook (del 3). Gmail har allerede `sendMessage()` for svar — dette brukes til å spore `response_count`. Ignore-deteksjon via samme daglige scheduled task.

### Svarutkast

Gmail-kanalen har allerede `sendMessage()` som kan sende svar. For utkast-flyten:

1. Agenten genererer utkast (som for Outlook)
2. Ved godkjenning → bruk Gmail API `users.drafts.create` for å lagre som draft i Gmail
3. Brukeren åpner Gmail og sender selv

Gmail API har dedikert draft-støtte (til forskjell fra IMAP APPEND), så dette er renere enn Outlook-varianten.

### Skrivestil

Deler samme eksempelbank og stilguide som Outlook. Eksemplene tagges med kilde (gmail/outlook) men stilen er felles — brukeren skriver likt uavhengig av kanal.

### Ikke marker som lest

Gjeldende Gmail-kanal markerer e-poster som lest (fjerner UNREAD-label). Fjern dette, som for Outlook.

## Filer som endres

| Fil | Endring |
|-----|---------|
| `src/channels/outlook.ts` | Hent body, klassifisering, mappesortering, fjern markAsRead, SQLite-deduplisering, IPC draft-lagring |
| `src/channels/gmail.ts` | AI-fallback, fjern markAsRead, draft-støtte via Gmail API, læringsintegrasjon |
| `src/skills/email-sorter.ts` | Evt. juster terskler, ingen strukturelle endringer |
| `src/skills/email-classifier.ts` | AI-fallback logikk (delt mellom begge kanaler) |
| `src/db.ts` | Ny tabell `outlook_processed`, `outlook_deliveries`, utvid `email_categories` |
| `src/ipc.ts` | Ny IPC-kommando `save-draft` for Outlook |
| `src/task-scheduler.ts` | Daglig ignore-deteksjon jobb |
| `groups/privat/wiki/email-style-examples.md` | Ny fil, vedlikeholdes av agenten |
| `groups/privat/wiki/email-style-guide.md` | Ny fil, auto-generert etter ≥10 eksempler |
| `container/skills/email-draft.md` | Ny container-skill: instruks for utkastgenerering |

## Utenfor scope

- Sende e-post (aldri)
- Outlook Graph API (holder oss til IMAP)
- Kalenderintegrasjon
- Vedlegg-parsing
