# ATS Kundeassistent — Design v2

## Endringer fra v1

v1 antok "separat NanoClaw-instans, delt kodebase". Isolasjonsreview avdekket kritiske problemer:
- Hardkodet personlig e-postklassifisering som ville droppet kundens e-poster
- Delte credentials, allowlists og Docker-ressurser via felles HOME
- Container orphan cleanup som dreper den andres containere
- Personlig data (helse, familie) synlig i kundens filsystem via git

v2 løser dette med en **dedikert Docker-container per kunde** uten agent-subcontainere. Claude Agent SDK kjører direkte i kundecontaineren.

## Sammendrag

En Docker-basert kundeinstans for ATS Norway som leser en felles e-postinnboks, beriker svar med maskindata fra ATS sin JSON-feed, og oppretter svarutkast for manuell godkjenning.

## Mål

Uendret fra v1:
- Redusere manuelt arbeid med å besvare e-posthenvendelser om brukte maskiner
- Berike svar med faktiske maskindata (pris, spesifikasjoner, tilgjengelighet)
- Fordele henvendelser jevnt mellom ansatte med visuell fargekoding
- Støtte flerspråklige henvendelser (norsk som standard, ellers engelsk)

## Arkitektur

```
VPS (204.168.178.32)
│
├── /opt/assistent/                    ← Magnus (direkte på host, uberørt)
│
└── /opt/nanoclaw-customers/
    └── ats/
        ├── docker-compose.yml
        ├── .env                       ← Secrets (API-nøkler, tokens)
        ├── Dockerfile                 ← Kundecontainer-image
        ├── data/                      ← SQLite, sessions (volume)
        ├── groups/
        │   └── ats-email/
        │       ├── CLAUDE.md          ← Agentinstruksjoner
        │       └── wiki/              ← Runtime-state (assignment counter)
        ├── skills/
        │   └── ats-feed/
        │       ├── ats-feed.sh        ← ATS API-verktøy
        │       └── SKILL.md
        └── credentials/               ← Gmail/Outlook credentials (volume)
```

### Nøkkelforskjeller fra v1

| Aspekt | v1 (delt instans) | v2 (Docker-container) |
|--------|--------------------|-----------------------|
| Isolasjon | Delt kodebase, env-vars | Fullstendig filsystemsisolasjon |
| E-postpipeline | Hardkodet personlig logikk | Ingen klassifisering — agenten håndterer alt |
| Agent-kjøring | Claude i sub-containere | Claude Agent SDK direkte i containeren |
| Credentials | Delt HOME-mappe | Egne volumes per kunde |
| Deploy | git clone + systemd | docker-compose up |
| Ressursgrenser | Ingen | Docker --memory, --cpus |
| Portabilitet | Bundet til VPS | docker-compose på hvilken som helst host |

## Kundecontainer

### Dockerfile

En lettvekts Node.js-container som kjører NanoClaw uten Docker-avhengighet:
- Node.js 22 slim
- NanoClaw kildekode (bygget)
- Claude Agent SDK
- curl + jq (for ATS feed-verktøyet)
- Ingen Docker CLI, ingen container-spawning

### Hva containeren gjør

Containeren kjører én prosess: NanoClaw orchestrator som:
1. Kobler til Outlook via Graph API (poller felles innboks)
2. Kobler til Slack via Socket Mode
3. Når e-post mottas: starter Claude Agent SDK direkte i prosessen
4. Agenten bruker ATS feed-verktøyet, oppretter utkast, fargekoder, varsler via Slack
5. Ingen sub-containere — alt kjører i samme prosess

### Hva som endres i koden

NanoClaw trenger en **direkte agent-modus** som alternativ til container-spawning:

- Ny env-var: `AGENT_MODE=direct` (vs default `container`)
- Når `direct`: kjør Claude Agent SDK i samme prosess med monterte skills
- Når `container`: eksisterende Docker-basert agent-spawning (uendret for Magnus)
- E-postklassifisering: kontrollert av `EMAIL_CLASSIFICATION_ENABLED` (default `true` for backward-compat, `false` for kunder)

## Kanaler

### Outlook (Graph API)

Bruker shared mailbox-støtten fra v1 (allerede implementert):
- `OUTLOOK_SHARED_MAILBOX` → leser felles innboks
- `DraftOptions` med `fromAddress` → utkast fra riktig ansatt
- `setCategories` → fargekoding per ansatt

**Ingen e-postklassifisering.** `EMAIL_CLASSIFICATION_ENABLED=false` betyr:
- Alle e-poster leveres direkte til agenten
- Ingen mapping, ingen folder-oppretting, ingen `isImportant()`-gate
- Agenten (via CLAUDE.md) bestemmer hva som er relevant

### Slack

Notifikasjonskanal. Implementeres med `/add-slack` skill.

## ATS-feed integrasjon

Uendret fra v1. Bash-script `ats-feed.sh` (allerede implementert):
- `ats-feed list` — publiserte annonser
- `ats-feed get <id>` — detaljer per annonse
- `ats-feed search <query>` — søk i beskrivelser

Monteres inn i containeren som skill.

## Agentflyt

Uendret fra v1:

1. E-post inn → agent tolker henvendelse og språk
2. Slår opp i ATS-feeden
3. Bestemmer ansatt (round-robin)
4. Fargekoder e-posten i felles innboks
5. Oppretter svarutkast med maskindata
6. Sender Slack-notifikasjon

### Agentinstruksjoner (CLAUDE.md)

Innhold uendret fra v1, men filen lever i kundens volume (`/opt/nanoclaw-customers/ats/groups/ats-email/CLAUDE.md`), ikke i git-repoet.

### Viktig: Nøyaktighet

Uendret fra v1:
- Aldri si noe om tilstand utover det som står eksplisitt i feeden
- Aldri antyd god tilstand uten dekning
- Ukjent info → "vi sjekker med eier og kommer tilbake"

### Språk

- Norsk → norsk
- Alt annet → engelsk

## Docker Compose

```yaml
services:
  nanoclaw-ats:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./groups:/app/groups
      - ./skills:/app/container/skills/customer
      - ./credentials:/app/credentials
    mem_limit: 1g
    cpus: 1.0
    logging:
      driver: journald
      options:
        tag: nanoclaw-ats
```

## .env template

```env
# === Required ===
ANTHROPIC_API_KEY=
ASSISTANT_NAME=ATS-Assistent

# === Agent mode ===
AGENT_MODE=direct
EMAIL_CLASSIFICATION_ENABLED=false

# === Outlook (Graph API) ===
OUTLOOK_TENANT_ID=
OUTLOOK_CLIENT_ID=
OUTLOOK_CLIENT_SECRET=
OUTLOOK_REFRESH_TOKEN=
OUTLOOK_EMAIL=
OUTLOOK_SHARED_MAILBOX=

# === Slack ===
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=

# === Gmail (for testing) ===
GMAIL_CREDENTIALS_DIR=/app/credentials
```

## Deploy-prosess

```bash
# 1. Opprett kundemappe
mkdir -p /opt/nanoclaw-customers/ats/{data,groups/ats-email/wiki,skills/ats-feed,credentials}

# 2. Kopier filer
cp docker-compose.yml Dockerfile .env /opt/nanoclaw-customers/ats/
cp container/skills/ats-feed/* /opt/nanoclaw-customers/ats/skills/ats-feed/
# CLAUDE.md opprettes manuelt med kundens ansattliste

# 3. Start
cd /opt/nanoclaw-customers/ats && docker-compose up -d

# 4. Sjekk
docker-compose logs -f
```

## Åpne spørsmål

1. **E-post-autentisering:** Shared mailbox med "Send As" vs individuell tilgang — avventer kunde
2. **Direct agent mode:** Må implementeres — NanoClaw kjører i dag alltid med Docker sub-containere

## Fremtidige utvidelser

- Auto-sending for kvalitetssikrede henvendelsestyper
- Smart fordeling basert på fagområde og kunderelasjon
- Flere datakilder (API-er, databaser, dokumenter)
- Kundens egen Anthropic API-nøkkel
- Felles deploy-pipeline for nye kundecontainere
