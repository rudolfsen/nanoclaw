# Personlig Assistent — Kapabilitetsdesign

## Oversikt

Andy er en personlig assistent for Magnus, tilgjengelig via Telegram. Assistenten håndterer fire områder: e-posttriage, regnskap, daglig struktur/helse, og musikktips. Andy kjører på en Hetzner VPS som en NanoClaw-instans med Docker-containere.

## Designprinsipp

**Andy tar ikke initiativ med mindre du har bedt om det.** Unntak: e-postvarsler for viktige ting, påminnelser brukeren har satt, og ukeplanen (søndag kveld, opt-in).

Andy skal føles som en støttende kollega — ikke en alarm. Kort, konkret, ingen preken.

## 1. E-post triage

### Problem
Magnus får enormt mye e-post der det meste er reklame eller ting som ikke krever oppmerksomhet. Viktige ting drukner.

### Løsning
Gmail og Outlook polles på intervall (allerede bygget). Hver ny e-post klassifiseres av Claude i containeren.

### Kategorier
- `viktig` — fra en person (ikke noreply/bedrift), eller inneholder en direkte forespørsel til Magnus
- `handling_kreves` — krever en handling fra Magnus innen en frist
- `kvittering` — faktura, ordrebekreftelse, betaling
- `nyhetsbrev` — abonnementsbaserte utsendelser
- `reklame` — markedsføring, kampanjer, tilbud
- `annet` — alt annet (inkludert Shopify-bestillinger)

### Varsling
- `viktig` og `handling_kreves` → umiddelbar Telegram-melding med avsender, emne og kort sammendrag
- `handling_kreves` → tydelig markering av hva som trengs og eventuell frist
- Daglig oppsummering kl 08:00: "12 nye i går — 2 viktige, 1 handling, 3 kvitteringer, 6 reklame"

### Organisering
- Gmail: setter labels (Viktig, Handling, Kvittering, Nyhetsbrev, Reklame)
- Outlook: flytter til mapper med tilsvarende navn
- Kvitteringer flagges for regnskapsmodulen

### Harde regler
- Aldri sende e-post på Magnus' vegne
- Shopify-bestillinger fra forlag er IKKE viktige — kategori `annet`

## 2. Regnskap

### Problem
Kvitteringer og fakturaer skal samles og sendes til regnskapsbotten. Meta-fakturaer finnes ikke som PDF via API.

### Kvitteringer fra e-post
- E-posttriagen flagger kvitteringer automatisk
- PDF-vedlegg plukkes ut direkte fra e-posten
- Inline-kvitteringer (digitale tjenester uten vedlegg) → parser data, genererer PDF med pdfkit

### Annonsefakturaer
- **Meta:** agent-browser logger inn i Facebook Ads Manager, navigerer til Billing, laster ned faktura-PDF-er. Meta har ikke et API for faktura-PDF-er — browser-automatisering er eneste vei.
- **Snap:** Henter via API (allerede bygget). PDF som base64 i API-responsen.

### Flyt
1. Kvitteringer/fakturaer mellomlagres i `receipts/`
2. Pushes til regnskapsbotten via voucher inbox (Supabase)
3. Logges i SQLite (`receipts`-tabell) for å unngå duplikater

### Scheduled tasks
- Daglig: skann e-post for nye kvitteringer
- Månedlig (1. i måneden): hent Meta- og Snap-fakturaer for forrige måned
- Etter hver kjøring: Telegram-melding med sammendrag ("3 nye kvitteringer sendt til regnskap")

## 3. Privat — daglig struktur og helse

### Problem
Magnus jobber mye alene fra hjemmekontor og mangler den eksterne strukturen et kontor gir. Mat, trening og gode vaner faller mellom stolene — ikke fordi han ikke vet hva han bør gjøre, men fordi det krever planlegging og initiativ han ikke har overskudd til. Han ønsker også å slutte med snus og vape.

### Tilnærming
Andy er tilgjengelig når Magnus tar kontakt — ikke proaktiv med mindre bedt om det. Andy husker kontekst og tilpasser seg over tid.

### Interaksjonsmodell (pull, ikke push)
- "morgen" → Andy gir dagens plan (mat, trening, gjøremål)
- "hva skal jeg spise" → oppskrift fra ukeplanen
- "lyst på snus" → kort støtte uten preken, praktisk alternativ
- "ferdig for i dag" → Andy logger og sier god kveld
- "treningsforslag" → økt basert på hva som er gjort den uka

### Mat — oppskriftsbibliotek og ukeplan

**Oppskriftsbibliotek:**
- Andy henter oppskrifter jevnlig fra norske matsider (godt.no, matprat.no, tine.no) via agent-browser
- Lagrer oppskrifter lokalt med tittel, ingredienser, fremgangsmåte, og kilde-URL
- Filtrerer basert på preferanser og sesong
- Bygger opp biblioteket over tid — alltid et utvalg klart

**Ukeplan (opt-in, søndag kveld):**
- Andy velger måltider fra biblioteket basert på sesong, preferanser og variasjon
- Treningsøkter fordelt på uka
- Handleliste basert på måltidene
- Magnus godkjenner eller justerer: "bytt onsdag og torsdag", "dropp fisk"

### Nikotinavvenning
- Snus og vape
- Kjente triggere: kjedsomhet og etter måltider
- Andy gir støtte når Magnus tar kontakt ("lyst på snus")
- Praktiske alternativer i øyeblikket — ikke belærende
- Ukentlig oppsummering (som del av ukeplan-check-in): fremgang, dager siden sist
- Magnus velger selv tilnærming (nedtrapping/cold turkey)

### Hukommelse
- Matpreferanser, treningslogg, nikotinfremgang lagres i gruppens CLAUDE.md
- Andy tilpasser seg over tid — husker hva som funker og hva som ikke funker

### Påminnelser
- Magnus setter påminnelser via samtale: "Minn meg på tannlegen fredag"
- Bruker NanoClaw sin innebygde task-scheduler
- Kun påminnelser Magnus selv har bedt om

## 4. Musikktips

### Problem
Magnus hører på musikk på Spotify, YouTube Music og SoundCloud og vil ha nye anbefalinger basert på hva han allerede hører på.

### Løsning
- Spotify API henter toppartister, sist spilte, og lagrede spillelister som grunnlag
- Magnus kan finjustere via samtale: "Mer av dette", "Ikke fan av jazz"
- Kontekstbaserte forslag: "noe for kontoret", "trening", "chill"
- YouTube Music og SoundCloud har ikke gode API-er for brukerdata — Spotify er primærkilde
- Andy kan anbefale artister/låter å søke opp på alle tre plattformene
- Andy husker preferanser over tid

### Integrasjon
- Spotify Web API med OAuth2 (lese-tilgang til brukerens bibliotek og lyttehistorikk)
- Scopes: `user-top-read`, `user-read-recently-played`, `user-library-read`
- Auth-flyt: engangsgodkjenning lokalt (som Google OAuth), refresh token på serveren

## Infrastruktur

### Eksisterende (fungerer)
- NanoClaw på Hetzner VPS (204.168.178.32)
- Telegram-kanal (@numra_assistent_bot)
- Gmail-kanal (magnus.rudolfsen@gmail.com)
- Docker-containere med Claude Agent SDK
- SQLite-database
- Regnskapsbott-integrasjon (Supabase)
- Snap Ads API

### Må bygges/fikses
- E-postklassifisering som scheduled task (skill-kode finnes delvis)
- Outlook-kanal (kode finnes men er ikke importert/aktiv)
- Meta faktura-PDF via agent-browser
- Spotify OAuth2 + API-integrasjon
- Ukeplan-generering (samtalebasert, ingen ny infrastruktur)
- Nikotinavvenning (samtalebasert, ingen ny infrastruktur)

### Interaksjonsmodell oppsummert

| Område | Modell | Proaktiv? |
|--------|--------|-----------|
| E-post triage | Automatisk | Ja — varsler om viktig, daglig oppsummering |
| Regnskap | Automatisk | Ja — melding etter kjøring |
| Privat/struktur | På forespørsel | Nei — kun påminnelser brukeren har satt + ukeplan (opt-in) |
| Musikk | På forespørsel | Nei |
