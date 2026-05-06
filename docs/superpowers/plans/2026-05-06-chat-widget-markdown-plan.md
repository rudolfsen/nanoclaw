# Chat Widget Markdown + Per-Site Tool Restriction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side render markdown (incl. GFM tables) into HTML in `chat-api.ts` so the chat widget on lbs.no/ats.no displays rich responses, and restrict tool access per site so each customer agent only sees its own product feed.

**Architecture:** Server-side rendering with `marked` + `sanitize-html` allow-list inside `chat-api.ts`. The widget's `formatReply` becomes a passthrough since HTML is pre-sanitized. CSS for markdown elements lives in the Shadow DOM. Per-site restriction is a one-line fix in `getToolsForSite` plus prompt updates in both group `CLAUDE.md` files so the agent doesn't promise tools it lacks.

**Tech Stack:** TypeScript, Node.js, Vitest, marked, sanitize-html

**Spec:** `docs/superpowers/specs/2026-05-06-chat-widget-markdown-design.md`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add `marked`, `sanitize-html`, `@types/sanitize-html` |
| `src/chat-api.ts` | Modify | Add `renderMarkdown` helper; fix `getToolsForSite`; integrate render into `handleChat` returns; export `_renderMarkdown` |
| `src/chat-api.test.ts` | Modify | Replace existing per-site tool assertions; add `renderMarkdown` tests |
| `groups/chat-lbs/CLAUDE.md` | Modify | Add explicit "only lbs_feed" instruction in tools section |
| `groups/chat-ats/CLAUDE.md` | Modify | Add explicit "only ats_feed" instruction in tools section |
| `widget/chat-widget.js` | Modify | Simplify `formatReply` to passthrough; remove `white-space: pre-wrap`; add CSS for markdown elements |

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json` (deps section)
- Modify: `package-lock.json` (auto-generated)

- [ ] **Step 1: Install marked and sanitize-html**

Run:
```bash
npm install marked sanitize-html
npm install -D @types/sanitize-html
```

Expected: Both packages added to `dependencies`, types to `devDependencies`. `marked` ships its own types.

- [ ] **Step 2: Verify versions are recent**

Run:
```bash
npm list marked sanitize-html @types/sanitize-html
```

Expected: marked `^16.0.0` or newer, sanitize-html `^2.x` or newer.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add marked and sanitize-html for chat-widget markdown rendering"
```

---

## Task 2: Update existing getToolsForSite tests for new per-site behavior

**Files:**
- Modify: `src/chat-api.test.ts:64-80`

- [ ] **Step 1: Replace the existing `describe('getToolsForSite', ...)` block**

In `src/chat-api.test.ts`, find lines 64-80 (the current `describe('getToolsForSite', ...)` block) and replace with:

```ts
  describe('getToolsForSite', () => {
    it('returns only LBS tools (lbs_feed + save_contact) for lbs site', () => {
      const tools = getToolsForSite('lbs');
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['lbs_feed', 'save_contact']);
    });

    it('returns only ATS tools (ats_feed + save_contact) for ats site', () => {
      const tools = getToolsForSite('ats');
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['ats_feed', 'save_contact']);
    });

    it('does not leak the other site\'s feed', () => {
      const lbsNames = getToolsForSite('lbs').map((t) => t.name);
      const atsNames = getToolsForSite('ats').map((t) => t.name);
      expect(lbsNames).not.toContain('ats_feed');
      expect(atsNames).not.toContain('lbs_feed');
    });
  });
```

- [ ] **Step 2: Run the updated tests to verify they FAIL**

Run:
```bash
npx vitest run src/chat-api.test.ts -t "getToolsForSite"
```

Expected: 3 failing tests (current implementation returns both feeds). Failure messages will look like `Expected ['lbs_feed', 'save_contact'] but got ['ats_feed', 'lbs_feed', 'save_contact']`.

---

## Task 3: Implement per-site getToolsForSite

**Files:**
- Modify: `src/chat-api.ts:303-306`

- [ ] **Step 1: Replace the function body**

In `src/chat-api.ts`, find lines 303-306:

```ts
function getToolsForSite(_site: SiteId): Anthropic.Tool[] {
  // Both sites get both feeds so they can help with any equipment type
  return [ATS_TOOL, LBS_TOOL, SAVE_CONTACT_TOOL];
}
```

Replace with:

```ts
function getToolsForSite(site: SiteId): Anthropic.Tool[] {
  const feedTool = site === 'ats' ? ATS_TOOL : LBS_TOOL;
  return [feedTool, SAVE_CONTACT_TOOL];
}
```

- [ ] **Step 2: Run tests to verify they PASS**

Run:
```bash
npx vitest run src/chat-api.test.ts -t "getToolsForSite"
```

Expected: 3 passing tests.

- [ ] **Step 3: Run full test file to confirm no regression**

Run:
```bash
npx vitest run src/chat-api.test.ts
```

Expected: All previously passing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/chat-api.ts src/chat-api.test.ts
git commit -m "feat(chat-api): restrict tools per site (lbs gets only lbs_feed, ats gets only ats_feed)"
```

---

## Task 4: Add renderMarkdown tests

**Files:**
- Modify: `src/chat-api.test.ts` (add new `describe` block and import)

- [ ] **Step 1: Add `_renderMarkdown` to the imports**

In `src/chat-api.test.ts`, find the import block at lines 46-55. Add `_renderMarkdown as renderMarkdown,` to the import list:

```ts
import {
  _sessions as sessions,
  _rateLimits as rateLimits,
  _handleChat as handleChat,
  _isRateLimited as isRateLimited,
  _getCorsOrigin as getCorsOrigin,
  _loadSystemPrompt as loadSystemPrompt,
  _getToolsForSite as getToolsForSite,
  _renderMarkdown as renderMarkdown,
  MAX_MESSAGES_PER_SESSION,
} from './chat-api.js';
```

- [ ] **Step 2: Add a new describe block before the closing `});` of the outer `describe('Chat API', ...)`**

In `src/chat-api.test.ts`, just before the final `});` (around line 305), add:

```ts
  describe('renderMarkdown', () => {
    it('returns empty string for empty input', () => {
      expect(renderMarkdown('')).toBe('');
    });

    it('wraps plain text in <p>', () => {
      expect(renderMarkdown('Bare en setning.')).toContain('<p>Bare en setning.');
    });

    it('renders bold and italic', () => {
      const html = renderMarkdown('**bold** and *italic*');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    it('renders GFM tables to HTML', () => {
      const md = '| Modell | Pris |\n|---|---|\n| 1030 | 49 000 kr |';
      const html = renderMarkdown(md);
      expect(html).toContain('<table>');
      expect(html).toContain('<th>Modell</th>');
      expect(html).toContain('<td>49 000 kr</td>');
    });

    it('renders unordered lists', () => {
      const html = renderMarkdown('- one\n- two');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>one</li>');
    });

    it('renders headings (h2-h4) but not h1', () => {
      const html = renderMarkdown('# top\n## sub\n### subsub');
      expect(html).not.toContain('<h1>');
      expect(html).toContain('<h2>sub</h2>');
      expect(html).toContain('<h3>subsub</h3>');
    });

    it('strips <script> tags', () => {
      const html = renderMarkdown('Hello <script>alert(1)</script> world');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert(1)');
    });

    it('strips javascript: links', () => {
      const html = renderMarkdown('[click](javascript:alert(1))');
      expect(html).not.toMatch(/href=["']javascript:/i);
    });

    it('preserves https links and adds target=_blank rel=noopener', () => {
      const html = renderMarkdown('[se annonse](https://landbrukssalg.no/123)');
      expect(html).toMatch(/href="https:\/\/landbrukssalg\.no\/123"/);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it('strips inline event handlers', () => {
      const html = renderMarkdown('<a href="x" onclick="alert(1)">x</a>');
      expect(html).not.toContain('onclick');
    });

    it('renders inline code', () => {
      const html = renderMarkdown('Try `npm test`');
      expect(html).toContain('<code>npm test</code>');
    });
  });
```

- [ ] **Step 3: Run tests to verify they FAIL**

Run:
```bash
npx vitest run src/chat-api.test.ts -t "renderMarkdown"
```

Expected: All 11 tests fail because `_renderMarkdown` is not exported yet — actual error will be at import time: `SyntaxError: The requested module './chat-api.js' does not provide an export named '_renderMarkdown'`.

---

## Task 5: Implement renderMarkdown helper

**Files:**
- Modify: `src/chat-api.ts` (add imports, add function, add to exports)

- [ ] **Step 1: Add imports near the top of `chat-api.ts` (after line 8 where `Anthropic` is imported)**

Add these two imports:

```ts
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
```

- [ ] **Step 2: Configure marked once at module load**

After the imports block (before the first non-import statement, e.g. before `// --- Chat contacts DB ---` on line 17), add:

```ts
// Markdown rendering — server-side, sanitized.
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
    a: sanitizeHtml.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer',
    }),
  },
};

function renderMarkdown(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { async: false }) as string;
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
```

- [ ] **Step 3: Add `renderMarkdown as _renderMarkdown` to the export block (lines 672-684)**

Find the export block at the bottom of `chat-api.ts`:

```ts
export {
  sessions as _sessions,
  rateLimits as _rateLimits,
  handleChat as _handleChat,
  isRateLimited as _isRateLimited,
  getCorsOrigin as _getCorsOrigin,
  loadSystemPrompt as _loadSystemPrompt,
  getToolsForSite as _getToolsForSite,
  executeChatTool as _executeChatTool,
  SESSION_TTL_MS,
  MAX_MESSAGES_PER_SESSION,
};
```

Add `renderMarkdown as _renderMarkdown,` after `getToolsForSite as _getToolsForSite,`:

```ts
export {
  sessions as _sessions,
  rateLimits as _rateLimits,
  handleChat as _handleChat,
  isRateLimited as _isRateLimited,
  getCorsOrigin as _getCorsOrigin,
  loadSystemPrompt as _loadSystemPrompt,
  getToolsForSite as _getToolsForSite,
  renderMarkdown as _renderMarkdown,
  executeChatTool as _executeChatTool,
  SESSION_TTL_MS,
  MAX_MESSAGES_PER_SESSION,
};
```

- [ ] **Step 4: Run renderMarkdown tests to verify they PASS**

Run:
```bash
npx vitest run src/chat-api.test.ts -t "renderMarkdown"
```

Expected: All 11 renderMarkdown tests pass.

- [ ] **Step 5: Run typecheck**

Run:
```bash
npm run typecheck
```

Expected: No TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/chat-api.ts src/chat-api.test.ts
git commit -m "feat(chat-api): add server-side markdown rendering with sanitize-html allowlist"
```

---

## Task 6: Wire renderMarkdown into handleChat returns

**Files:**
- Modify: `src/chat-api.ts` (3 return sites in `handleChat`)

- [ ] **Step 1: Apply `renderMarkdown` at the end_turn return (around line 454-462)**

Find:

```ts
      // End turn — return final text
      if (response.stop_reason === 'end_turn') {
        const reply = textParts.join('\n').trim();
        // Save assistant response in session history
        session.messages.push({ role: 'assistant', content: reply || '...' });
        return {
          status: 200,
          data: { reply: reply || '...', sessionId: session.id },
        };
      }
```

Replace with:

```ts
      // End turn — return final text
      if (response.stop_reason === 'end_turn') {
        const reply = textParts.join('\n').trim();
        // Save raw markdown in session history (HTML is rendered only for the response)
        session.messages.push({ role: 'assistant', content: reply || '...' });
        return {
          status: 200,
          data: {
            reply: renderMarkdown(reply || '...'),
            sessionId: session.id,
          },
        };
      }
```

- [ ] **Step 2: Apply `renderMarkdown` at the unexpected stop_reason return (around line 496-504)**

Find:

```ts
      } else {
        // Unexpected stop reason
        const reply = textParts.join('\n').trim();
        session.messages.push({ role: 'assistant', content: reply || '...' });
        return {
          status: 200,
          data: { reply: reply || '...', sessionId: session.id },
        };
      }
```

Replace with:

```ts
      } else {
        // Unexpected stop reason
        const reply = textParts.join('\n').trim();
        session.messages.push({ role: 'assistant', content: reply || '...' });
        return {
          status: 200,
          data: {
            reply: renderMarkdown(reply || '...'),
            sessionId: session.id,
          },
        };
      }
```

- [ ] **Step 3: Apply `renderMarkdown` at the max-turns fallback (around line 507-514)**

Find:

```ts
    // Max turns — return whatever we have
    return {
      status: 200,
      data: {
        reply: 'Beklager, jeg trenger litt mer tid. Proov igjen.',
        sessionId: session.id,
      },
    };
```

Replace with:

```ts
    // Max turns — return whatever we have
    return {
      status: 200,
      data: {
        reply: renderMarkdown('Beklager, jeg trenger litt mer tid. Prøv igjen.'),
        sessionId: session.id,
      },
    };
```

(Note: also fixes a pre-existing typo "Proov" → "Prøv".)

- [ ] **Step 4: Update the existing `handleChat` test that asserts on raw text**

In `src/chat-api.test.ts` find the test "creates session and returns reply on success" (around line 154-172). Change:

```ts
      expect(data.reply).toBe('Vi har mange maskiner!');
```

to:

```ts
      expect(data.reply).toContain('Vi har mange maskiner!');
      expect(data.reply).toMatch(/^<p>/);
```

Find the test "reuses existing session" (around line 174-208). Change:

```ts
      expect(secondData.reply).toBe('Second reply');
```

to:

```ts
      expect(secondData.reply).toContain('Second reply');
```

Find the test "handles tool use loop" (around line 243-276). Change:

```ts
      expect((result.data as { reply: string }).reply).toBe(
        'Vi har en Volvo EC220E.',
      );
```

to:

```ts
      expect((result.data as { reply: string }).reply).toContain(
        'Vi har en Volvo EC220E.',
      );
```

- [ ] **Step 5: Run all chat-api tests**

Run:
```bash
npx vitest run src/chat-api.test.ts
```

Expected: All tests pass (including the renderMarkdown integration via the updated handleChat tests).

- [ ] **Step 6: Run full test suite to check for regressions**

Run:
```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/chat-api.ts src/chat-api.test.ts
git commit -m "feat(chat-api): render markdown to HTML before returning chat replies"
```

---

## Task 7: Update chat-lbs CLAUDE.md with tool restriction

**Files:**
- Modify: `groups/chat-lbs/CLAUDE.md`

- [ ] **Step 1: Read the current file to confirm structure**

Run:
```bash
cat groups/chat-lbs/CLAUDE.md
```

Expected: 29 lines, has "## Verktøy" section starting around line 17.

- [ ] **Step 2: Replace the "## Verktøy" header section**

In `groups/chat-lbs/CLAUDE.md`, find:

```markdown
## Verktøy

### lbs_feed
```

Replace with:

```markdown
## Verktøy

Du har KUN tilgang til Landbrukssalg.no sin database via lbs_feed. Du kan ikke søke i andre selskapers utstyr — hvis kunden spør om noe utenfor landbruksutstyr, fortell at vi kun selger landbruksutstyr og henvis dem til andre kanaler om nødvendig.

### lbs_feed
```

(The `### lbs_feed` heading and everything below it stays unchanged.)

- [ ] **Step 3: Verify the file looks right**

Run:
```bash
cat groups/chat-lbs/CLAUDE.md
```

Expected: New "Du har KUN tilgang..." paragraph appears between "## Verktøy" and "### lbs_feed". Original `lbs_feed` command list intact.

- [ ] **Step 4: Commit**

```bash
git add groups/chat-lbs/CLAUDE.md
git commit -m "feat(chat-lbs): instruct agent to only use lbs_feed (no cross-site search)"
```

---

## Task 8: Update chat-ats CLAUDE.md with tool restriction

**Files:**
- Modify: `groups/chat-ats/CLAUDE.md`

- [ ] **Step 1: Read the current file to confirm structure**

Run:
```bash
cat groups/chat-ats/CLAUDE.md
```

Expected: 28 lines, has "## Verktøy" section starting around line 17.

- [ ] **Step 2: Replace the "## Verktøy" header section**

In `groups/chat-ats/CLAUDE.md`, find:

```markdown
## Verktøy

### ats_feed
```

Replace with:

```markdown
## Verktøy

Du har KUN tilgang til ATS Norway sin database via ats_feed. Du kan ikke søke i andre selskapers utstyr — hvis kunden spør om noe utenfor anleggsmaskiner, lastebiler eller kjøretøy, fortell at vi kun selger dette og henvis dem til andre kanaler om nødvendig.

### ats_feed
```

(The `### ats_feed` heading and everything below it stays unchanged.)

- [ ] **Step 3: Verify the file looks right**

Run:
```bash
cat groups/chat-ats/CLAUDE.md
```

Expected: New "Du har KUN tilgang..." paragraph appears between "## Verktøy" and "### ats_feed". Original `ats_feed` command list intact.

- [ ] **Step 4: Commit**

```bash
git add groups/chat-ats/CLAUDE.md
git commit -m "feat(chat-ats): instruct agent to only use ats_feed (no cross-site search)"
```

---

## Task 9: Simplify formatReply in widget

**Files:**
- Modify: `widget/chat-widget.js:171-193`

- [ ] **Step 1: Replace the `formatReply` function**

In `widget/chat-widget.js`, find lines 171-193 (the entire `formatReply` function):

```js
  function formatReply(text) {
    var escaped = escapeHtml(text);
    // Bold: **text** or __text__
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // Italic: *text* or _text_ (but not inside URLs)
    escaped = escaped.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<em>$1</em>');
    // Links: make URLs clickable
    escaped = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    // Bullet lists: lines starting with - or •
    escaped = escaped.replace(/^[\-•]\s+(.+)$/gm, '<li>$1</li>');
    escaped = escaped.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // Numbered lists: lines starting with 1. 2. etc
    escaped = escaped.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    // Line breaks
    escaped = escaped.replace(/\n/g, '<br>');
    // Clean up <br> inside <ul>
    escaped = escaped.replace(/<br><ul>/g, '<ul>');
    escaped = escaped.replace(/<\/ul><br>/g, '</ul>');
    escaped = escaped.replace(/<br><li>/g, '<li>');
    escaped = escaped.replace(/<\/li><br>/g, '</li>');
    return escaped;
  }
```

Replace with:

```js
  function formatReply(html) {
    // Server returns pre-sanitized HTML (sanitize-html allow-list).
    return html;
  }
```

- [ ] **Step 2: Verify file syntax is still valid**

Run:
```bash
node -c widget/chat-widget.js
```

Expected: No output (syntax OK). If it errors, the IIFE wrapping may need a check.

(If `node -c` is unavailable, use: `node --check widget/chat-widget.js`)

- [ ] **Step 3: Commit**

```bash
git add widget/chat-widget.js
git commit -m "feat(widget): simplify formatReply to passthrough (HTML is server-sanitized)"
```

---

## Task 10: Add markdown CSS to widget Shadow DOM

**Files:**
- Modify: `widget/chat-widget.js` (CSS in `style.textContent`, around lines 60-111)

- [ ] **Step 1: Remove `white-space: pre-wrap` from `.nc-msg-bot`**

In `widget/chat-widget.js`, find the line in the CSS string (around line 85):

```js
    + '.nc-msg-bot { align-self: flex-start; background: #f3f4f6; color: #1f2937; border-bottom-left-radius: 4px; }'
```

(The `white-space: pre-wrap` is actually on `.nc-msg`, line 84. Locate:)

```js
    + '.nc-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; word-wrap: break-word; white-space: pre-wrap; font-size: 14px; line-height: 1.5; }'
```

Remove `white-space: pre-wrap; ` from the `.nc-msg` rule:

```js
    + '.nc-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; word-wrap: break-word; font-size: 14px; line-height: 1.5; }'
```

- [ ] **Step 2: Insert markdown-element CSS just after the `.nc-msg a` line (around line 87)**

Find:

```js
    + '.nc-msg a { color: inherit; text-decoration: underline; }'
```

After this line and before the typing-indicator CSS (`.nc-typing`), insert:

```js

    // Markdown elements (bot messages — content rendered server-side)
    + '.nc-msg-bot p { margin: 0 0 8px 0; }'
    + '.nc-msg-bot p:last-child { margin-bottom: 0; }'
    + '.nc-msg-bot h2, .nc-msg-bot h3, .nc-msg-bot h4 { margin: 12px 0 4px 0; font-weight: 600; }'
    + '.nc-msg-bot h2 { font-size: 16px; }'
    + '.nc-msg-bot h3 { font-size: 15px; }'
    + '.nc-msg-bot h4 { font-size: 14px; }'
    + '.nc-msg-bot h2:first-child, .nc-msg-bot h3:first-child, .nc-msg-bot h4:first-child { margin-top: 0; }'
    + '.nc-msg-bot ul, .nc-msg-bot ol { margin: 4px 0 8px 18px; padding: 0; }'
    + '.nc-msg-bot li { margin: 2px 0; }'
    + '.nc-msg-bot code { background: #e5e7eb; padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em; }'
    + '.nc-msg-bot pre { background: #1f2937; color: #f3f4f6; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 8px 0; }'
    + '.nc-msg-bot pre code { background: none; color: inherit; padding: 0; }'
    + '.nc-msg-bot blockquote { border-left: 3px solid #d1d5db; padding: 2px 0 2px 12px; margin: 8px 0; color: #4b5563; }'
    + '.nc-msg-bot hr { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0; }'
    + '.nc-msg-bot table { border-collapse: collapse; font-size: 13px; margin: 8px 0; display: block; overflow-x: auto; max-width: 100%; white-space: nowrap; }'
    + '.nc-msg-bot th, .nc-msg-bot td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }'
    + '.nc-msg-bot th { background: #e5e7eb; font-weight: 600; }'
    + '.nc-msg-bot tr:nth-child(even) td { background: #fafafa; }'
    + '.nc-msg-bot del { color: #9ca3af; }'
    + '.nc-msg-bot:has(table) { max-width: 95%; }'

```

- [ ] **Step 3: Verify the JS file still parses**

Run:
```bash
node -c widget/chat-widget.js
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add widget/chat-widget.js
git commit -m "feat(widget): add CSS for markdown elements (tables, headings, code, lists, blockquotes)"
```

---

## Task 11: Local smoke test (dev server)

**Files:** None modified — verification only.

- [ ] **Step 1: Build the project**

Run:
```bash
npm run build
```

Expected: TypeScript compiles to `dist/`. No errors.

- [ ] **Step 2: Start the dev server in the background**

Run:
```bash
npm run dev > /tmp/nanoclaw-dev.log 2>&1 &
echo $! > /tmp/nanoclaw-dev.pid
sleep 3
```

Expected: Server starts. Check log: `cat /tmp/nanoclaw-dev.log` should show port 3003 listening.

- [ ] **Step 3: Hit the health endpoint**

Run:
```bash
curl -sS http://localhost:3003/api/health
```

Expected: `{"ok":true,"sessions":0}` (or similar with a session count).

- [ ] **Step 4: Send a query that should produce a table (lbs)**

Run:
```bash
curl -sS -X POST http://localhost:3003/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"List 3 John Deere-traktorer i tabell","sessionId":"smoke_'"$(date +%s)"'","site":"lbs"}' \
  | python3 -c "import sys, json; d=json.load(sys.stdin); print(d['reply'][:500])"
```

Expected: Response contains `<table>`, `<th>`, `<td>` tags — not raw `|` characters. May take 10-20 seconds.

- [ ] **Step 5: Send a query that should be refused (lbs asked about ATS-only equipment)**

Run:
```bash
curl -sS -X POST http://localhost:3003/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Har dere noen Volvo-lastebiler eller Caterpillar gravemaskiner?","sessionId":"smoke2_'"$(date +%s)"'","site":"lbs"}' \
  | python3 -c "import sys, json; d=json.load(sys.stdin); print(d['reply'][:500])"
```

Expected: Agent declines or redirects, does NOT call ats_feed. Response should mention landbruksutstyr or refer the customer elsewhere.

- [ ] **Step 6: Stop the dev server**

Run:
```bash
kill $(cat /tmp/nanoclaw-dev.pid)
rm /tmp/nanoclaw-dev.pid
```

- [ ] **Step 7: Open the test page in a browser to verify rendering**

Tell the user to open `http://localhost:3003/test/lbs` (after restarting `npm run dev`) and ask the chat: "Har dere John Deere-traktorer?". Verify in the browser:
- Tables render as visual tables (not raw pipes)
- Bullet lists render as bullets
- Bold/italic render correctly
- Mobile view (resize to <500px) — table scrolls horizontally inside the chat bubble
- Plain user input like `<b>test</b>` shows as escaped text, not formatted

If everything looks right, mark this task complete. If something looks wrong, debug before proceeding to deploy.

---

## Task 12: Deploy to Hetzner

**Files:** None modified.

- [ ] **Step 1: Check that all changes are committed and pushed**

Run:
```bash
git status
git log --oneline -10
```

Expected: Clean working tree. Last 8-10 commits should reflect this plan's work.

- [ ] **Step 2: Push to main (only if user confirms)**

This is a deploy step — pause here and confirm with the user before running:

```bash
git push origin main
```

- [ ] **Step 3: Deploy on Hetzner**

Run:
```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm install && npm run build && systemctl restart nanoclaw'
```

Expected: Pull succeeds, npm install adds marked + sanitize-html, build succeeds, systemd restarts the service.

- [ ] **Step 4: Verify production health**

Run:
```bash
curl -sS http://204.168.178.32:3003/api/health
```

Expected: `{"ok":true,"sessions":0}` (sessions may be >0 if other clients are active).

- [ ] **Step 5: Smoke-test production**

Run:
```bash
curl -sS -X POST http://204.168.178.32:3003/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"List 3 John Deere-traktorer i tabell","sessionId":"prod_smoke_'"$(date +%s)"'","site":"lbs"}' \
  | python3 -c "import sys, json; d=json.load(sys.stdin); print(d['reply'][:300])"
```

Expected: Response contains `<table>` HTML.

- [ ] **Step 6: Open `http://204.168.178.32:3003/test/lbs` in a browser**

Tell the user to open the test page in their browser and verify the widget renders the markdown response correctly. This is the final visual confirmation.

---

## Self-Review Notes (writing-plans)

**Spec coverage:**
- ✅ Markdown pipeline (renderMarkdown + integration) — Tasks 4, 5, 6
- ✅ Per-site tool restriction — Tasks 2, 3
- ✅ Group prompt updates — Tasks 7, 8
- ✅ Widget formatReply simplification — Task 9
- ✅ Markdown CSS in Shadow DOM — Task 10
- ✅ Tests (getToolsForSite + renderMarkdown + handleChat regression) — Tasks 2, 4, 6
- ✅ Manual verification — Tasks 11, 12

**Out of scope** (per spec): streaming, lead-dashboard, direct-agent.ts, session HTML storage. Plan honors this.

**Type consistency:** `renderMarkdown(text: string): string` used identically in all task references. `_renderMarkdown` export name stable across Tasks 4, 5.
