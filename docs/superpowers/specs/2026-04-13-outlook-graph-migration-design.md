# Outlook Graph API-migrering + automatisk tagging

## Oversikt

Erstatte IMAP-basert Outlook-kanal med Microsoft Graph API. Gir fargekategorier i Outlook-klienten, renere draft-opprettelse, ingen IMAP connection-drop-problemer, og automatisk tagging med læring over tid.

## 1. OAuth + Graph API-klient

### Auth-script

Oppdater `scripts/outlook-auth.ts` til å bruke Graph-scopes istedenfor IMAP:

```
Gamle scopes: https://outlook.office365.com/IMAP.AccessAsUser.All offline_access
Nye scopes:   Mail.ReadWrite Mail.Send offline_access
```

Samme OAuth2 authorization code flow. Brukeren kjører scriptet lokalt, godkjenner i nettleseren, får ny refresh token.

### Token refresh

Oppdater `getOutlookAccessToken()` i `src/channels/outlook.ts`:
- Endre scope fra `https://outlook.office365.com/IMAP.AccessAsUser.All` til `https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send`
- Resten av token refresh-logikken er identisk

### Graph-klient

Erstatt `OutlookChannel` (IMAP-klassen) med en Graph-basert klasse. Bruker `fetch` direkte mot `https://graph.microsoft.com/v1.0/me/` — ingen ekstra SDK.

Metoder:
- `fetchInboxMessages(top: number)` — henter uleste meldinger
- `moveMessage(messageId: string, folderId: string)` — flytter til mappe
- `createFolder(displayName: string)` — oppretter mappe
- `getFolders()` — lister mapper (caches i minne)
- `setCategories(messageId: string, categories: string[])` — setter fargekategorier
- `createDraft(to, subject, body, conversationId?)` — oppretter draft
- `getOrCreateFolder(displayName: string)` — hent fra cache eller opprett

## 2. Polling og e-posthåndtering

### Hente e-poster

```
GET /me/mailFolders/Inbox/messages
  ?$filter=isRead eq false
  &$top=20
  &$select=id,from,subject,body,receivedDateTime,categories,hasAttachments,conversationId
  &$orderby=receivedDateTime desc
```

Returnerer JSON med full body (HTML/text). Ingen IMAP source-parsing.

### Klassifisering

Gjenbruk eksisterende pipeline uendret:
- `categorizeEmail()` fra `email-sorter.ts`
- `sanitizeEmailForAgent()` fra `email-sanitizer.ts`
- `isImportant()` fra `email-classifier.ts`
- `classifyWithFallback()` for DB-oppslag

### Flytte til mapper

Etter klassifisering, flytt e-post via Graph API:
- Cache folder-IDer i minnet (Map<displayName, folderId>)
- Opprett mappe ved første bruk (`createFolder`)
- `moveMessage(messageId, folderId)`

Mapper: Viktig, Kvitteringer, Nyhetsbrev, Reklame, Annet (som før).

### Ikke marker som lest

Ikke oppdater `isRead`-flagget. E-poster forblir uleste i Outlook.

### Deduplisering

Gjenbruk `outlook_processed`-tabellen. Graph message-ID er en string (allerede kompatibelt — tabellen bruker TEXT etter migrasjon).

Migrer `outlook_processed`-tabellen: dropp og gjenskapp med `uid TEXT PRIMARY KEY`. Eksisterende data er kortvarig (deduplisering) og kan trygt slettes — første poll etter migrering vil bare gjenhente uleste e-poster som uansett filtreres via `isRead eq false`.

## 3. Kategorier (fargetags) + database-tags

### Outlook fargekategorier

Etter klassifisering og tagging, sett kategorier på meldingen:

```
PATCH /me/messages/{id}
{ "categories": ["Viktig", "Gyldendal"] }
```

Kategorier vises som fargekoder i Outlook-klienten. Opprett masterkategorier med farger ved oppstart:

```
POST /me/outlook/masterCategories
{ "displayName": "Viktig", "color": "preset0" }  // rød
{ "displayName": "Kvitteringer", "color": "preset4" }  // grønn
{ "displayName": "Nyhetsbrev", "color": "preset7" }  // blå
{ "displayName": "Reklame", "color": "preset14" }  // grå
```

Lærte tags (prosjekter, kunder) får automatisk tildelt neste ledige farge.

### Database-tags

Ny tabell for tags per e-post:

```sql
CREATE TABLE IF NOT EXISTS email_tags (
  email_uid TEXT NOT NULL,
  source TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(email_uid, source, tag)
);
```

Ny tabell for lærte mønstre:

```sql
CREATE TABLE IF NOT EXISTS learned_tags (
  tag TEXT NOT NULL UNIQUE,
  pattern_type TEXT NOT NULL,
  pattern_value TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(pattern_type, pattern_value)
);
```

### Automatisk tagging

Tre nivåer, alle kjører på hver ny e-post:

**Nivå 1 — Kategori-tag:** Klassifiseringskategori (`viktig`, `kvittering`, etc.)

**Nivå 2 — Kontekst-tags:** Utledes fra avsender-domene. `beate.molander@gyldendal.no` → tag "Gyldendal". Domene strippes for generiske suffixer (.com, .no) og prefixer (mail., noreply.).

**Nivå 3 — Lærte tags:** Agenten teller opp domener og emneord i `learned_tags`. Når `occurrence_count >= 3`, brukes taggen automatisk. Eksempel: etter 3 e-poster fra `gyldendal.no` opprettes tag "Gyldendal" automatisk.

Emneord-ekstraksjon: fjern Re:/Fw:/SV:/VS:, splitt på mellomrom, filtrer bort stoppord (og, i, for, med, etc.) og korte ord (<3 tegn). Ord som gjentas på tvers av e-poster telles opp.

### Synkronisering

Tags fra DB synces til Outlook-kategorier: `setCategories(messageId, [...tags])`. Maks 10 kategorier per melding (Outlook-begrensning).

## 4. Drafts via Graph API

Erstatt IMAP APPEND med Graph API:

```
POST /me/messages
{
  "isDraft": true,
  "toRecipients": [{ "emailAddress": { "address": "mottaker@example.com" } }],
  "subject": "Re: Emne",
  "body": { "contentType": "text", "content": "Utkasttekst" },
  "conversationId": "original-conversation-id"
}
```

Oppdater IPC-handler `save_outlook_draft` til å bruke Graph istedenfor IMAP.

## 5. Migrering og opprydding

### Fjernes

- `imapflow`-import og all IMAP-logikk i `src/channels/outlook.ts`
- `OutlookChannel` klassen (IMAP)
- IMAP-kode i `src/skills/scan-receipts.ts` (erstattes med Graph)
- IMAP-kode i `src/skills/email-actions.ts`
- `imapflow` fra `package.json` (etter at alt er migrert)

### Beholdes

- `OutlookPollingChannel` strukturen (innmaten byttes)
- `outlook_processed` tabell (type endres fra INTEGER til TEXT)
- `outlook_deliveries` tabell
- All klassifiserings- og læringslogikk
- Env-variabler (samme som i dag)

### Auth-migrering

1. Oppdater `scripts/outlook-auth.ts` med nye scopes
2. Kjør lokalt: `npx tsx scripts/outlook-auth.ts`
3. Godkjenn i nettleseren
4. Oppdater `.env` lokalt + på server med ny refresh token

## Filer som endres

| Fil | Endring |
|-----|---------|
| `src/channels/outlook.ts` | Erstatt IMAP med Graph API, legg til tagging |
| `src/db.ts` | Nye tabeller `email_tags`, `learned_tags`, endre `outlook_processed` type |
| `src/ipc.ts` | Oppdater `save_outlook_draft` til Graph |
| `src/skills/scan-receipts.ts` | Erstatt IMAP med Graph for kvitteringsskanning |
| `src/skills/email-actions.ts` | Erstatt IMAP med Graph |
| `scripts/outlook-auth.ts` | Nye scopes |
| `package.json` | Fjern `imapflow` |

## Utenfor scope

- Gmail-endringer (allerede fungerer med Google API)
- Kalenderintegrasjon
- Vedlegg-parsing
- Graph API batch requests (optimalisering for senere)
