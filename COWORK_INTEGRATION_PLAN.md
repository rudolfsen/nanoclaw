# Cowork Integration — Outlook/allvit.no Bridge

**Goal:** Expose NanoClaw's existing Outlook (Graph API) integration as a small authenticated HTTP surface so Cowork (Claude desktop agent) can search, read, and draft mail for `magnus@allvit.no` without re-implementing OAuth or duplicating credentials.

**Out of scope for this task:**
- Building the Cowork-side skill (separate step, written in `~/productivity/.claude/skills/` after this ships)
- Sending mail programmatically — violates the repo rule "Never send emails on the user's behalf". Drafts only.
- Adding Gmail to the same surface — Cowork already has a native Gmail connector
- Shared-mailbox support (keep it single-user for v1)
- Calendar, Teams, OneDrive — Outlook mail only

---

## Context

`src/channels/outlook.ts` already contains a working `OutlookGraphClient` with token refresh against Microsoft Graph (`Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`, `offline_access`). It exposes:

- `fetchInboxMessages(top)`
- `searchMessages(query, top)`
- `createDraft(opts)`
- `moveMessage`, `setCategories`, `getOrCreateFolder`, `ensureMasterCategories`

Refresh tokens are maintained by `scripts/outlook-auth.ts` and consumed via env (`OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REFRESH_TOKEN`). The polling channel in `OutlookPollingChannel` runs on the Hetzner VPS as part of the main process.

`src/chat-api.ts` is the existing pattern for an authenticated-ish public HTTP surface — plain Node `http.createServer`, started from `src/index.ts` behind a port env var. We mirror that style. No Express, no JWT library (NanoClaw doesn't use one today — secrets go through env/OneCLI).

---

## Design

**Separate file, separate port.** `src/cowork-api.ts` on `COWORK_API_PORT` (default `3004`). Keeps concerns split from the public chat widget on `3003`.

**Auth:** static bearer token (`COWORK_API_TOKEN`, 32+ random bytes). Checked on every request. If unset, the server does not start — log a warning and skip, same pattern as `CHAT_API_PORT`.

**Graph client reuse:** import `OutlookGraphClient` and `getOutlookAccessToken` directly — do not re-implement. The server builds a per-request client from env creds.

**Sanitization:** pass message bodies through `sanitizeEmailForAgent` (from `src/skills/email-sanitizer.ts`) before returning, so tracking pixels, nav chrome, and newsletter boilerplate don't bloat Cowork's context.

**Rate limit:** simple in-memory token bucket keyed by client IP, 60 req/min. Not adversarial defense — just protection against a runaway loop in Cowork.

---

## Tasks

### 1. Config

In `src/config.ts`, add:

```ts
export const COWORK_API_PORT = parseInt(process.env.COWORK_API_PORT || '0', 10);
export const COWORK_API_TOKEN = process.env.COWORK_API_TOKEN;
```

A value of `0` means disabled (match how `CHAT_API_PORT` is gated).

### 2. New server: `src/cowork-api.ts`

Plain Node `http` server, same style as `chat-api.ts`. Sketch:

```ts
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { COWORK_API_PORT, COWORK_API_TOKEN } from './config.js';
import { OutlookGraphClient, getOutlookAccessToken } from './channels/outlook.js';
import { sanitizeEmailForAgent } from './skills/email-sanitizer.js';
import { logger } from './logger.js';

function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  // constant-time compare
  return token.length === COWORK_API_TOKEN!.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(COWORK_API_TOKEN!));
}

async function buildClient(): Promise<OutlookGraphClient> {
  const accessToken = await getOutlookAccessToken(
    process.env.OUTLOOK_TENANT_ID!,
    process.env.OUTLOOK_CLIENT_ID!,
    process.env.OUTLOOK_CLIENT_SECRET!,
    process.env.OUTLOOK_REFRESH_TOKEN!,
  );
  return new OutlookGraphClient(accessToken);
}
```

Then dispatch on `req.method + pathname`:

| Method | Path | Behavior |
|--------|------|----------|
| `GET`  | `/healthz` | Returns `{ok:true}`, no auth |
| `GET`  | `/api/cowork/mail/search?q=...&top=20` | `client.searchMessages(q, top)` — return trimmed envelopes |
| `GET`  | `/api/cowork/mail/message/:id` | Fetch full `/messages/{id}` from Graph, sanitize body, return |
| `GET`  | `/api/cowork/mail/thread/:conversationId` | Fetch `/messages?$filter=conversationId eq '…'&$orderby=receivedDateTime`, sanitize each |
| `POST` | `/api/cowork/mail/draft` | Body `{subject, body, to[], cc?, replyToMessageId?}` → `client.createDraft` |

Envelope shape returned to Cowork (keep small):

```ts
interface MailEnvelope {
  id: string;
  conversationId: string;
  subject: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  receivedAt: string; // ISO
  preview: string;    // Graph bodyPreview, truncated to 300 chars
}
```

Full-message shape adds `bodyText` (sanitized) and `bodyHtml` (raw, optional).

### 3. Startup wiring in `src/index.ts`

After the block that starts the chat API (search for `if (process.env.CHAT_API_PORT)` near line 739), add:

```ts
if (COWORK_API_PORT && COWORK_API_TOKEN) {
  try {
    await startCoworkApiServer();
    logger.info(`Cowork API available on port ${COWORK_API_PORT}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start Cowork API');
  }
} else if (COWORK_API_PORT && !COWORK_API_TOKEN) {
  logger.warn('COWORK_API_PORT set but COWORK_API_TOKEN missing — Cowork API disabled');
}
```

Import `startCoworkApiServer` next to `startChatApiServer`.

### 4. Rate limiting

Reuse `src/sender-allowlist.ts` patterns if there's already a limiter helper, otherwise a local `Map<ip, {count, windowStart}>` is fine. Return `429` with `Retry-After` when tripped.

### 5. Tests — `src/cowork-api.test.ts`

Mirror `outlook.test.ts` structure:

- Mock `OutlookGraphClient` (vitest `vi.mock`)
- `POST /api/cowork/mail/draft` — rejects without Bearer, accepts with valid Bearer, calls `createDraft` with correct args
- `GET /api/cowork/mail/search` — passes query + top through, returns trimmed envelopes
- `GET /api/cowork/mail/message/:id` — calls sanitizer on body
- Rate limit kicks in after N requests
- Constant-time token compare does not early-return on length mismatch

Run with `npx vitest run src/cowork-api.test.ts`.

### 6. OneCLI / env

Add `COWORK_API_TOKEN` to the credentials the `/init-onecli` skill migrates. Generate locally with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

On the VPS, set `COWORK_API_PORT=3004` and the token via OneCLI vault (not plain `.env`).

### 7. Deployment

```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && systemctl restart nanoclaw'
ssh root@204.168.178.32 'journalctl -u nanoclaw --no-pager -n 30 | grep -i cowork'
```

Expected log: `Cowork API available on port 3004`.

**Firewall:** 3004 must NOT be open to the public internet. Two acceptable topologies:

1. Bind to `127.0.0.1` + Caddy/nginx reverse proxy on `mail.numra.no` with TLS
2. Bind to `0.0.0.0` behind the existing reverse proxy if one is already terminating TLS for the VPS

Pick whatever matches how `chat-api.ts` is currently exposed (check the Caddyfile / nginx config during implementation).

### 8. Smoke test

From a laptop with the token:

```bash
curl -sS https://mail.numra.no/healthz
curl -sS -H "Authorization: Bearer $COWORK_API_TOKEN" \
  "https://mail.numra.no/api/cowork/mail/search?q=from:skogvold&top=3" | jq .
```

Expect 3 envelopes from Anders Skogvold.

---

## Cowork-side follow-up (out of this repo)

After merge, create a skill at `~/productivity/.claude/skills/allvit-mail/SKILL.md` that:

1. Reads `COWORK_API_TOKEN` and `COWORK_API_BASE` from `~/productivity/.env` (or a secrets file outside the repo)
2. Documents four commands for Claude: `search`, `read-message`, `read-thread`, `draft`
3. Wraps each with a one-line `curl` via Bash tool, returning JSON

That skill is ~30 lines of markdown + examples. Write once the endpoint is live and smoke-tested.

---

## Acceptance checklist

- [ ] `npm run build` clean
- [ ] `npx vitest run src/cowork-api.test.ts` passes
- [ ] `COWORK_API_PORT` unset → server does not start, no warnings
- [ ] `COWORK_API_PORT` set, `COWORK_API_TOKEN` unset → warn and skip, do not crash
- [ ] Wrong Bearer → `401`, no timing leak (constant-time compare)
- [ ] Rate limit returns `429` with `Retry-After`
- [ ] Draft endpoint never calls `sendMail` — confirm by grep in the new file
- [ ] Deployed to Hetzner, smoke test from laptop succeeds
- [ ] `CLAUDE.md` updated with the new port/env vars in the Deployment section

---

## Notes for the implementing agent

- Follow `CONTRIBUTING.md` before opening the PR
- Use `src/logger.ts` (pino) for logs, not `console.*`
- No new top-level dependencies — Node `http` + `crypto` are enough
- Keep the file under ~400 LOC; if it's growing, split handlers into `src/cowork/*` instead
- The rule "Never send emails on the user's behalf" is load-bearing — the only Graph endpoint hit for writes is `/me/messages` (creates draft), never `/me/sendMail`
