# Chat Widget — Markdown-rendering og per-site verktøy-restriksjon

**Dato:** 2026-05-06
**Status:** Design godkjent
**Berører:** `src/chat-api.ts`, `widget/chat-widget.js`, `groups/chat-lbs/CLAUDE.md`, `groups/chat-ats/CLAUDE.md`, `src/chat-api.test.ts`, `package.json`

## Bakgrunn

Chat-widgeten på `lbs.no` og `ats.no` (servert fra `chat-api.ts` på port 3003) bruker en hand-rullet regex-basert markdown-parser i `widget/chat-widget.js:171-193` (`formatReply`). Dagens parser støtter bold, italic, lenker, bullets og nummererte lister. Den støtter **ikke** GFM-tabeller, headers, kodeblokker, blockquotes eller ordentlig avsnitt-spacing — agenten emitterer alle disse, så svarene vises ofte som rå markdown-syntaks.

Samtidig gir `chat-api.ts:303-306 getToolsForSite()` begge verktøy (`ats_feed` + `lbs_feed`) til begge sites. Kunder på lbs.no kan dermed søke i ATS' annonser og omvendt — uønsket for kundeopplevelse og merkevareskille.

`direct-agent.ts` (Telegram/Gmail) er **uberørt** av denne endringen — der beholder vi begge feeds for Magnus' interne agent.

## Mål

1. Pent rendret markdown i chat-widgeten — særlig GFM-tabeller for utstyrslister.
2. Per-site verktøy-restriksjon i chat-api.ts — `lbs` får kun `lbs_feed`, `ats` får kun `ats_feed`. `save_contact` deles av begge.
3. Holde widget-bundle liten — den lastes på hver kundenettside.

## Arkitektur

```
[Bruker på lbs.no]                          [Bruker på ats.no]
       │                                            │
       ▼                                            ▼
widget/chat-widget.js  (delt — én fil, data-site-styrt)
       │ POST /api/chat {message, sessionId, site}
       ▼
src/chat-api.ts
   ├─ getToolsForSite(site)        ← FIX: faktisk per-site
   ├─ Anthropic agentic loop       ← uendret
   ├─ marked.parse(text)           ← NY: server-side MD→HTML
   └─ sanitizeHtml(html, allowList)← NY: stram allow-list
       │ {reply: "<p>...</p><table>..."}
       ▼
widget formatReply()               ← FORENKLES: trust HTML, sett innerHTML
```

**Hvorfor server-side rendering:** Widget er en embed på kundens nettside. Bundle-budsjett er kritisk. Marked (~30 KB) + sanitize-html (~50 KB) på Node er gratis for klient. Server gir også full XSS-kontroll (sanitering på ett sted) og lar oss bytte parser senere uten ny widget-deploy hos kunder.

## Komponenter

### 1. Markdown-pipeline i `chat-api.ts`

**Avhengigheter:**
- `marked` — MD→HTML parser med GFM-støtte (tabeller, autolinks, strikethrough)
- `sanitize-html` — HTML-allowlist-sanitizer

**Konfigurasjon av marked:**
```ts
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

marked.use({ gfm: true, breaks: true });

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'hr',
    'h2', 'h3', 'h4',
    'ul', 'ol', 'li',
    'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

export function renderMarkdown(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { async: false }) as string;
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
```

**Plassering i flyten:** Etter at agenten returnerer endelig tekst (i `handleChat`, der `reply` settes), kjør `renderMarkdown(reply)` før responsen serialiseres.

**Session storage:** Lagrer fortsatt rå markdown (ikke HTML) i `session.messages` — gjør debug og fremtidig eksport renere.

**Edge cases:**
- Tom respons → tom string returneres uskadet
- Plain tekst uten markdown → marked wrapper i `<p>`-tag, ingen problem
- `h1` (`#`) er **ikke** i allowList — for stor for chat-boble. Agenten bruker uansett `##`/`###`.
- Inline-stiler og event-handlere blokkert by default.

### 2. Per-site verktøy-restriksjon i `chat-api.ts`

**Endring i `getToolsForSite` (linje 303-306):**
```ts
function getToolsForSite(site: SiteId): Anthropic.Tool[] {
  const feedTool = site === 'ats' ? ATS_TOOL : LBS_TOOL;
  return [feedTool, SAVE_CONTACT_TOOL];
}
```

(`_site` → `site`; fjern kommentaren over om at "Both sites get both feeds".)

**`groups/chat-lbs/CLAUDE.md`** — bytt ut "## Verktøy" / "### lbs_feed"-seksjonen med:
```markdown
## Verktøy
Du har KUN tilgang til Landbrukssalg.no sin database via lbs_feed. Du kan ikke
søke i andre selskapers utstyr — hvis kunden spør om noe utenfor landbruksutstyr,
fortell at vi kun selger landbruksutstyr og henvis dem til andre kanaler om nødvendig.

### lbs_feed
(behold eksisterende lbs_feed-beskrivelse — kommandoer search/get/list/categories — uendret)
```

**`groups/chat-ats/CLAUDE.md`** — speilet endring:
```markdown
## Verktøy
Du har KUN tilgang til ATS Norway sin database via ats_feed. Du kan ikke søke
i andre selskapers utstyr — hvis kunden spør om noe utenfor anleggsmaskiner,
lastebiler eller kjøretøy, fortell at vi kun selger dette og henvis dem til
andre kanaler om nødvendig.

### ats_feed
(behold eksisterende ats_feed-beskrivelse — kommandoer search/get/list — uendret)
```

**Hvorfor også prompt-endring:** Agenten har innebygd ønske om å være hjelpsom. Hvis tool-en bare forsvinner, vil den noen ganger lyve ("Beklager, jeg har ikke tilgang akkurat nå") eller hallusinere svar. Eksplisitt instruksjon → ærlig avvisning + henvisning.

**Eksisterende sesjoner:** Sesjoner er TTL-baserte (ephemeral), ingen migrering nødvendig. Hvis en sesjon i overgangen har historikk hvor den andre tool-en ble brukt, vil Claude bare ikke kalle den igjen.

### 3. Widget-endringer i `widget/chat-widget.js`

**`formatReply` (linje 171-193) krymper drastisk:**
```js
function formatReply(html) {
  // Server returnerer allerede sanitert HTML.
  return html;
}
```

(Funksjonsnavnet beholdes for å minimere diff i `addMessage`.)

**Brukermeldinger uendret** — fortsatt `escapeHtml(text)` for `sender === 'user'`.

**Fjern `white-space: pre-wrap`** fra `.nc-msg-bot`-CSS (linje ~84) — den var nødvendig for manuell `<br>`-håndtering, men HTML fra marked har riktig struktur.

### 4. CSS for markdown-elementer i Shadow DOM

Legges til i `style.textContent`-blokken (rundt linje 60). Alle nye selektorer er prefiksed med `.nc-msg-bot` så de kun gjelder bot-meldinger:

```css
.nc-msg-bot p { margin: 0 0 8px 0; }
.nc-msg-bot p:last-child { margin-bottom: 0; }

.nc-msg-bot h2, .nc-msg-bot h3, .nc-msg-bot h4 {
  margin: 12px 0 4px 0; font-weight: 600;
}
.nc-msg-bot h2 { font-size: 16px; }
.nc-msg-bot h3 { font-size: 15px; }
.nc-msg-bot h4 { font-size: 14px; }
.nc-msg-bot h2:first-child, .nc-msg-bot h3:first-child { margin-top: 0; }

.nc-msg-bot ul, .nc-msg-bot ol { margin: 4px 0 8px 18px; padding: 0; }
.nc-msg-bot li { margin: 2px 0; }

.nc-msg-bot code {
  background: #e5e7eb; padding: 1px 5px; border-radius: 3px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
}
.nc-msg-bot pre {
  background: #1f2937; color: #f3f4f6;
  padding: 10px 12px; border-radius: 6px;
  overflow-x: auto; font-size: 12px; margin: 8px 0;
}
.nc-msg-bot pre code { background: none; color: inherit; padding: 0; }

.nc-msg-bot blockquote {
  border-left: 3px solid #d1d5db;
  padding: 2px 0 2px 12px; margin: 8px 0; color: #4b5563;
}

.nc-msg-bot hr { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0; }

/* Tabell — kritisk for traktor/maskin-lister */
.nc-msg-bot table {
  border-collapse: collapse; font-size: 13px; margin: 8px 0;
  display: block; overflow-x: auto; max-width: 100%; white-space: nowrap;
}
.nc-msg-bot th, .nc-msg-bot td {
  border: 1px solid #d1d5db; padding: 6px 10px; text-align: left;
}
.nc-msg-bot th { background: #e5e7eb; font-weight: 600; }
.nc-msg-bot tr:nth-child(even) td { background: #fafafa; }

.nc-msg-bot del { color: #9ca3af; }

/* Bobel-bredde-fiks for tabeller */
.nc-msg-bot:has(table) { max-width: 95%; }
```

`:has()` støttes i alle moderne nettlesere (Safari 15.4+, Chrome 105+). Fallback for eldre nettlesere er at tabellen scroller horisontalt innenfor 80%-bobla.

## Testing

Eksisterende `src/chat-api.test.ts` utvides:

```ts
describe('getToolsForSite', () => {
  it('returns only LBS tools for lbs site', () => {
    const tools = _getToolsForSite('lbs');
    expect(tools.map((t) => t.name)).toEqual(['lbs_feed', 'save_contact']);
  });
  it('returns only ATS tools for ats site', () => {
    const tools = _getToolsForSite('ats');
    expect(tools.map((t) => t.name)).toEqual(['ats_feed', 'save_contact']);
  });
});

describe('renderMarkdown', () => {
  it('renders GFM table to HTML', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const html = _renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
  });
  it('strips dangerous tags', () => {
    expect(_renderMarkdown('<script>alert(1)</script>'))
      .not.toContain('<script>');
  });
  it('strips javascript: links', () => {
    expect(_renderMarkdown('[click](javascript:alert(1))'))
      .not.toMatch(/href=["']javascript:/);
  });
  it('preserves safe http links with target=_blank', () => {
    const html = _renderMarkdown('[se annonse](https://landbrukssalg.no/123)');
    expect(html).toMatch(/href="https:\/\/landbrukssalg\.no\/123"/);
    expect(html).toContain('target="_blank"');
  });
  it('returns empty string for empty input', () => {
    expect(_renderMarkdown('')).toBe('');
  });
});
```

`renderMarkdown` eksponeres som `_renderMarkdown` i export-blokken (linje 672-684), på linje med eksisterende `_handleChat`, `_loadSystemPrompt` osv.

**Manuell verifisering etter deploy:**
1. `"Har dere John Deere?"` mot `/test/lbs` → tabell rendres som tabell
2. `"Har dere noen Volvo-lastebiler?"` mot chat-lbs → agenten avviser/henviser, kaller ikke ats_feed
3. Bruker skriver `<b>test</b>` → vises bokstavelig (escaping virker)
4. Mobilvisning (panel = 100% bredde) → tabell scroller horisontalt

## Out of scope

- Streaming av tokens (chat-api returnerer hele svaret i én respons — uendret)
- Lagring av rendret HTML i sessions (lagrer MD for renere debug/eksport)
- Endringer i lead-dashboard (eget system)
- Markdown-rendring i Telegram/Gmail-pipeline (egen formatting der allerede)
- Endringer i `direct-agent.ts` — den interne agenten beholder begge feeds

## Risikoer og avveininger

- **Bundle-størrelse på server**: +80 KB (marked + sanitize-html). Akseptabelt — server kjører som langlivet prosess på Hetzner VPS, ikke et lambda-cold-start-problem.
- **Sanitize-html maintenance**: Aktivt vedlikeholdt, populært. Lite risiko.
- **`:has()`-fallback**: Eldre nettlesere får horisontal scroll i 80%-bobla — degraderer pent.
- **Prompt-injeksjon via agent**: Hvis en kunde manipulerer agenten til å emittere f.eks. `<iframe>`, blokkerer sanitize-html det. Hovedforsvar er allow-listet.
