# Chat-kontakthåndtering — Design

## Problemet

Besøkende på ats.no og landbrukssalg.no kan chatte med assistenten og legge igjen kontaktinfo, men det lagres bare som JSON-filer uten varsling, samtalelogg eller oppfølgingsstatus.

## Løsning

### Lagring

Ny SQLite-tabell `chat_contacts` i leads-databasen (`data/leads.sqlite`):

| Kolonne | Type | Beskrivelse |
|---------|------|-------------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| name | TEXT NOT NULL | Kundens navn |
| phone | TEXT | Telefonnummer |
| email | TEXT | E-postadresse |
| interest | TEXT | Hva de leter etter |
| site | TEXT NOT NULL | ats / lbs |
| conversation | TEXT | JSON-array med hele samtaleloggen |
| machines_shown | TEXT | JSON-array med maskin-IDer/lenker vist i samtalen |
| status | TEXT DEFAULT 'new' | new / contacted / closed |
| created_at | TEXT NOT NULL | ISO timestamp |

### Varsling

E-post sendes umiddelbart til Bjørnar (`bjornar@lbs.no`) via Gmail-kanalen (allerede konfigurert i kundecontaineren) når `save_contact` kalles.

E-postformat (ren tekst):

```
Ny henvendelse fra nettsiden!

Navn: [navn]
Telefon: [telefon]
E-post: [e-post]
Leter etter: [interest]

Samtale:
---
[Full samtalelogg formatert kronologisk]
---

Maskiner vist:
[Liste med tittel, pris, lenke]

Kilde: [ats.no / landbrukssalg.no]
Tidspunkt: [ISO timestamp]
```

Konfigurerbar mottaker via `CONTACT_NOTIFY_EMAIL` env-var (default: `bjornar@lbs.no`).

### Samtalelogg

Når `save_contact` kalles, lagres hele sessionens meldingshistorikk (fra `sessions`-mapet i chat-api.ts) sammen med kontakten. Maskiner som ble vist ekstraheres fra assistentens svar (parse lenker til ats.no/landbrukssalg.no).

### Oppfølging

Status per kontakt:
- `new` — nettopp mottatt, ikke kontaktet
- `contacted` — Bjørnar har ringt/sendt e-post
- `closed` — ferdig behandlet

Statusendring via:
- Dashboard REST API: `PATCH /api/contacts/:id` med `{ status: "contacted" }`
- Telegram: Bjørnar kan endre status via bot

### Synlighet

- **Dashboard** — ny seksjon i det eksisterende dashboardet med kontaktliste, filtrering, statusendring
- **Telegram** — `contacts`-kommando: `list`, `new`, `search`
- **E-post** — hovedvarslingen ved nye kontakter

## Endringer

| Fil | Endring |
|-----|---------|
| `src/chat-api.ts` | Erstatt JSON-fillagring med SQLite, legg til samtalelogg, send e-postvarsling |
| `src/lead-dashboard.ts` | Legg til `/api/contacts` og `/api/contacts/:id` endpoints |
| `dashboard/index.html` | Legg til kontakt-seksjon |
| `container/skills/leads/leads.sh` | Legg til `contacts` kommando |
| `src/direct-agent.ts` | Legg til `contacts` i leads-verktøyet |

## Ikke inkludert

- Automatisk SMS-varsling
- CRM-integrasjon
- Fordeling mellom flere selgere (Bjørnar håndterer alt nå)
