# ATS Kundeassistent v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run ATS customer assistant in a dedicated Docker container with in-process Claude Agent SDK (no sub-containers), complete email delivery (no personal classification), and full isolation from the personal instance.

**Architecture:** Add `EMAIL_CLASSIFICATION_ENABLED` flag to bypass the personal email pipeline. Add `AGENT_MODE=direct` to run Claude Agent SDK in-process instead of spawning Docker containers. Package as a customer Dockerfile with docker-compose for deployment.

**Tech Stack:** Node.js, TypeScript, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Docker, docker-compose

**Spec:** `docs/superpowers/specs/2026-04-14-ats-kundeassistent-design-v2.md`

**Builds on:** Branch `feat/ats-kundeassistent` — shared mailbox support, DraftOptions, ATS feed tool, configurable Gmail credentials dir already implemented.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/channels/outlook.ts` | Modify | Add `EMAIL_CLASSIFICATION_ENABLED` bypass in `pollForMessages()` |
| `src/channels/gmail.ts` | Modify | Same classification bypass |
| `src/channels/outlook.test.ts` | Modify | Add test for classification bypass |
| `src/direct-agent.ts` | Create | In-process Claude Agent SDK runner (alternative to container-runner) |
| `src/direct-agent.test.ts` | Create | Tests for direct agent module |
| `src/index.ts` | Modify | Route to direct agent when `AGENT_MODE=direct` |
| `src/config.ts` | Modify | Add `AGENT_MODE` and `EMAIL_CLASSIFICATION_ENABLED` config |
| `customer/Dockerfile` | Create | Customer container image |
| `customer/docker-compose.yml` | Create | Docker-compose template for customer deployment |
| `customer/README.md` | Create | Deployment instructions |

---

### Task 1: Email classification feature flag

Add `EMAIL_CLASSIFICATION_ENABLED` env var. When `false`, skip the entire classify/sort/filter pipeline in Outlook and Gmail channels. All emails delivered directly to agent.

**Files:**
- Modify: `src/config.ts`
- Modify: `src/channels/outlook.ts:360-520` (pollForMessages)
- Modify: `src/channels/gmail.ts` (equivalent pipeline)
- Modify: `src/channels/outlook.test.ts`

- [ ] **Step 1: Add config constant**

In `src/config.ts`, add after line 16 (`SCHEDULER_POLL_INTERVAL`):

```typescript
export const EMAIL_CLASSIFICATION_ENABLED =
  (process.env.EMAIL_CLASSIFICATION_ENABLED ?? 'true') !== 'false';
```

- [ ] **Step 2: Write test for classification bypass**

Add to `src/channels/outlook.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('EMAIL_CLASSIFICATION_ENABLED', () => {
  it('is true by default', async () => {
    const config = await import('../config.js');
    expect(config.EMAIL_CLASSIFICATION_ENABLED).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: PASS

- [ ] **Step 4: Add bypass to Outlook pollForMessages**

In `src/channels/outlook.ts`, add import at top:

```typescript
import { EMAIL_CLASSIFICATION_ENABLED } from '../config.js';
```

In `pollForMessages()`, after `markOutlookProcessed(msg.id)` and the from/body extraction (around line 390), add a bypass block before the classification pipeline:

```typescript
        const fromAddress = msg.from?.emailAddress?.address || '';
        const fromName = msg.from?.emailAddress?.name || fromAddress;
        const bodyText =
          msg.body?.contentType === 'html'
            ? stripHtml(msg.body.content)
            : msg.body?.content || '';

        // When classification is disabled, deliver all emails directly
        if (!EMAIL_CLASSIFICATION_ENABLED) {
          const jid = `outlook:${msg.id}`;
          const timestamp = msg.receivedDateTime || new Date().toISOString();
          const sanitizedContent = sanitizeEmailForAgent({
            from: `${fromName} <${fromAddress}>`,
            subject: msg.subject,
            body: bodyText,
          });

          this.opts.onChatMetadata(jid, timestamp, msg.subject, 'outlook', false);
          this.opts.onMessage(mainJid, {
            id: msg.id,
            chat_jid: mainJid,
            sender: fromAddress,
            sender_name: fromName,
            content: sanitizedContent,
            timestamp,
            is_from_me: false,
          });
          recordEmailDelivery(msg.id, 'outlook', fromAddress);
          logger.info(
            { from: fromName, subject: msg.subject.slice(0, 60) },
            'Outlook email delivered (classification disabled)',
          );
          continue;
        }

        // EXISTING CLASSIFICATION PIPELINE BELOW (unchanged)
        const learned = lookupLearnedSender(fromAddress);
        // ... rest of pipeline ...
```

- [ ] **Step 5: Add same bypass to Gmail channel**

In `src/channels/gmail.ts`, add the same import and bypass pattern in the equivalent `pollForMessages()` method. The bypass block is identical in structure — deliver all emails without classification.

Add import:
```typescript
import { EMAIL_CLASSIFICATION_ENABLED } from '../config.js';
```

Add bypass after `markGmailProcessed(msg.id)` and body extraction, before the `lookupLearnedSender` call:

```typescript
        if (!EMAIL_CLASSIFICATION_ENABLED) {
          const jid = `gmail:${msg.id}`;
          const timestamp = msg.internalDate
            ? new Date(parseInt(msg.internalDate)).toISOString()
            : new Date().toISOString();

          this.opts.onChatMetadata(jid, timestamp, subject, 'gmail', false);
          this.opts.onMessage(mainJid, {
            id: msg.id,
            chat_jid: mainJid,
            sender: fromAddress,
            sender_name: fromName,
            content: sanitizedContent,
            timestamp,
            is_from_me: false,
          });
          recordEmailDelivery(msg.id, 'gmail', fromAddress);
          logger.info(
            { from: fromName, subject: subject.slice(0, 60) },
            'Gmail email delivered (classification disabled)',
          );
          continue;
        }
```

- [ ] **Step 6: Build and run tests**

Run: `npm run build && npx vitest run`
Expected: Clean build, all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/channels/outlook.ts src/channels/gmail.ts src/channels/outlook.test.ts
git commit -m "feat: add EMAIL_CLASSIFICATION_ENABLED flag to bypass personal email pipeline"
```

---

### Task 2: Direct agent runner

Create `src/direct-agent.ts` — runs Claude Agent SDK in-process instead of spawning a Docker container. Same input/output interface as container-runner.

**Files:**
- Create: `src/direct-agent.ts`
- Create: `src/direct-agent.test.ts`

**Dependencies:** `@anthropic-ai/claude-agent-sdk` must be added to the main project's package.json. Check if it's already there; if not, install it.

- [ ] **Step 1: Check if SDK is available in main project**

Run: `grep claude-agent-sdk package.json`

If not found:
Run: `npm install @anthropic-ai/claude-agent-sdk`

- [ ] **Step 2: Create the direct agent module**

Create `src/direct-agent.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import path from 'path';
import fs from 'fs';

export interface DirectAgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName?: string;
}

export interface DirectAgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export async function runDirectAgent(
  input: DirectAgentInput,
  onOutput: (output: DirectAgentOutput) => void,
): Promise<void> {
  const groupDir = path.join(GROUPS_DIR, input.groupFolder);
  const sessionDir = path.join(DATA_DIR, 'sessions', input.groupFolder, '.claude');
  const globalDir = path.join(GROUPS_DIR, 'global');
  const ipcDir = path.join(DATA_DIR, 'ipc', input.groupFolder);

  // Ensure directories exist
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });

  // Load group CLAUDE.md as system prompt addition
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const systemPromptAppend = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf-8')
    : undefined;

  // Load global CLAUDE.md
  const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
  const globalClaudeMd = fs.existsSync(globalClaudeMdPath)
    ? fs.readFileSync(globalClaudeMdPath, 'utf-8')
    : undefined;

  const combinedSystemPrompt = [globalClaudeMd, systemPromptAppend]
    .filter(Boolean)
    .join('\n\n---\n\n');

  // Build environment for SDK
  const sdkEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_MAX_TURNS: '50',
  };

  try {
    let sessionId = input.sessionId;
    let lastResult: string | null = null;

    for await (const message of query({
      prompt: [{ type: 'user' as const, message: { role: 'user' as const, content: input.prompt } }],
      options: {
        cwd: groupDir,
        resume: sessionId,
        systemPrompt: combinedSystemPrompt
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: combinedSystemPrompt }
          : undefined,
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'TodoWrite', 'ToolSearch',
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'system' && (message as any).subtype === 'init') {
        sessionId = (message as any).session_id;
      }

      if (message.type === 'result') {
        lastResult = (message as any).result || null;
      }
    }

    onOutput({
      status: 'success',
      result: lastResult,
      newSessionId: sessionId,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, groupFolder: input.groupFolder }, 'Direct agent failed');
    onOutput({
      status: 'error',
      result: null,
      error: errorMsg,
    });
  }
}
```

- [ ] **Step 3: Write basic test**

Create `src/direct-agent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DirectAgentInput, DirectAgentOutput } from './direct-agent.js';

describe('DirectAgentInput interface', () => {
  it('accepts required fields', () => {
    const input: DirectAgentInput = {
      prompt: 'Hello',
      groupFolder: 'test-group',
      chatJid: 'test:123',
      isMain: false,
    };
    expect(input.prompt).toBe('Hello');
    expect(input.groupFolder).toBe('test-group');
  });

  it('accepts optional fields', () => {
    const input: DirectAgentInput = {
      prompt: 'Hello',
      groupFolder: 'test-group',
      chatJid: 'test:123',
      isMain: false,
      sessionId: 'sess-1',
      assistantName: 'ATS-Test',
    };
    expect(input.sessionId).toBe('sess-1');
  });
});

describe('DirectAgentOutput interface', () => {
  it('represents success', () => {
    const output: DirectAgentOutput = {
      status: 'success',
      result: 'Draft created',
      newSessionId: 'sess-2',
    };
    expect(output.status).toBe('success');
  });

  it('represents error', () => {
    const output: DirectAgentOutput = {
      status: 'error',
      result: null,
      error: 'SDK failed',
    };
    expect(output.status).toBe('error');
  });
});
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npx vitest run`
Expected: Clean build, all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/direct-agent.ts src/direct-agent.test.ts
git commit -m "feat: add direct agent runner for in-process Claude Agent SDK execution"
```

---

### Task 3: AGENT_MODE switch

Wire the direct agent into the main orchestrator. When `AGENT_MODE=direct`, use `runDirectAgent()` instead of `runContainerAgent()`.

**Files:**
- Modify: `src/config.ts` (add AGENT_MODE)
- Modify: `src/index.ts` (route to correct agent runner)

- [ ] **Step 1: Add AGENT_MODE config**

In `src/config.ts`, add:

```typescript
export const AGENT_MODE: 'container' | 'direct' =
  (process.env.AGENT_MODE === 'direct') ? 'direct' : 'container';
```

- [ ] **Step 2: Modify agent invocation in index.ts**

Find the `runAgent()` or `runContainerAgent()` call in `src/index.ts`. Add a conditional:

```typescript
import { AGENT_MODE } from './config.js';
import { runDirectAgent } from './direct-agent.js';
```

In the function that processes messages for a group (around `processGroupMessages`), add before the container agent call:

```typescript
if (AGENT_MODE === 'direct') {
  await runDirectAgent(
    {
      prompt: formattedMessages,
      sessionId: existingSessionId,
      groupFolder: group.folder,
      chatJid: chatJid,
      isMain: group.isMain,
      assistantName: ASSISTANT_NAME,
    },
    (output) => {
      if (output.result) {
        // Route output to channel
        routeOutbound(chatJid, output.result);
      }
      if (output.newSessionId) {
        saveSession(group.folder, output.newSessionId);
      }
    },
  );
  return;
}

// Existing container agent path below...
```

The exact integration point depends on the current flow in `index.ts`. The agent must:
- Read the same formatted messages as the container agent
- Write output back through the same routing
- Handle sessions the same way

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Test locally with AGENT_MODE=direct**

Run: `AGENT_MODE=direct EMAIL_CLASSIFICATION_ENABLED=false npm run dev`

Verify in logs:
- "Direct agent" messages appear instead of "Container spawned"
- No Docker containers started

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/index.ts
git commit -m "feat: add AGENT_MODE=direct to bypass Docker container spawning"
```

---

### Task 4: Customer Dockerfile and docker-compose

Create the Docker packaging for customer instances.

**Files:**
- Create: `customer/Dockerfile`
- Create: `customer/docker-compose.yml`
- Create: `customer/README.md`

- [ ] **Step 1: Create customer Dockerfile**

Create `customer/Dockerfile`:

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y curl jq git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Default env for customer instances
ENV AGENT_MODE=direct
ENV EMAIL_CLASSIFICATION_ENABLED=false
ENV NODE_ENV=production

# Data directories (mount as volumes)
RUN mkdir -p data/sessions data/ipc groups credentials

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create docker-compose template**

Create `customer/docker-compose.yml`:

```yaml
services:
  nanoclaw:
    build:
      context: ..
      dockerfile: customer/Dockerfile
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./groups:/app/groups
      - ./skills:/app/container/skills/customer
      - ./credentials:/app/credentials
    mem_limit: 1g
    cpus: 1.0
    logging:
      driver: journald
      options:
        tag: "{{.Name}}"
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(0)"]
      interval: 60s
      timeout: 10s
      retries: 3
```

- [ ] **Step 3: Create README with deployment instructions**

Create `customer/README.md`:

```markdown
# Customer Instance Deployment

## Setup

1. Create customer directory:
   ```bash
   mkdir -p /opt/nanoclaw-customers/ats/{data,groups/ats-email/wiki,skills/ats-feed,credentials}
   ```

2. Copy deployment files:
   ```bash
   cp customer/docker-compose.yml /opt/nanoclaw-customers/ats/
   cp customer/.env.template /opt/nanoclaw-customers/ats/.env
   cp container/skills/ats-feed/* /opt/nanoclaw-customers/ats/skills/ats-feed/
   ```

3. Create groups/ats-email/CLAUDE.md with customer-specific agent instructions

4. Fill in .env with customer credentials

5. Build and start:
   ```bash
   cd /opt/nanoclaw-customers/ats
   docker-compose up -d
   ```

## Management

```bash
docker-compose logs -f          # View logs
docker-compose restart          # Restart
docker-compose down             # Stop
docker-compose up -d --build    # Rebuild and restart
```
```

- [ ] **Step 4: Create .env template**

Create `customer/.env.template`:

```env
# === Required ===
ANTHROPIC_API_KEY=
ASSISTANT_NAME=ATS-Assistent

# === Agent mode (do not change) ===
AGENT_MODE=direct
EMAIL_CLASSIFICATION_ENABLED=false

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

# === Gmail (for testing) ===
GMAIL_CREDENTIALS_DIR=/app/credentials
```

- [ ] **Step 5: Test Docker build**

Run: `docker build -f customer/Dockerfile -t nanoclaw-customer:test .`
Expected: Successful build

- [ ] **Step 6: Commit**

```bash
git add customer/
git commit -m "feat: add customer Dockerfile and docker-compose for isolated deployment"
```

---

### Task 5: Add Slack channel

Use the existing `/add-slack` skill to generate the Slack channel implementation. Interactive — requires user input.

**Files:**
- Create: `src/channels/slack.ts` (generated by skill)
- Modify: `src/channels/index.ts` (add import)

- [ ] **Step 1: Invoke /add-slack**

Run: `/add-slack`

Follow prompts to create Socket Mode Slack integration.

- [ ] **Step 2: Build and test**

Run: `npm run build && npx vitest run`
Expected: Clean build, all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/channels/slack.ts src/channels/index.ts
git commit -m "feat: add Slack channel via Socket Mode"
```

---

### Task 6: E2E test with test Gmail

Test the full flow locally using `ats.test.assistent@gmail.com` and direct agent mode.

**Prerequisites:** Tasks 1-4 complete, test Gmail authenticated.

- [ ] **Step 1: Set up test group**

Create `groups/ats-email/CLAUDE.md` locally (not committed to git) with agent instructions from the spec. Use the file already at `/Users/magnusrudolfsen/Dev/assistent/groups/ats-email/CLAUDE.md` (preserved locally even though untracked).

- [ ] **Step 2: Start in direct mode with test Gmail**

```bash
AGENT_MODE=direct \
EMAIL_CLASSIFICATION_ENABLED=false \
GMAIL_CREDENTIALS_DIR=~/.gmail-mcp-ats-test \
ASSISTANT_NAME=ATS-Test \
npm run dev
```

- [ ] **Step 3: Register ats-email group as main**

Via the running instance, register the group:
- folder: `ats-email`
- is_main: `true`
- requires_trigger: `false`

- [ ] **Step 4: Send test email**

Send an email to `ats.test.assistent@gmail.com` asking about a used Volvo machine. Verify:
1. Agent picks up the email (no classification filtering)
2. Agent queries ATS feed via `ats-feed` tool
3. Agent creates a reply (in direct mode, output goes to log/channel)
4. Response contains actual machine data from the feed

- [ ] **Step 5: Verify accuracy rules**

Send a test email asking about machine condition. Verify:
- Agent does NOT claim the machine is in good condition
- Agent says it will check with the owner
- Only data explicitly in the feed is quoted

- [ ] **Step 6: Verify language rules**

Send test emails in:
- Norwegian → verify Norwegian response
- German → verify English response
- English → verify English response
