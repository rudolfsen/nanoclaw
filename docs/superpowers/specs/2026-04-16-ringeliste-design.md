# Dagens Ringeliste — Design

## Problemet

Selgerne har mange leads fra ulike kilder (chat-kontakter, Finn "ønskes kjøpt") men ingen prioritert liste over hvem de bør ringe først.

## Løsning

En "Topp 10 å ringe i dag"-liste som rangerer leads etter en vektet score basert på timing, match og verdi. Tilgjengelig i dashboardet og via Telegram.

## Scoring (0-100)

| Faktor | Vekt | Logikk |
|--------|------|--------|
| Timing | 40% | Siste 24t = 40p, 1-3 dager = 25p, 3-7 dager = 10p, eldre = 0 |
| Match | 35% | Har match i ATS/LBS = 35p, ingen match = 0 |
| Verdi | 25% | Matchede maskiners pris: >500k = 25p, 200-500k = 15p, <200k = 5p, ukjent = 10p |

## Hvilke leads kvalifiserer

1. **Chat-kontakter** med telefon eller e-post (fra `chat_contacts` tabell)
2. **Finn "ønskes kjøpt"** med `has_match` status (fra `leads` tabell, `source = 'finn_wanted'`)

Leads som allerede er kontaktet (`status = 'contacted'` eller `'closed'`) ekskluderes.

## Hva som vises per lead

For chat-kontakter:
- Navn, telefon, e-post
- Hva de leter etter
- Matchede maskiner med pris og lenke
- Kilde (Chat ats.no / lbs.no) og tidspunkt

For Finn-leads:
- Annonsetittel
- Telefon (hvis tilgjengelig fra scraping)
- Lenke til Finn-annonsen
- Matchede maskiner med pris og lenke
- Tidspunkt

## Implementering

### Ny funksjon `generateCallList()`

Henter fra begge kilder, scorer hver lead, sorterer etter score, returnerer topp 10.

Query for chat-kontakter:
```sql
SELECT * FROM chat_contacts WHERE status = 'new' ORDER BY created_at DESC
```

Query for Finn-leads:
```sql
SELECT * FROM leads WHERE source = 'finn_wanted' AND match_status = 'has_match' AND status = 'new' ORDER BY created_at DESC LIMIT 50
```

Scorer og merger begge lister, sorterer, returnerer topp 10.

### Endringer

| Fil | Endring |
|-----|---------|
| `src/lead-dashboard.ts` | Ny endpoint `GET /api/call-list` |
| `dashboard/index.html` | Ny seksjon øverst: "Dagens ringeliste" |
| `container/skills/leads/leads.sh` | Ny kommando `ringeliste` |
| `src/direct-agent.ts` | Legg til `ringeliste` i leads-verktøyet |
