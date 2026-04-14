# E-post Draft Deduplisering — Design

## Problemet

Når kundecontaineren restartes midt i e-postkøen, prosesseres e-poster på nytt og det kan lages duplikatutkast for samme henvendelse. Det finnes ingen sporing av hvilke e-poster som allerede har fått utkast.

## Scope

Kun `AGENT_MODE=direct` (kundeinstansen).

## Løsning

### Ny tabell `email_drafts`

Opprettes i meldingsdatabasen (`store/messages.db`) via `initDatabase()` i `src/db.ts`.

| Kolonne | Type | Beskrivelse |
|---------|------|-------------|
| `email_id` | TEXT PRIMARY KEY | Meldings-ID fra e-posten (msg.id fra Gmail/Outlook) |
| `draft_created_at` | TEXT NOT NULL | ISO timestamp for når utkastet ble opprettet |
| `to_address` | TEXT | Mottaker-adressen |
| `subject` | TEXT | Emnet på utkastet |

### Sjekk før prosessering

I `processGroupMessages()` i `src/index.ts`, etter å ha hentet 1 melding i direct mode: sjekk om meldingens ID allerede finnes i `email_drafts`. Hvis ja, avansér cursor og re-enqueue for neste melding. Logg at duplikat ble hoppet over.

### Registrer etter utkast

I IPC-watcheren (`src/ipc.ts`), etter vellykket `save_gmail_draft` eller `save_outlook_draft`: sett inn en rad i `email_drafts` med meldings-ID, tidspunkt, mottaker og emne.

Meldings-ID-en må flyte gjennom fra agenten via IPC-filen. Direct agent sender meldingens `id` (fra e-posten) som `emailId` i IPC-data.

### Flyt

```
processGroupMessages:
  Hent eldste melding (msg.id = "abc123")
  → sjekk email_drafts for "abc123"
  → finnes? → logg "skipping, draft exists" → avansér cursor → re-enqueue
  → finnes ikke → send til Claude → Claude kaller create_draft → IPC
  
IPC-watcher:
  → save_gmail_draft med emailId="abc123"
  → opprett Gmail-utkast
  → INSERT INTO email_drafts (email_id, ...) VALUES ("abc123", ...)
```

## Ikke endret

- Container mode — ingen endring
- Gmail/Outlook-kanaler — uendret
- direct-agent.ts — uendret (emailId sendes allerede som msg.id i prompten)
