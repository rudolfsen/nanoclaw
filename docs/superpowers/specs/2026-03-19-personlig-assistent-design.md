# Personlig Assistent — Design Spec

## Oversikt

En personlig AI-assistent bygget på NanoClaw (qwibitai/nanoclaw) som håndterer kommunikasjon, produktivitet og administrasjon for både jobb og privat bruk. Kjører som en enkelt NanoClaw-instans på Railway med modulære skills.

## Arkitektur

Monolittisk NanoClaw-instans (tilnærming A) — én Node.js-prosess med skill-basert kanalsystem. Meldinger fra alle kanaler rutes gjennom NanoClaw til Claude Agent SDK. Prosess-modus (ikke container-i-container) på Railway.

```
┌─────────────────────────────────────────────┐
│              NanoClaw (Node.js)              │
│                                             │
│  Kanaler:                                   │
│  ├── Telegram (innebygd, toveis)            │
│  ├── Slack (innebygd, toveis)               │
│  ├── Gmail (innebygd, kun lese + sortere)   │
│  └── Outlook (custom, IMAP, kun lese +      │
│  │            sortere)                      │
│                                             │
│  Skills:                                    │
│  ├── E-postsortering                        │
│  ├── Kvitteringshenter                      │
│  ├── Google Calendar                        │
│  ├── Google Drive                           │
│  ├── GitHub (gh CLI)                        │
│  └── Regnskapsbott-kobling                  │
│                                             │
│  Hukommelse:                                │
│  ├── CLAUDE.md per gruppe (langtidsminne)   │
│  └── SQLite (strukturert data)              │
└─────────────────────────────────────────────┘
         │
         ▼
   Claude Agent SDK (Anthropic API)
```

## Kanaler

### Telegram (innebygd)
- Toveis kommunikasjon — primær kanal for å snakke med assistenten
- Bruker NanoClaw sin innebygde `/add-telegram` skill

### Slack (innebygd)
- Toveis kommunikasjon — jobbkontekst
- Bruker NanoClaw sin innebygde `/add-slack` skill

### Gmail (innebygd)
- Kun lesetilgang og sortering (labels)
- Aldri sende e-post
- Bruker NanoClaw sin innebygde `/add-gmail` skill (Gmail API via OAuth2)
- Autentisering deles med Google Calendar/Drive OAuth2-oppsettet

### Outlook (custom skill)
- IMAP over TLS med app-passord
- Kun lesetilgang og sortering (mapper)
- Aldri sende e-post
- Node.js-bibliotek: `imapflow`
- IMAP IDLE for push-varsler på nye e-poster
- Reconnect-logikk innebygd for stabilitet på Railway

## Skills

### E-postsortering
- Overvåker innkommende e-post i Gmail og Outlook via IMAP IDLE
- Kategoriserer automatisk: kvittering, nyhetsbrev, viktig, jobb, privat
- Gmail: setter labels basert på kategori
- Outlook: flytter til mapper basert på kategori
- Kvitteringer flagges automatisk for kvitteringshenteren
- Daglig oppsummering via Telegram/Slack: "5 nye i dag — 2 viktige, 1 kvittering, 2 nyhetsbrev"
- Lærer preferanser over tid (lagres i SQLite)

### Kvitteringshenter
- Søker gjennom Gmail og Outlook etter kvitteringer (avsender, emne, nøkkelord)
- Kan kjøres manuelt eller som planlagt jobb via NanoClaw sin innebygde task-scheduler (daglig)
- Flaggede kvitteringer fra e-postsorteringen plukkes opp automatisk
- Mellomlagrer i `receipts/`-mappe — alltid som PDF
- Håndterer to typer kvitteringer:
  1. **Vedleggs-kvitteringer** — plukker ut PDF-vedlegg direkte fra e-posten
  2. **Inline-kvitteringer** (f.eks. Meta/Facebook) — parser e-postkroppen, trekker ut strukturerte data (beløp, dato, tjeneste, valuta, referanse), genererer PDF med `pdfkit` eller `puppeteer`
- Genererte PDF-er følger et konsistent format med alle ekstraherte felter

### Google Calendar
- Leser kommende hendelser ("hva har jeg i dag?")
- Oppretter nye hendelser ("book møte tirsdag kl 10")
- Google Calendar API med OAuth2

### Google Drive
- Søke i og lese dokumenter
- Laste opp filer (f.eks. kvitteringer til en bestemt mappe)
- Google Drive API med OAuth2

### GitHub
- Sjekke repos, issues, PRs
- Tilgjengelig via `gh` CLI som finnes i NanoClaw-containere
- Autentiseres med GitHub token

### Regnskapsbott-kobling
- Henter mellomlagrede kvitteringer fra `receipts/`
- Sender videre til regnskapsbotten
- Format defineres basert på regnskapsbott-prosjektets behov

## Hukommelse

### Langtidsminne (CLAUDE.md per gruppe)
- NanoClaw lagrer kontekst i `groups/{name}/CLAUDE.md`
- Preferanser, pågående prosjekter, viktige kontakter, vaner
- Grupperuting: Slack → `jobb`-gruppe, Telegram → `privat`-gruppe (kan overstyres per melding)
- Begge grupper har tilgang til alle skills, men isolert minne

### Strukturert data (SQLite)
- Kategoriseringsregler for e-post (lærte mønstre)
- Kvitteringslogg (hva er hentet, hva er sendt til regnskapsbotten)
- Planlagte jobber og status

### Filsystem
- `receipts/` — mellomlagrede kvitteringer (PDF/bilder)

## Infrastruktur

### Hosting
- Railway (prosess-modus)
- Deploy via git push til GitHub → Railway autodeploy
- Persistent volume for SQLite-database og filer

### Hemmeligheter (Railway environment variables)
- `ANTHROPIC_API_KEY` — Anthropic API
- `TELEGRAM_BOT_TOKEN` — Telegram bot
- `SLACK_BOT_TOKEN` — Slack bot
- `OUTLOOK_EMAIL` / `OUTLOOK_APP_PASSWORD` — Outlook IMAP
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — Google OAuth2 (Gmail, Calendar, Drive)
- `GITHUB_TOKEN` — GitHub

### OAuth2-flyt for headless deploy
Google OAuth2 krever en engangsgodkjenning i nettleser. Løsning:
1. Kjør autorisasjonsflyten lokalt (`npm run auth`) som åpner nettleseren
2. Bruker godkjenner tilganger (Gmail read, Calendar, Drive)
3. Refresh token lagres som environment variable (`GOOGLE_REFRESH_TOKEN`) i Railway
4. Appen bruker refresh token til å fornye access tokens automatisk
5. Ved token-feil: varsle bruker via Telegram om at re-autentisering trengs

### Modell
- Claude Sonnet som standard
- Kan oppgraderes per skill ved behov

### Robusthet
- Reconnect-logikk for IMAP-tilkoblinger
- Test-først: deploy minimal instans med Telegram, verifiser stabilitet, legg til skills inkrementelt
- Feilhåndtering: ved kritiske feil (IMAP-brudd, OAuth-utløp, API-feil) varsles bruker via Telegram
- Kjent begrensning: kort gap i e-postovervåking under redeploy (IMAP IDLE reconnect)

### Kjente begrensninger
- SQLite krever single-instance (ikke skaler til flere replicas uten migrering til ekstern DB)
- `gh` CLI må installeres eksplisitt i Railway-bygget (Dockerfile)
- E-postklassifisering bruker Claude API per e-post — vurder batching ved høyt volum

## Harde regler
- Assistenten skal **aldri sende e-post** på brukerens vegne
- E-posttilgang er begrenset til lesing og organisering (labels/mapper)

## Utsatt / Fase 2
- Outlook Calendar (krever Microsoft Graph API)
- Containerisolering (vurder ved migrasjon fra Railway)
- Skrivetilgang for e-post (kun hvis eksplisitt bedt om)
