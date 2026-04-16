# Proaktiv Matching — Design

## Problemet

Vi har ~2500 maskiner til salgs og hundrevis av tidligere henvendelser (chat-kontakter, e-post, Finn "ønskes kjøpt"). Men når en ny maskin kommer inn, sjekker ingen automatisk om noen har spurt om akkurat denne typen.

## Løsning

Når en ny maskin dukker opp i ATS- eller LBS-feeden, sjekker systemet automatisk mot alle tidligere henvendelser og varsler Bjørnar hvis det er en match.

## Hva som triggers matching

Feed-syncen (ATS hvert 90s inkrementelt, LBS hvert 5 min) oppdager nye annonser. Nye annonser er de som ikke fantes i forrige sync (nye IDer). Når en ny annonse oppdages, kjøres matching mot tre kilder.

## Matching-kilder

### 1. Chat-kontakter (`chat_contacts` i leads.sqlite)

Folk som har brukt nettside-chatten og lagt igjen kontaktinfo. Feltet `interest` inneholder hva de lette etter. Match mot maskinens tittel, merke, type.

### 2. E-post-henvendelser (`email_drafts` i messages.db)

E-poster vi har besvart. Feltet `subject` inneholder emnet. Match mot maskinens tittel, merke, type.

### 3. Finn "ønskes kjøpt" (`leads` i leads.sqlite)

Finn-leads med `source = 'finn_wanted'` og `signal_type = 'demand'`. Feltet `title` inneholder hva de søker. Match mot maskinens tittel, merke, type.

## Matching-logikk

For hver ny maskin:
1. Ekstraher nøkkelord: merke (Volvo, John Deere), type (gravemaskin, traktor), modell
2. Søk i chat_contacts.interest med FTS5 eller LIKE
3. Søk i email_drafts.subject med LIKE
4. Søk i leads.title med FTS5 (kun finn_wanted, demand)
5. Filtrer ut kontakter eldre enn 30 dager (for gamle henvendelser)
6. Dedupliser (samme person kan ha henvendt seg via flere kanaler)

## Varsling

Når match finnes, send e-post til Bjørnar (`CONTACT_NOTIFY_EMAIL`) via IPC:

```
Ny maskin matcher en tidligere henvendelse!

Maskin: Volvo EC220E beltegraver (2018)
Pris: 1 290 000 kr
Lenke: https://ats.no/no/gjenstand/21771

Matchede henvendelser:
1. Per Hansen (chat, 3 dager siden)
   Spurte om: "Volvo gravemaskin"
   Telefon: 99887766

2. "Gravemaskin Volvo ønskes kjøpt" (Finn, 5 dager siden)
   Lenke: https://finn.no/item/459123
```

## Implementering

### Ny fil: `src/proactive-matcher.ts`

- `checkNewMachines(newAds, sources)` — tar liste med nye annonser og søker i alle kilder
- `notifyMatches(matches)` — sender e-post for funn

### Endringer i feed-sync

- `src/ats-feed-sync.ts` — etter upsert, sjekk om annonsen er ny (ikke oppdatering). Hvis ny, legg til i en "nye maskiner"-liste. Etter fullstendig sync, kall `checkNewMachines()`.
- `src/lbs-feed-sync.ts` — samme.

### Alternativ: Sjekk i lead-scanner

I stedet for å endre feed-sync, kan matching kjøres som en del av lead-scanner-loopen. Hvert 30. minutt: sjekk om det er nye maskiner i cache som ikke har blitt matchet før. Enklere implementering, litt tregere responstid.

Anbefalt: **alternativet** — hold feed-sync enkel, kjør matching i lead-scanner.

### Ny tabell: `matched_notifications`

For dedup — unngå å sende samme varsling to ganger.

| Kolonne | Type | Beskrivelse |
|---------|------|-------------|
| id | INTEGER PK | |
| machine_id | TEXT | Maskin-ID fra ATS/LBS |
| machine_source | TEXT | ats / lbs |
| contact_type | TEXT | chat / email / finn |
| contact_id | TEXT | ID fra kildetabell |
| notified_at | TEXT | Når varslingen ble sendt |

## Ikke inkludert

- Automatisk utsendelse til kunden (krever samtykke)
- Nettside-besøksdata
- Matching mot Brønnøysund/Doffin/Finn jobs
