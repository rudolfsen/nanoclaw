# ATS E-postassistent — Løsningsbeskrivelse

## Hva er dette?

En AI-assistent som hjelper med å besvare e-posthenvendelser om brukte maskiner og kjøretøy. Assistenten leser den felles innboksen, forstår hva kunden spør om, slår opp relevante maskiner fra ats.no, og lager et ferdig svarutkast som en ansatt godkjenner før sending.

## Hvordan fungerer det?

1. **E-post kommer inn** til den felles innboksen
2. **Assistenten leser og tolker** henvendelsen — hva kunden er ute etter, hvilket språk de skriver på
3. **Slår opp på ats.no** — finner relevante maskiner med priser, spesifikasjoner og tilgjengelighet
4. **Fordeler til riktig ansatt** — e-posten fargekodes i Outlook slik at det er tydelig hvem som har ansvaret
5. **Lager et svarutkast** beriket med maskindata, klart til gjennomgang
6. **Varsler via Slack** — ansatt får beskjed om at et utkast er klart
7. **Ansatt godkjenner og sender** — ingenting sendes uten manuell godkjenning

## Nøkkelegenskaper

### Flerspråklig
Assistenten svarer alltid i samme språk som henvendelsen kom på. Norsk, engelsk, tysk og andre språk håndteres automatisk.

### Fargekoding i Outlook
Hver ansatt får en fargekategori. Når assistenten fordeler en henvendelse, fargekodes e-posten i innboksen — så alle ser hvem som har ballen.

### Fordeling mellom ansatte
I starten fordeles henvendelser jevnt (round-robin) mellom 4-5 ansatte. Senere kan dette utvides til fordeling basert på fagområde eller eksisterende kunderelasjon.

### Beriket med maskindata
Svarutkastene inneholder faktiske data fra ats.no — pris, spesifikasjoner, tilgjengelighet — slik at kunden får et informativt svar uten at den ansatte trenger å slå opp manuelt.

## Kommunikasjonskanaler

| Kanal | Bruk |
|-------|------|
| **Outlook (e-post)** | Lese innkommende henvendelser, opprette svarutkast, fargekode |
| **Slack** | Notifikasjoner til ansatte, interaksjon med assistenten |

## Hva vi trenger fra dere

1. **Slack workspace** — vi oppretter en Slack-app i deres workspace
2. **Tilgang til felles innboks** — assistenten trenger lesetilgang til den felles e-postkontoen via Microsoft 365
3. **Utkast/send-tilgang** — for å opprette svarutkast. Her er det to alternativer vi må avklare:
   - **Alternativ A:** Felles innboks med "Send As"-rettigheter for hver ansatt (enklest — ren IT-admin-operasjon)
   - **Alternativ B:** Individuell tilgang per ansatt
4. **Liste over ansatte** som skal motta henvendelser (navn, e-post, ønsket fargekategori)
5. **Tone og stil** — hvordan ønsker dere at svarene skal formuleres?
6. **Eskaleringskriterier** — finnes det henvendelser som ikke skal besvares av assistenten, men eskaleres direkte?

## Hva som kommer senere

- **Automatisk sending** for henvendelsestyper assistenten håndterer godt (når dere er komfortable med kvaliteten)
- **Smartere fordeling** basert på fagområde og kunderelasjon
- **Flere datakilder** — integrasjon mot andre interne systemer (API-er, databaser, dokumenter)
