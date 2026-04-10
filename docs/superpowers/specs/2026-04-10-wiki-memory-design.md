# Wiki-basert minne for Bambi

## Oversikt

Erstatte flat CLAUDE.md-logger med en wiki-mappestruktur inspirert av Karpathys LLM Wiki-pattern. CLAUDE.md forblir fast personlighetsfil. Dynamisk data (logger, preferanser, ønsker) flyttes til `wiki/`-mapper som Bambi selv vedlikeholder med indeks, strukturerte sider og periodisk opprydding.

## Arkitektur

Tre lag per gruppe:
1. **CLAUDE.md** (fast) — personlighet, instruksjoner, regler. Endres sjelden, kun av utvikler.
2. **wiki/** (dynamisk) — markdown-sider som Bambi oppretter, oppdaterer og rydder. Én fil per tema.
3. **global/wiki/** (delt) — felles data som gjelder hele familien.

## Mappestruktur

```
groups/
  global/
    CLAUDE.md                   ← felles instruksjoner
    wiki/
      index.md                  ← innholdsfortegnelse (auto-vedlikeholdt)
      log.md                    ← append-only operasjonslogg
      recipes/                  ← oppskriftsbibliotek
        index.md
        *.md                    ← individuelle oppskrifter
      shopping-list.md          ← felles handleliste

  privat/                       ← Magnus
    CLAUDE.md                   ← personlighet (fast)
    wiki/
      index.md
      log.md
      meal-wishes.md
      training-log.md
      nicotine-log.md
      food-preferences.md
      music-preferences.md

  vera/
    CLAUDE.md                   ← personlighet (fast)
    wiki/
      index.md
      log.md
      meal-wishes.md
      training-log.md
      preferences.md

  datter/                       ← Lotta
    CLAUDE.md                   ← personlighet (fast)
    wiki/
      index.md
      log.md
      meal-wishes.md
      strengths.md
      school-notes.md

  noah/                         ← (når klar)
    CLAUDE.md
    wiki/
      index.md
      log.md
      meal-wishes.md
```

## Tilgangskontroll

Implementeres via `additionalMounts` i `registered_groups.container_config`.

### Magnus (privat)
| Ressurs | Tilgang |
|---------|---------|
| `privat/wiki/` | read-write |
| `global/wiki/` | read-write |
| `vera/wiki/meal-wishes.md` | read-only |
| `datter/wiki/meal-wishes.md` | read-only |
| `noah/wiki/meal-wishes.md` | read-only |

### Vera
| Ressurs | Tilgang |
|---------|---------|
| `vera/wiki/` | read-write |
| `global/wiki/` | read-write |
| `privat/wiki/meal-wishes.md` | read-only |
| `datter/wiki/meal-wishes.md` | read-only |
| `noah/wiki/meal-wishes.md` | read-only |

### Lotta (datter)
| Ressurs | Tilgang |
|---------|---------|
| `datter/wiki/` | read-write |
| `global/wiki/` | read-only |

### Noah
| Ressurs | Tilgang |
|---------|---------|
| `noah/wiki/` | read-write |
| `global/wiki/` | read-only |

### Tilgangsproblem: enkeltfil-montering

Docker kan montere enkeltfiler som read-only. For å gi Vera tilgang til kun `privat/wiki/meal-wishes.md` (ikke hele privat/wiki/), monterer vi filen direkte:

```json
{
  "additionalMounts": [
    {"hostPath": "groups/privat/wiki/meal-wishes.md", "containerPath": "privat-meals", "readonly": true}
  ]
}
```

Containeren ser filen som `/workspace/extra/privat-meals` (ikke hele mappen).

## Wiki-operasjoner

Bambi utfører tre typer operasjoner på wikien:

### Ingest (ved ny informasjon)
Når Bambi lærer noe nytt fra en samtale:
1. Oppdater relevant wiki-side (f.eks. `preferences.md`, `strengths.md`)
2. Oppdater `index.md` hvis ny side ble opprettet
3. Legg til en linje i `log.md`

### Query (ved spørsmål)
Når Bambi trenger kontekst:
1. Les `index.md` for å finne relevante sider
2. Les de relevante sidene
3. Bruk informasjonen i svaret

### Lint (periodisk vedlikehold)
Kjøres som scheduled task (ukentlig):
1. Sjekk for utdaterte oppføringer
2. Fjern duplikater
3. Oppdater `index.md`
4. Flagg motstridende informasjon

## index.md format

```markdown
# Wiki Index

Sist oppdatert: 2026-04-10

## Sider
- [meal-wishes.md](meal-wishes.md) — Middagsønsker for ukens matplan
- [training-log.md](training-log.md) — Treningslogg med dato og type
- [preferences.md](preferences.md) — Matpreferanser, allergier, favoritter
```

Én linje per side, oppdateres automatisk når sider opprettes/fjernes.

## log.md format

```markdown
# Operations Log

2026-04-10 14:30 — Updated meal-wishes.md: added "taco" wish
2026-04-10 15:00 — Updated training-log.md: logged strength training
2026-04-10 18:00 — Created school-notes.md: nynorsk grammar rules
```

Append-only. Bambi legger til nye linjer i bunnen.

## CLAUDE.md oppdatering

Hver gruppes CLAUDE.md får en ny seksjon som instruerer Bambi om wiki-bruk:

```markdown
## Wiki

Du har en personlig wiki i `wiki/` for å huske ting over tid.

### Bruk
- Når du lærer noe nytt om [person]: oppdater relevant wiki-side
- Når du trenger kontekst: les `wiki/index.md` og deretter relevante sider
- Opprett nye sider når et tema trenger sin egen plass
- Hold `wiki/index.md` oppdatert

### Regler
- Én fil per tema (ikke dump alt i én fil)
- Bruk korte, faktabaserte setninger
- Dato-prefix på logger (YYYY-MM-DD)
- Oppdater, ikke dupliser — endre eksisterende info i stedet for å legge til på nytt

### Tilgjengelige wiki-er
- `wiki/` — din egen (read-write)
- `/workspace/global/wiki/` — felles familiedata
- [eventuelle monterte meal-wishes fra andre grupper]
```

## Migrasjon fra eksisterende data

Eksisterende data i CLAUDE.md-filene (treningslogg, nikotinlogg, matpreferanser, middagsønsker, styrker, notater, handleliste) flyttes til wiki-filer. CLAUDE.md-filene strippes ned til kun personlighet + wiki-instruksjoner.

## Scheduled tasks

| Task | Frekvens | Gruppe | Beskrivelse |
|------|----------|--------|-------------|
| Wiki lint | Ukentlig (søndag 22:00) | Alle | Rydd opp, fjern duplikater, oppdater index |
