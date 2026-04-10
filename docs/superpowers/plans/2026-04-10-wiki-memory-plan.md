# Wiki Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat CLAUDE.md logs with per-group wiki directories that Bambi self-maintains, with controlled cross-group access for meal wishes.

**Architecture:** Create `wiki/` directories in each group folder, migrate existing data from CLAUDE.md into structured wiki files, update CLAUDE.md personality files with wiki instructions, and configure `additionalMounts` + mount-allowlist for cross-group meal-wish access.

**Tech Stack:** Markdown files, SQLite (container_config in registered_groups), mount-allowlist.json

---

### Task 1: Create wiki directories and seed files

**Files:**
- Create: `groups/global/wiki/index.md`
- Create: `groups/global/wiki/log.md`
- Create: `groups/global/wiki/shopping-list.md`
- Create: `groups/global/wiki/recipes/index.md`

- [ ] **Step 1: Create global wiki structure**

```bash
mkdir -p groups/global/wiki/recipes
```

```markdown
<!-- groups/global/wiki/index.md -->
# Felles Wiki

Sist oppdatert: 2026-04-10

## Sider
- [shopping-list.md](shopping-list.md) — Felles handleliste for familien
- [recipes/index.md](recipes/index.md) — Oppskriftsbibliotek
```

```markdown
<!-- groups/global/wiki/log.md -->
# Operations Log

2026-04-10 — Wiki opprettet
```

```markdown
<!-- groups/global/wiki/shopping-list.md -->
# Handleliste

(Bambi oppdaterer denne basert på ukeplaner og forespørsler)
```

```markdown
<!-- groups/global/wiki/recipes/index.md -->
# Oppskriftsbibliotek

Bambi bygger dette opp over tid fra godt.no, matprat.no og tine.no.

## Oppskrifter

(Bambi legger til oppskrifter her)
```

- [ ] **Step 2: Create privat (Magnus) wiki**

```bash
mkdir -p groups/privat/wiki
```

```markdown
<!-- groups/privat/wiki/index.md -->
# Magnus Wiki

Sist oppdatert: 2026-04-10

## Sider
- [meal-wishes.md](meal-wishes.md) — Middagsønsker
- [training-log.md](training-log.md) — Treningslogg
- [nicotine-log.md](nicotine-log.md) — Nikotinavvenning
- [food-preferences.md](food-preferences.md) — Matpreferanser
- [music-preferences.md](music-preferences.md) — Musikkpreferanser
```

Create empty template files for each:

```markdown
<!-- groups/privat/wiki/meal-wishes.md -->
# Middagsønsker

Format: YYYY-MM-DD — ønske

```

```markdown
<!-- groups/privat/wiki/training-log.md -->
# Treningslogg

Format: YYYY-MM-DD — type trening, varighet, notater

```

```markdown
<!-- groups/privat/wiki/nicotine-log.md -->
# Nikotinavvenning

Format: YYYY-MM-DD — status, triggere, notater

```

```markdown
<!-- groups/privat/wiki/food-preferences.md -->
# Matpreferanser

## Liker

## Liker ikke

## Allergier/intoleranser

```

```markdown
<!-- groups/privat/wiki/music-preferences.md -->
# Musikkpreferanser

## Favorittartister

## Sjangre

## Liker ikke

## Anbefalinger som traff

```

```markdown
<!-- groups/privat/wiki/log.md -->
# Operations Log

2026-04-10 — Wiki opprettet
```

- [ ] **Step 3: Commit**

```bash
git add groups/global/wiki/ groups/privat/wiki/
git commit -m "feat: create wiki directory structure for global and privat"
```

---

### Task 2: Create wiki directories for Vera, Lotta (on server)

Since Vera and Lotta's group folders only exist on the server (not in git), these are created directly.

- [ ] **Step 1: Create datter (Lotta) wiki on server**

```bash
ssh root@204.168.178.32 'mkdir -p /opt/assistent/groups/datter/wiki && cat > /opt/assistent/groups/datter/wiki/index.md << EOF
# Lottas Wiki

Sist oppdatert: 2026-04-10

## Sider
- [meal-wishes.md](meal-wishes.md) — Middagsønsker
- [strengths.md](strengths.md) — Styrker og fremgang
- [school-notes.md](school-notes.md) — Skolenotater
EOF

cat > /opt/assistent/groups/datter/wiki/meal-wishes.md << EOF
# Middagsønsker

Format: YYYY-MM-DD — ønske
EOF

cat > /opt/assistent/groups/datter/wiki/strengths.md << EOF
# Lottas styrker og fremgang

Bambi oppdaterer denne basert på samtaler.
EOF

cat > /opt/assistent/groups/datter/wiki/school-notes.md << EOF
# Skolenotater

Bambi lagrer nyttige notater fra leksearbeid her.
EOF

cat > /opt/assistent/groups/datter/wiki/log.md << EOF
# Operations Log

2026-04-10 — Wiki opprettet
EOF'
```

- [ ] **Step 2: Create vera wiki on server**

```bash
ssh root@204.168.178.32 'mkdir -p /opt/assistent/groups/vera/wiki && cat > /opt/assistent/groups/vera/wiki/index.md << EOF
# Veras Wiki

Sist oppdatert: 2026-04-10

## Sider
- [meal-wishes.md](meal-wishes.md) — Middagsønsker
- [training-log.md](training-log.md) — Treningslogg
- [preferences.md](preferences.md) — Preferanser (mat, interiør, reise, etc.)
EOF

cat > /opt/assistent/groups/vera/wiki/meal-wishes.md << EOF
# Middagsønsker

Format: YYYY-MM-DD — ønske
EOF

cat > /opt/assistent/groups/vera/wiki/training-log.md << EOF
# Treningslogg

Format: YYYY-MM-DD — type trening, varighet, notater
EOF

cat > /opt/assistent/groups/vera/wiki/preferences.md << EOF
# Veras preferanser

## Mat

## Trening

## Interiør

## Reise
EOF

cat > /opt/assistent/groups/vera/wiki/log.md << EOF
# Operations Log

2026-04-10 — Wiki opprettet
EOF'
```

- [ ] **Step 3: Migrate existing data from CLAUDE.md**

Move any existing data from the log sections at the bottom of each CLAUDE.md into the corresponding wiki files. Then remove the log sections from CLAUDE.md.

On server for datter:
```bash
ssh root@204.168.178.32 'grep -A 100 "## Middagsønsker" /opt/assistent/groups/datter/CLAUDE.md | head -20'
# If there's data, append it to wiki/meal-wishes.md
# Then remove the sections from CLAUDE.md
```

Same for vera.

---

### Task 3: Update CLAUDE.md files with wiki instructions

**Files:**
- Modify: `groups/privat/CLAUDE.md`
- Modify (on server): `groups/datter/CLAUDE.md`
- Modify (on server): `groups/vera/CLAUDE.md`
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Add wiki instructions to global CLAUDE.md**

Append to `groups/global/CLAUDE.md`:

```markdown
## Wiki

Alle grupper har tilgang til den felles wikien i `wiki/` (denne mappen).

### Felles ressurser
- `wiki/shopping-list.md` — handleliste for familien
- `wiki/recipes/` — oppskriftsbibliotek

### Regler for wiki-bruk
- Én fil per tema (ikke dump alt i én fil)
- Bruk korte, faktabaserte setninger
- Dato-prefix på logger (YYYY-MM-DD)
- Oppdater, ikke dupliser — endre eksisterende info i stedet for å legge til
- Hold `wiki/index.md` oppdatert når du oppretter nye sider
- Legg til en linje i `wiki/log.md` etter større oppdateringer
```

- [ ] **Step 2: Update privat CLAUDE.md — remove log sections, add wiki reference**

Remove these sections from the bottom of `groups/privat/CLAUDE.md`:
- `## Treningslogg`
- `## Nikotinlogg`
- `## Matpreferanser`
- `## Musikkpreferanser`

Replace with:

```markdown
## Wiki

Du har en personlig wiki i `wiki/` for å huske ting over tid.

### Bruk
- Når du lærer noe nytt om Magnus: oppdater relevant wiki-side
- Når du trenger kontekst: les `wiki/index.md` og deretter relevante sider
- Opprett nye sider når et tema trenger sin egen plass

### Dine wiki-sider
- `wiki/meal-wishes.md` — middagsønsker
- `wiki/training-log.md` — treningslogg
- `wiki/nicotine-log.md` — nikotinavvenning
- `wiki/food-preferences.md` — matpreferanser
- `wiki/music-preferences.md` — musikkpreferanser

### Familiens middagsønsker (read-only)
- `/workspace/extra/vera-meals` — Veras ønsker
- `/workspace/extra/datter-meals` — Lottas ønsker

### Felles wiki
- `/workspace/global/wiki/` — oppskrifter, handleliste
```

- [ ] **Step 3: Update datter CLAUDE.md on server**

Remove log sections (`## Middagsønsker`, `## Lottas styrker og fremgang`, `## Lottas notater`). Replace with:

```markdown
## Wiki

Du har en personlig wiki i `wiki/` for å huske ting over tid.

### Bruk
- Når du lærer noe nytt om Lotta: oppdater relevant wiki-side
- Middagsønsker → `wiki/meal-wishes.md`
- Styrker og fremgang → `wiki/strengths.md`
- Skolenotater → `wiki/school-notes.md`
- Hold `wiki/index.md` oppdatert

### Felles wiki (read-only)
- `/workspace/global/wiki/` — oppskrifter
```

- [ ] **Step 4: Update vera CLAUDE.md on server**

Remove log sections (`## Middagsønsker`, `## Handleliste`, `## Treningslogg`, `## Veras preferanser`, `## Veras notater`). Replace with:

```markdown
## Wiki

Du har en personlig wiki i `wiki/` for å huske ting over tid.

### Bruk
- Når du lærer noe nytt om Vera: oppdater relevant wiki-side
- Middagsønsker → `wiki/meal-wishes.md`
- Treningslogg → `wiki/training-log.md`
- Preferanser → `wiki/preferences.md`
- Hold `wiki/index.md` oppdatert

### Familiens middagsønsker (read-only)
- `/workspace/extra/privat-meals` — Magnus' ønsker
- `/workspace/extra/datter-meals` — Lottas ønsker

### Felles wiki
- `/workspace/global/wiki/` — oppskrifter, handleliste
```

- [ ] **Step 5: Commit local changes**

```bash
git add groups/privat/CLAUDE.md groups/global/CLAUDE.md
git commit -m "feat: add wiki instructions to CLAUDE.md files"
```

---

### Task 4: Configure additionalMounts for cross-group meal-wish access

- [ ] **Step 1: Create mount-allowlist on server**

```bash
ssh root@204.168.178.32 'mkdir -p ~/.config/nanoclaw && cat > ~/.config/nanoclaw/mount-allowlist.json << EOF
{
  "allowedRoots": [
    {
      "path": "/opt/assistent/groups",
      "allowReadWrite": false,
      "description": "Group folders for cross-group meal wish access"
    }
  ],
  "blockedPatterns": [".ssh", ".gnupg", ".env", "credentials", "private_key"],
  "nonMainReadOnly": true
}
EOF'
```

- [ ] **Step 2: Update Magnus (privat) container_config**

```bash
ssh root@204.168.178.32 'sqlite3 /opt/assistent/store/messages.db "UPDATE registered_groups SET container_config = json('"'"'{\"additionalMounts\":[{\"hostPath\":\"/opt/assistent/groups/vera/wiki/meal-wishes.md\",\"containerPath\":\"vera-meals\",\"readonly\":true},{\"hostPath\":\"/opt/assistent/groups/datter/wiki/meal-wishes.md\",\"containerPath\":\"datter-meals\",\"readonly\":true}]}'"'"') WHERE folder = '"'"'privat'"'"'"'
```

- [ ] **Step 3: Update Vera container_config**

```bash
ssh root@204.168.178.32 'sqlite3 /opt/assistent/store/messages.db "UPDATE registered_groups SET container_config = json('"'"'{\"additionalMounts\":[{\"hostPath\":\"/opt/assistent/groups/privat/wiki/meal-wishes.md\",\"containerPath\":\"privat-meals\",\"readonly\":true},{\"hostPath\":\"/opt/assistent/groups/datter/wiki/meal-wishes.md\",\"containerPath\":\"datter-meals\",\"readonly\":true}]}'"'"') WHERE folder = '"'"'vera'"'"'"'
```

- [ ] **Step 4: Restart and verify**

```bash
ssh root@204.168.178.32 'systemctl restart nanoclaw && sleep 5 && journalctl -u nanoclaw --no-pager -n 5 --since "5 sec ago"'
```

---

### Task 5: Set up weekly wiki lint task

- [ ] **Step 1: Create lint scheduled tasks**

```bash
ssh root@204.168.178.32 'sqlite3 /opt/assistent/store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, context_mode, created_at) VALUES
(\"wiki-lint-privat\", \"privat\", \"tg:6787115988\", \"Vedlikehold din wiki: les wiki/index.md, sjekk at alle sider eksisterer og er oppdaterte. Fjern duplikater, oppdater index, legg til en linje i wiki/log.md. Ikke send meg noe med mindre du finner problemer.\", \"cron\", \"0 22 * * 0\", datetime(\"now\", \"+1 day\"), \"active\", \"group\", datetime(\"now\")),
(\"wiki-lint-datter\", \"datter\", \"tg:8127138246\", \"Vedlikehold din wiki: les wiki/index.md, sjekk at alle sider er oppdaterte. Fjern duplikater, oppdater index. Ikke send Lotta noe med mindre du finner problemer.\", \"cron\", \"0 22 * * 0\", datetime(\"now\", \"+1 day\"), \"active\", \"isolated\", datetime(\"now\")),
(\"wiki-lint-vera\", \"vera\", \"tg:7103997466\", \"Vedlikehold din wiki: les wiki/index.md, sjekk at alle sider er oppdaterte. Fjern duplikater, oppdater index. Ikke send Vera noe med mindre du finner problemer.\", \"cron\", \"0 22 * * 0\", datetime(\"now\", \"+1 day\"), \"active\", \"isolated\", datetime(\"now\"))"'
```

- [ ] **Step 2: Verify all scheduled tasks**

```bash
ssh root@204.168.178.32 'sqlite3 /opt/assistent/store/messages.db "SELECT id, group_folder, schedule_value FROM scheduled_tasks WHERE status = \"active\" ORDER BY group_folder"'
```

---

### Task 6: Deploy and verify

- [ ] **Step 1: Push and deploy**

```bash
git push origin main
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && systemctl restart nanoclaw'
```

- [ ] **Step 2: Verify wiki directories exist**

```bash
ssh root@204.168.178.32 'ls -la /opt/assistent/groups/privat/wiki/ && ls -la /opt/assistent/groups/datter/wiki/ && ls -la /opt/assistent/groups/vera/wiki/ && ls -la /opt/assistent/groups/global/wiki/'
```

- [ ] **Step 3: Test via Telegram**

Send to Bambi: `Jeg liker ikke koriander. Husk det.`

Verify Bambi updates `wiki/food-preferences.md` rather than appending to CLAUDE.md.

- [ ] **Step 4: Test cross-group access**

Send to Bambi: `Hva har familien lyst på til middag denne uka?`

Verify Bambi reads meal-wishes from all mounted family files.
