# Direct Mode E-postkø — Design

## Problemet

NanoClaw sin meldingsloop er designet for chat der meldinger strømmer inn i sanntid. E-postkanaler (Gmail, Outlook) leverer en batch med historiske meldinger ved oppstart. Etter at meldingsloopen prosesserer første batch, avanseres `lastAgentTimestamp`-cursoren forbi de resterende meldingene — de prosesseres aldri.

I tillegg: med mange e-poster i én prompt (10+) kombinert med mange tool-kall per e-post, blir konteksten for stor for Claude og API-kallet timer ut.

## Scope

Kun `AGENT_MODE=direct` (kundeinstansen). Personlig instans (container mode) er uberørt.

## Løsning

To endringer i `src/index.ts`, begge gated bak `AGENT_MODE === 'direct'`:

### 1. Hardkod MAX_MESSAGES_PER_PROMPT=1 i direct mode

I `processGroupMessages()`, når `AGENT_MODE === 'direct'`, begrens `getMessagesSince()` til 1 melding uansett hva `MAX_MESSAGES_PER_PROMPT` er konfigurert til. Dette sikrer at agenten alltid prosesserer én e-post om gangen.

### 2. Re-enqueue etter vellykket prosessering

Etter at `processGroupMessages()` har prosessert én melding vellykket, sjekk om det finnes flere ventende meldinger (kall `getMessagesSince` med oppdatert cursor). Hvis ja, kall `queue.enqueueMessageCheck(chatJid)` for å trigge neste runde. Dette skaper en drain-loop som tømmer køen én melding om gangen.

## Flyt

```
Oppstart
  → Gmail leverer 10 e-poster til DB
  → recoverPendingMessages() enqueuer chatJid
  → processGroupMessages() henter 1 melding (den nyeste som er etter cursor)
  → Claude prosesserer: søk + utkast (~30 sek)
  → lastAgentTimestamp avanseres til denne meldingen
  → sjekk: flere ventende? ja → enqueue chatJid
  → processGroupMessages() henter neste melding
  → ... gjentar til køen er tom
```

## Ikke endret

- Container mode (personlig instans) — ingen endring, MAX_MESSAGES_PER_PROMPT fungerer som før
- Gmail-kanalen — leverer fortsatt alle e-poster ved oppstart
- Meldingsloopens poll-intervall (2 sek) — uendret
- GroupQueue retry-logikk — uendret
- direct-agent.ts — uendret

## Risiko

Lav. Endringene er gated bak `AGENT_MODE === 'direct'` og påvirker kun kundeinstanser.
