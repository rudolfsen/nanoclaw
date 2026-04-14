# ATS Kundeassistent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an isolated NanoClaw instance for ATS Norway that reads a shared inbox, enriches replies with machine data from the ATS JSON feed, and creates drafts for manual approval.

**Architecture:** Separate NanoClaw instance at `/opt/nanoclaw-ats/` on the existing VPS. Extends the Outlook channel with shared mailbox support (backward-compatible). Adds an ATS feed bash tool for containers. Uses Slack for notifications via the existing `/add-slack` skill.

**Tech Stack:** Node.js, TypeScript, Microsoft Graph API, Docker, systemd, SQLite

**Spec:** `docs/superpowers/specs/2026-04-14-ats-kundeassistent-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/channels/outlook.ts` | Modify | Add shared mailbox support, "from" address on drafts, configurable graph base path |
| `src/channels/outlook.test.ts` | Create | Tests for shared mailbox and draft "from" features |
| `src/ipc.ts` | Modify | Support `from` and `categories` fields in `save_outlook_draft` IPC |
| `container/skills/ats-feed/ats-feed.sh` | Create | Bash tool for querying ATS JSON API |
| `container/skills/ats-feed/SKILL.md` | Create | Documentation for the ATS feed tool |
| `scripts/deploy-instance.sh` | Create | Script to deploy a new NanoClaw instance to VPS |
| `groups/ats-email/CLAUDE.md` | Create | Agent instructions for ATS email handling |

---

### Task 1: Outlook shared mailbox support

Extend `OutlookGraphClient` so it can read from and write to a shared mailbox instead of only `/me`. Backward-compatible — when `OUTLOOK_SHARED_MAILBOX` is not set, behavior is unchanged.

**Files:**
- Modify: `src/channels/outlook.ts:20` (GRAPH_BASE), `src/channels/outlook.ts:87-221` (OutlookGraphClient), `src/channels/outlook.ts:245-280` (constructor env vars)
- Create: `src/channels/outlook.test.ts`

- [ ] **Step 1: Write test for shared mailbox graph base path**

```typescript
// src/channels/outlook.test.ts
import { describe, it, expect } from 'vitest';

describe('getGraphBase', () => {
  it('returns /me when no shared mailbox is set', () => {
    const base = getGraphBase(undefined);
    expect(base).toBe('https://graph.microsoft.com/v1.0/me');
  });

  it('returns /users/{email} when shared mailbox is set', () => {
    const base = getGraphBase('shared@ats.no');
    expect(base).toBe('https://graph.microsoft.com/v1.0/users/shared@ats.no');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: FAIL — `getGraphBase` is not exported

- [ ] **Step 3: Implement getGraphBase and refactor OutlookGraphClient**

In `src/channels/outlook.ts`, replace the hardcoded `GRAPH_BASE` constant with a function, and make `OutlookGraphClient` accept a base URL:

```typescript
// src/channels/outlook.ts — replace line 20
export function getGraphBase(sharedMailbox?: string): string {
  if (sharedMailbox) {
    return `https://graph.microsoft.com/v1.0/users/${sharedMailbox}`;
  }
  return 'https://graph.microsoft.com/v1.0/me';
}
```

Update `OutlookGraphClient` constructor to accept the base URL:

```typescript
export class OutlookGraphClient {
  private accessToken: string;
  private graphBase: string;
  private folderCache = new Map<string, string>();

  constructor(accessToken: string, graphBase?: string) {
    this.accessToken = accessToken;
    this.graphBase = graphBase || getGraphBase();
  }

  private async graphFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<any> {
    const res = await fetch(`${this.graphBase}${path}`, {
      // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: PASS

- [ ] **Step 5: Write test for createDraft with "from" address**

```typescript
describe('OutlookGraphClient.createDraft', () => {
  it('includes from field when fromAddress is provided', () => {
    // Verify the message body includes the from field
    const message = buildDraftMessage(
      'customer@example.com',
      'Re: Excavator inquiry',
      'We have a Volvo EC220E available.',
      undefined,
      'ola@ats.no',
    );
    expect(message.from).toEqual({
      emailAddress: { address: 'ola@ats.no' },
    });
  });

  it('omits from field when fromAddress is not provided', () => {
    const message = buildDraftMessage(
      'customer@example.com',
      'Re: Inquiry',
      'Body text',
    );
    expect(message.from).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: FAIL — `buildDraftMessage` not exported

- [ ] **Step 7: Extract buildDraftMessage and add "from" support to createDraft**

```typescript
// src/channels/outlook.ts — add before createDraft method

export function buildDraftMessage(
  to: string,
  subject: string,
  body: string,
  conversationId?: string,
  fromAddress?: string,
): Record<string, any> {
  const message: Record<string, any> = {
    subject,
    body: { contentType: 'text', content: body },
    toRecipients: [{ emailAddress: { address: to } }],
    isDraft: true,
  };
  if (conversationId) {
    message.conversationId = conversationId;
  }
  if (fromAddress) {
    message.from = { emailAddress: { address: fromAddress } };
  }
  return message;
}
```

Update `createDraft` to use `buildDraftMessage` and accept `fromAddress`:

```typescript
  async createDraft(
    to: string,
    subject: string,
    body: string,
    conversationId?: string,
    fromAddress?: string,
  ): Promise<void> {
    const message = buildDraftMessage(to, subject, body, conversationId, fromAddress);
    await this.graphFetch('/messages', {
      method: 'POST',
      body: JSON.stringify(message),
    });
    logger.info(
      { to, subject: subject.slice(0, 60), from: fromAddress },
      'Outlook draft created via Graph',
    );
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: PASS

- [ ] **Step 9: Add OUTLOOK_SHARED_MAILBOX env var to constructor**

In `OutlookPollingChannel.constructor`, add:

```typescript
    this.sharedMailbox =
      process.env.OUTLOOK_SHARED_MAILBOX || envVars.OUTLOOK_SHARED_MAILBOX || '';
```

Add to `readEnvFile` call: `'OUTLOOK_SHARED_MAILBOX'`

In `pollForMessages`, pass it when creating the client:

```typescript
    const graphBase = getGraphBase(this.sharedMailbox || undefined);
    const client = new OutlookGraphClient(accessToken, graphBase);
```

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add src/channels/outlook.ts src/channels/outlook.test.ts
git commit -m "feat: add shared mailbox and draft from-address support to Outlook channel"
```

---

### Task 2: Extend IPC draft handler with "from" and "categories"

The container agent creates drafts via IPC files. Add support for `from` (sender address) and `categories` (color-coding) fields.

**Files:**
- Modify: `src/ipc.ts:467-521` (save_outlook_draft case)

- [ ] **Step 1: Add from and categories to IPC handler**

In `src/ipc.ts`, update the `save_outlook_draft` case:

```typescript
    case 'save_outlook_draft':
      if (isMain && data.to && data.subject && data.body) {
        try {
          const { getOutlookAccessToken, OutlookGraphClient, getGraphBase } =
            await import('./channels/outlook.js');
          const { readEnvFile } = await import('./env.js');
          const envVars = readEnvFile([
            'OUTLOOK_REFRESH_TOKEN',
            'OUTLOOK_TENANT_ID',
            'OUTLOOK_CLIENT_ID',
            'OUTLOOK_CLIENT_SECRET',
            'OUTLOOK_SHARED_MAILBOX',
          ]);
          const tenantId =
            process.env.OUTLOOK_TENANT_ID || envVars.OUTLOOK_TENANT_ID || '';
          const clientId =
            process.env.OUTLOOK_CLIENT_ID || envVars.OUTLOOK_CLIENT_ID || '';
          const clientSecret =
            process.env.OUTLOOK_CLIENT_SECRET ||
            envVars.OUTLOOK_CLIENT_SECRET ||
            '';
          const refreshToken =
            process.env.OUTLOOK_REFRESH_TOKEN ||
            envVars.OUTLOOK_REFRESH_TOKEN ||
            '';
          const sharedMailbox =
            process.env.OUTLOOK_SHARED_MAILBOX ||
            envVars.OUTLOOK_SHARED_MAILBOX ||
            '';

          const accessToken = await getOutlookAccessToken(
            tenantId,
            clientId,
            clientSecret,
            refreshToken,
          );
          const graphBase = getGraphBase(sharedMailbox || undefined);
          const client = new OutlookGraphClient(accessToken, graphBase);
          await client.createDraft(
            data.to as string,
            data.subject as string,
            data.body as string,
            data.conversationId as string | undefined,
            data.from as string | undefined,
          );

          // Set categories on the original email if provided
          if (data.categories && data.originalMessageId) {
            try {
              await client.setCategories(
                data.originalMessageId as string,
                data.categories as string[],
              );
            } catch (err) {
              logger.warn(
                { err, messageId: data.originalMessageId },
                'Failed to set categories on original email',
              );
            }
          }

          logger.info(
            { sourceGroup, to: data.to, from: data.from },
            'Outlook draft saved via IPC (Graph)',
          );
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Failed to save Outlook draft via IPC',
          );
        }
      } else if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized save_outlook_draft attempt blocked',
        );
      }
      break;
```

- [ ] **Step 2: Build to verify no compile errors**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts
git commit -m "feat: support from-address and categories in Outlook draft IPC"
```

---

### Task 3: ATS feed container tool

Create a bash script that the container agent can use to query the ATS product API. Simple curl wrapper with search/get subcommands.

**Files:**
- Create: `container/skills/ats-feed/ats-feed.sh`
- Create: `container/skills/ats-feed/SKILL.md`

- [ ] **Step 1: Create the bash tool**

```bash
#!/usr/bin/env bash
# container/skills/ats-feed/ats-feed.sh
# Tool for querying the ATS Norway product feed
# Usage:
#   ats-feed list              — List all published ads (first 50)
#   ats-feed get <id>          — Get full details for a specific ad
#   ats-feed search <query>    — Search ads by keyword in descriptions

set -euo pipefail

API_BASE="https://api3.ats.no/api/v3/ad"

case "${1:-help}" in
  list)
    curl -s "$API_BASE?status=published&\$top=${2:-50}" | \
      jq -r '.data[] | select(.status == "published") | {
        id, 
        title: .fts_nb_no[0:80],
        price: .price,
        price_euro: .price_euro,
        year: .year,
        make_id: .make_id,
        category_id: .category_id,
        status: .status
      }'
    ;;

  get)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed get <id>" >&2
      exit 1
    fi
    curl -s "$API_BASE/$2" | jq '{
      id, status, price, price_euro, year,
      make_id, model_id, category_id,
      title_no: .fts_nb_no[0:200],
      title_en: .fts_en_us[0:200],
      title_de: .fts_de_de[0:200],
      specs: .vegvesenjson,
      county_id, zipcode,
      published, changed
    }'
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed search <query>" >&2
      exit 1
    fi
    QUERY="$2"
    curl -s "$API_BASE" | \
      jq --arg q "$QUERY" -r '.data[] | 
        select(.status == "published") |
        select(
          (.fts_nb_no // "" | ascii_downcase | contains($q | ascii_downcase)) or
          (.fts_en_us // "" | ascii_downcase | contains($q | ascii_downcase)) or
          (.fts_de_de // "" | ascii_downcase | contains($q | ascii_downcase))
        ) | {
          id,
          title: .fts_nb_no[0:80],
          price: .price,
          price_euro: .price_euro,
          year: .year,
          make_id: .make_id
        }'
    ;;

  help|*)
    cat <<EOF
ATS Feed Tool — Query ATS Norway product database

Usage:
  ats-feed list [count]      List published ads (default: 50)
  ats-feed get <id>          Get full ad details by ID
  ats-feed search <query>    Search ads by keyword

Examples:
  ats-feed list 10
  ats-feed get 22898
  ats-feed search "volvo"
  ats-feed search "excavator"
EOF
    ;;
esac
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x container/skills/ats-feed/ats-feed.sh`

- [ ] **Step 3: Create the SKILL.md**

```markdown
# ATS Feed Tool

Query the ATS Norway product database for used machinery listings.

## Commands

### List published ads
```bash
ats-feed list        # First 50 published ads
ats-feed list 10     # First 10
```

### Get full details
```bash
ats-feed get 22898   # Full specs, prices, descriptions in NO/EN/DE
```

### Search by keyword
```bash
ats-feed search "volvo"       # Find Volvo machines
ats-feed search "excavator"   # Find excavators
ats-feed search "lastebil"    # Search in Norwegian
```

## Response Fields

- `id` — Ad ID (use with `get` for full details)
- `price` — Price in NOK
- `price_euro` — Price in EUR
- `year` — Manufacturing year
- `make_id` / `model_id` — Manufacturer and model
- `category_id` — Equipment category
- `fts_nb_no` / `fts_en_us` / `fts_de_de` — Descriptions in Norwegian, English, German
- `vegvesenjson` / `specs` — Technical specifications (engine, weight, etc.)

## Usage in Email Responses

When responding to a customer inquiry about machinery:
1. Use `ats-feed search` to find matching products
2. Use `ats-feed get <id>` for full specs on the best matches
3. Include relevant details (price, specs, year) in the draft
4. Link to the ad: `https://ats.no/no/gjenstand/<id>`
```

- [ ] **Step 4: Test the tool locally**

Run: `bash container/skills/ats-feed/ats-feed.sh list 3`
Expected: JSON output with 3 ad summaries

Run: `bash container/skills/ats-feed/ats-feed.sh get 22898`
Expected: Full details for ad 22898

- [ ] **Step 5: Commit**

```bash
git add container/skills/ats-feed/
git commit -m "feat: add ATS feed bash tool for container agents"
```

---

### Task 4: Add Slack channel

Use the existing `/add-slack` skill to generate the Slack channel implementation. This is an interactive skill that creates `src/channels/slack.ts` and wires it up.

**Files:**
- Create: `src/channels/slack.ts` (generated by skill)
- Modify: `src/channels/index.ts` (add Slack import)

- [ ] **Step 1: Invoke the /add-slack skill**

Run: `/add-slack`

Follow the interactive prompts. The skill will:
1. Create `src/channels/slack.ts` using Socket Mode (no public URL needed)
2. Register the channel in `src/channels/index.ts`
3. Add `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to env vars

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/channels/slack.ts src/channels/index.ts
git commit -m "feat: add Slack channel via Socket Mode"
```

---

### Task 5: ATS group configuration

Create the group directory and CLAUDE.md with agent instructions for handling ATS email inquiries.

**Files:**
- Create: `groups/ats-email/CLAUDE.md`

- [ ] **Step 1: Create group directory**

Run: `mkdir -p groups/ats-email/wiki`

- [ ] **Step 2: Create CLAUDE.md with agent instructions**

```markdown
# ATS E-postassistent

Du er en e-postassistent for ATS Norway. Du leser innkommende henvendelser om brukte maskiner og kjøretøy, og lager svarutkast beriket med data fra ATS sin produktdatabase.

## Oppgave

Når du mottar en e-post:

1. **Forstå henvendelsen** — Hva spør kunden om? Maskintype, prisklasse, spesifikasjoner?
2. **Identifiser språket** — Svar alltid i samme språk som henvendelsen
3. **Slå opp i ATS-feeden** — Bruk `ats-feed` til å finne relevante maskiner
4. **Velg ansatt** — Fordel henvendelser jevnt mellom ansatte (se liste under)
5. **Fargekod e-posten** — Sett kategori på original-e-posten
6. **Lag svarutkast** — Opprett utkast med maskindata, lenker og riktig avsender

## Ansatte

| Navn | E-post | Fargekategori | Outlook-farge |
|------|--------|---------------|---------------|
| TBD  | TBD    | TBD           | preset0       |
| TBD  | TBD    | TBD           | preset1       |
| TBD  | TBD    | TBD           | preset2       |
| TBD  | TBD    | TBD           | preset3       |

**Fordeling:** Round-robin. Hold en teller i `/workspace/group/wiki/assignment-counter.txt`. Les tallet, tildel ansatt nr. (tall % antall_ansatte), skriv nytt tall.

## Verktøy

### ATS-feed
```bash
ats-feed search "volvo gravemaskin"   # Søk etter maskiner
ats-feed get 22898                     # Hent detaljer for én maskin
ats-feed list 20                       # List nyeste annonser
```

### Opprett utkast og fargekod
Skriv en IPC-fil til `/workspace/ipc/tasks/`:

```json
{
  "type": "save_outlook_draft",
  "to": "kunde@example.com",
  "subject": "Re: Henvendelse om Volvo-graver",
  "body": "Hei, ...",
  "from": "ola@ats.no",
  "conversationId": "...",
  "originalMessageId": "...",
  "categories": ["Ola - blå"]
}
```

### Slack-varsling
Skriv en IPC-melding for å varsle ansatt i Slack:

```json
{
  "type": "message",
  "chatJid": "slack:C_KANAL_ID",
  "text": "Nytt utkast klart for Ola: Re: Henvendelse om Volvo-graver"
}
```

## Tone og stil

- Profesjonell men vennlig
- Konkret — inkluder alltid pris, år, nøkkelspesifikasjoner
- Inkluder lenke til annonsen: `https://ats.no/no/gjenstand/<id>`
- Avslutt med kontaktinfo for den tildelte ansatte

## Flerspråklig

- Svar alltid i samme språk som henvendelsen
- ATS-feeden har beskrivelser på norsk (fts_nb_no), engelsk (fts_en_us) og tysk (fts_de_de)
- Bruk den språkversjonen som matcher kundens språk

## Eskalering

IKKE lag svarutkast for:
- Juridiske henvendelser (reklamasjon, klager, trusler)
- Henvendelser som krever prisvurdering/forhandling
- Henvendelser du ikke forstår

Send i stedet en Slack-melding: "⚠️ Henvendelse krever manuell håndtering: [emne]"
```

- [ ] **Step 3: Commit**

```bash
git add groups/ats-email/
git commit -m "feat: add ATS email group with agent instructions"
```

---

### Task 6: Instance deploy script

Script that clones the repo, creates `.env`, installs deps, builds, creates systemd service, and starts the new instance on the VPS.

**Files:**
- Create: `scripts/deploy-instance.sh`

- [ ] **Step 1: Create the deploy script**

```bash
#!/usr/bin/env bash
# scripts/deploy-instance.sh
# Deploy a new NanoClaw instance to the VPS
#
# Usage: ./scripts/deploy-instance.sh <instance-name> <vps-host>
# Example: ./scripts/deploy-instance.sh nanoclaw-ats root@204.168.178.32

set -euo pipefail

INSTANCE_NAME="${1:?Usage: deploy-instance.sh <instance-name> <vps-host>}"
VPS_HOST="${2:?Usage: deploy-instance.sh <instance-name> <vps-host>}"
INSTALL_DIR="/opt/${INSTANCE_NAME}"
SERVICE_NAME="${INSTANCE_NAME}"
REPO_URL="$(git remote get-url origin)"

echo "=== Deploying ${INSTANCE_NAME} to ${VPS_HOST}:${INSTALL_DIR} ==="

# Step 1: Clone and build on VPS
ssh "${VPS_HOST}" bash <<REMOTE
set -euo pipefail

# Clone if not exists
if [ ! -d "${INSTALL_DIR}" ]; then
  echo "Cloning repo..."
  git clone "${REPO_URL}" "${INSTALL_DIR}"
else
  echo "Directory exists, pulling latest..."
  cd "${INSTALL_DIR}" && git pull
fi

cd "${INSTALL_DIR}"

# Install deps and build
npm install --production=false
npm run build

# Create data directories
mkdir -p data/sessions data/ipc

# Create .env template if not exists
if [ ! -f .env ]; then
  cat > .env <<'ENV'
# === Required ===
ANTHROPIC_API_KEY=
ASSISTANT_NAME=ATS-Assistent

# === Outlook (Graph API) ===
OUTLOOK_TENANT_ID=
OUTLOOK_CLIENT_ID=
OUTLOOK_CLIENT_SECRET=
OUTLOOK_REFRESH_TOKEN=
OUTLOOK_EMAIL=
OUTLOOK_SHARED_MAILBOX=

# === Slack ===
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=

# === Instance isolation ===
CREDENTIAL_PROXY_PORT=3002
ENV
  echo "Created .env template — fill in credentials before starting"
fi

# Create systemd service
cat > /etc/systemd/system/${SERVICE_NAME}.service <<SERVICE
[Unit]
Description=NanoClaw ${INSTANCE_NAME}
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.js
WorkingDirectory=${INSTALL_DIR}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}

echo ""
echo "=== Deployment complete ==="
echo "Next steps:"
echo "  1. Fill in credentials: ssh ${VPS_HOST} 'nano ${INSTALL_DIR}/.env'"
echo "  2. Build container:     ssh ${VPS_HOST} 'cd ${INSTALL_DIR} && ./container/build.sh'"
echo "  3. Start service:       ssh ${VPS_HOST} 'systemctl start ${SERVICE_NAME}'"
echo "  4. Check status:        ssh ${VPS_HOST} 'systemctl status ${SERVICE_NAME}'"
echo "  5. View logs:           ssh ${VPS_HOST} 'journalctl -u ${SERVICE_NAME} -f'"
REMOTE
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/deploy-instance.sh`

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-instance.sh
git commit -m "feat: add deploy script for new NanoClaw instances"
```

---

### Task 7: Deploy to VPS and test

Deploy the ATS instance to the VPS and verify end-to-end functionality.

**Prerequisites:** Tasks 1-6 completed, ATS customer has provided Slack workspace credentials and Outlook shared mailbox access.

- [ ] **Step 1: Push all changes to main**

```bash
git push origin main
```

- [ ] **Step 2: Run deploy script**

```bash
./scripts/deploy-instance.sh nanoclaw-ats root@204.168.178.32
```

- [ ] **Step 3: Fill in credentials on VPS**

```bash
ssh root@204.168.178.32 'nano /opt/nanoclaw-ats/.env'
```

Fill in:
- `ANTHROPIC_API_KEY` — Magnus's key initially
- `OUTLOOK_*` — Customer's tenant/client/secret/token
- `OUTLOOK_SHARED_MAILBOX` — The shared inbox address
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` — From customer's Slack app
- `CREDENTIAL_PROXY_PORT=3002` — Different from main instance (3001)

- [ ] **Step 4: Build container image (shared)**

```bash
ssh root@204.168.178.32 'cd /opt/nanoclaw-ats && ./container/build.sh'
```

- [ ] **Step 5: Register the ATS email group**

Start the instance and register the group via the main channel. The group needs:
- `folder`: `ats-email`
- `is_main`: `true` (emails deliver to this group)
- `requires_trigger`: `false`

- [ ] **Step 6: Start and verify**

```bash
ssh root@204.168.178.32 'systemctl start nanoclaw-ats'
ssh root@204.168.178.32 'journalctl -u nanoclaw-ats -f'
```

Verify in logs:
- Outlook channel connects and polls shared mailbox
- Slack channel connects via Socket Mode
- No errors

- [ ] **Step 7: End-to-end test**

Send a test email to the shared inbox asking about a used Volvo truck. Verify:
1. Agent picks up the email
2. Agent queries ATS feed
3. Agent creates draft with machine data
4. Agent color-codes the original email
5. Slack notification sent to correct employee

- [ ] **Step 8: Update CLAUDE.md with real employee data**

Replace TBD placeholders in `groups/ats-email/CLAUDE.md` with actual employee names, emails, and color categories from the customer.

```bash
ssh root@204.168.178.32 'nano /opt/nanoclaw-ats/groups/ats-email/CLAUDE.md'
```
