# ATS Kundeassistent — Design

## Sammendrag

En dedikert NanoClaw-instans for ATS Norway som automatiserer e-posthåndtering. Assistenten leser en felles innboks, tolker henvendelser, beriker svar med maskindata fra ATS sin åpne JSON-feed, og oppretter svarutkast for manuell godkjenning.

## Mål

- Redusere manuelt arbeid med å besvare e-posthenvendelser om brukte maskiner
- Berike svar med faktiske maskindata (pris, spesifikasjoner, tilgjengelighet)
- Fordele henvendelser jevnt mellom ansatte med visuell fargekoding
- Støtte flerspråklige henvendelser — svar i samme språk som innkommende e-post

## Infrastruktur

### Instansisolasjon

Hver kunde får en helt isolert NanoClaw-instans på VPS-en (`204.168.178.32`):

```
/opt/assistent/        # Eksisterende instans (Magnus)
/opt/nanoclaw-ats/     # ATS-kundens instans
```

Isolert per instans:
- Node-prosess og systemd-service (`nanoclaw-ats.service`)
- `.env` med egne API-nøkler og kanal-tokens
- SQLite-database (`data/db.sqlite`)
- Grupper og agentminne (`groups/`)
- Container-sessions (`data/sessions/`)
- IPC-kataloger (`data/ipc/`)
- Credential proxy-port (unik per instans, f.eks. 3002)

Delt mellom instanser:
- Docker-image (`nanoclaw-agent:latest`) — read-only
- VPS-ressurser (CPU, RAM, disk)

### Systemd-service

```ini
[Unit]
Description=NanoClaw ATS
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/nanoclaw-ats/dist/index.js
WorkingDirectory=/opt/nanoclaw-ats
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### API-nøkkel

Starter med Magnus sin Anthropic API-nøkkel. Migreres til kundens egen nøkkel senere — krever kun endring i `.env` og restart.

## Kanaler

### Slack

Primærkanal for interaksjon og notifikasjoner.

- Slack-app registreres i kundens workspace
- Bot-token lagres i `.env`
- Agenten lytter på meldinger i utvalgte kanaler
- Brukes til å varsle ansatte om nye utkast

### Microsoft 365 e-post (Graph API)

To funksjoner:

**Innkommende — lese felles innboks:**
- Poller felles innboks via Graph API
- Nye e-poster trigges som meldinger til agenten
- Autentisering: Client credentials flow eller delegert tilgang

**Utgående — opprette utkast:**
- Agenten oppretter svarutkast i riktig ansatts innboks (eller felles innboks med riktig "fra"-adresse)
- Ansatt godkjenner og sender manuelt

**Fargekoding:**
- Agenten setter Graph API-kategori på innkommende e-post
- Hver ansatt har en farge-kategori (f.eks. "Ola - blå", "Kari - rød")
- Gir visuell oversikt over hvem som har ballen

**Åpent spørsmål:** Shared mailbox med "Send As"-rettigheter vs. individuelle OAuth-tokens per ansatt. Avventer avklaring med kunden.

## ATS-feed integrasjon

Åpen JSON-feed uten autentisering.

**Endepunkter:**
- Liste: `https://api3.ats.no/api/v3/ad` — alle annonser
- Detaljer: `https://api3.ats.no/api/v3/ad/{id}` — full spesifikasjon per annonse

**Relevante felter:**
- `id`, `status`, `price`, `price_euro` — identifikasjon og pris
- `make_id`, `model_id`, `year` — maskintype
- `category_id` — kategori (anlegg, transport, etc.)
- `fts_nb_no`, `fts_en_us`, `fts_de_de` — flerspråklige beskrivelser
- `vegvesenjson` — tekniske spesifikasjoner
- `county_id`, `zipcode` — lokasjon

**Implementering:** Bash-script i agentens container som wrapper `curl`-kall mot API-et. Enklest å vedlikeholde og krever ingen ekstra avhengigheter. Kan caches lokalt med kort TTL (5-15 min) for å redusere API-kall.

## Agentflyt

```
E-post inn til felles innboks
       │
       ▼
Agent tolker henvendelsen
  - Hva gjelder det?
  - Hvilket språk?
       │
       ▼
Slår opp i ATS-feeden
  - Finner relevante maskiner
  - Henter priser, spesifikasjoner
       │
       ▼
Bestemmer ansatt (round-robin)
       │
       ▼
Fargekoder e-posten i felles innboks
  - Setter kategori via Graph API
       │
       ▼
Oppretter svarutkast
  - I riktig ansatts innboks / felles innboks
  - Beriket med maskindata
  - Samme språk som henvendelsen
       │
       ▼
Slack-notifikasjon
  - "Nytt utkast klart for [ansatt] om [emne]"
       │
       ▼
Ansatt godkjenner og sender manuelt
```

### Flerspråklig håndtering

- Claude identifiserer språket i innkommende e-post automatisk
- Svaret utformes i samme språk
- ATS-feeden har beskrivelser på norsk (`fts_nb_no`), engelsk (`fts_en_us`) og tysk (`fts_de_de`) som brukes der de matcher

### Ansattfordeling

Startversjon: Round-robin mellom 4-5 ansatte. Agenten holder en teller i gruppehukommelsen og roterer.

Senere utvidelser:
- Fagområde-basert fordeling (lastebiler → Ola, anlegg → Kari)
- Kunderelasjon-basert fordeling

## Agentinstruksjoner (CLAUDE.md)

Gruppens CLAUDE.md inneholder:
- Liste over ansatte med navn, e-post og fargekategori
- Tone og stil for e-postsvar
- Regler for hva som besvares vs. eskaleres
- Instruksjon om flerspråklig svarhåndtering
- Lenker til ATS-feed verktøy

## Åpne spørsmål

1. **E-post-autentisering:** Shared mailbox med "Send As"-rettigheter eller individuelle OAuth-tokens? Avventer kundesvar.

## Fremtidige utvidelser

- Auto-sending for kvalitetssikrede henvendelsestyper
- Smart fordeling basert på fagområde og kunderelasjon
- Flere datakilder (API-er, databaser, dokumenter)
- Kundens egen Anthropic API-nøkkel
- Deploy-script for raskere utrulling av nye kunder
