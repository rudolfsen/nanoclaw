# Personlig Assistent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal AI assistant on NanoClaw with Telegram, Slack, Gmail, Outlook channels, email sorting, receipt collection with PDF generation, Google Calendar/Drive integration, and Railway deployment.

**Architecture:** Monolithic NanoClaw instance running in process mode on Railway. Built-in channels (Telegram, Slack, Gmail) via NanoClaw skills. Custom Outlook channel via IMAP. Custom skills for email sorting, receipt collection, and Google services. SQLite for structured data, CLAUDE.md per group for long-term memory.

**Tech Stack:** Node.js, TypeScript, Claude Agent SDK, imapflow (IMAP), pdfkit (PDF generation), googleapis (Calendar/Drive), SQLite, Railway.

**Spec:** `docs/superpowers/specs/2026-03-19-personlig-assistent-design.md`

---

## File Structure

```
# NanoClaw base (forked from qwibitai/nanoclaw)
src/
├── index.ts                    # Main orchestrator (modify)
├── channels/
│   ├── registry.ts             # Channel registry (existing)
│   ├── telegram.ts             # Added by /add-telegram skill
│   ├── slack.ts                # Added by /add-slack skill
│   ├── gmail.ts                # Added by /add-gmail skill
│   └── outlook.ts              # Custom IMAP channel (create)
├── skills/
│   ├── email-sorter.ts         # Email categorization (create)
│   ├── email-actions.ts        # Gmail label + Outlook folder ops (create)
│   ├── email-summary.ts        # Daily email summary (create)
│   ├── receipt-collector.ts    # Receipt extraction + PDF (create)
│   ├── receipt-pdf.ts          # PDF generation from inline receipts (create)
│   ├── google-calendar.ts      # Calendar read/write (create)
│   ├── google-drive.ts         # Drive read/upload (create)
│   └── regnskapsbot-bridge.ts  # Receipt forwarding to regnskapsbotten (create)
├── error-notifier.ts           # Critical error notification via Telegram (create)
├── db.ts                       # SQLite operations (modify)
├── task-scheduler.ts           # Scheduled jobs (existing)
├── container-runner.ts         # Agent containers (existing)
└── config.ts                   # Configuration (modify)

scripts/
└── google-auth.ts              # Local OAuth2 authorization flow (create)

groups/
├── jobb/
│   └── CLAUDE.md               # Work context memory (create)
└── privat/
    └── CLAUDE.md               # Personal context memory (create)

receipts/                       # Receipt staging directory (create)

tests/
├── outlook.test.ts             # Outlook channel tests (create)
├── outlook-idle.test.ts        # IMAP IDLE + reconnect tests (create)
├── db-schema.test.ts           # Database schema tests (create)
├── email-sorter.test.ts        # Email sorter tests (create)
├── email-actions.test.ts       # Gmail/Outlook action tests (create)
├── email-summary.test.ts       # Daily summary tests (create)
├── receipt-collector.test.ts   # Receipt collector tests (create)
├── receipt-pdf.test.ts         # PDF generation tests (create)
├── receipt-process.test.ts     # Full receipt pipeline tests (create)
├── google-calendar.test.ts     # Calendar tests (create)
├── google-drive.test.ts        # Drive tests (create)
├── regnskapsbot-bridge.test.ts # Regnskapsbot bridge tests (create)
└── error-notifier.test.ts      # Error notifier tests (create)

Dockerfile                      # Railway build config (create/modify)
railway.json                    # Railway service config (create)
```

---

## Task 1: Fork, Clone, and Base Setup

**Files:**
- Fork: `qwibitai/nanoclaw` → your GitHub account
- Clone to: `/Users/magnusrudolfsen/Dev/assistent/`

- [ ] **Step 1: Fork the NanoClaw repo**

```bash
gh repo fork qwibitai/nanoclaw --clone --remote
```

- [ ] **Step 2: Move contents into working directory**

Since the working directory already has docs, move the fork contents here or re-clone into this directory. Ensure the NanoClaw source files are at the root of `/Users/magnusrudolfsen/Dev/assistent/`.

- [ ] **Step 3: Install dependencies**

```bash
npm install
```

- [ ] **Step 4: Run NanoClaw setup**

```bash
claude
/setup
```

Follow the interactive setup. Provide the `ANTHROPIC_API_KEY` when prompted. Skip container setup for now (process mode).

- [ ] **Step 5: Verify build**

```bash
npm run build
```

Expected: TypeScript compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: initial NanoClaw setup"
```

---

## Task 2: Add Telegram Channel

**Files:**
- Created by skill: `src/channels/telegram.ts`

- [ ] **Step 1: Run add-telegram skill**

```bash
claude
/add-telegram
```

- [ ] **Step 2: Create Telegram bot**

Go to Telegram, message @BotFather, run `/newbot`. Save the bot token.

- [ ] **Step 3: Configure environment**

Add `TELEGRAM_BOT_TOKEN` to `.env`.

- [ ] **Step 4: Register chat**

Follow the skill's Phase 4 to register your chat as the main chat with `--is-main --no-trigger-required`.

- [ ] **Step 5: Verify**

Send a message to the bot. Verify it responds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Telegram channel"
```

---

## Task 3: Add Slack Channel

**Files:**
- Created by skill: `src/channels/slack.ts`

- [ ] **Step 1: Run add-slack skill**

```bash
claude
/add-slack
```

- [ ] **Step 2: Create Slack app**

Follow the skill's instructions to create a Slack app with the required scopes and install it to your workspace.

- [ ] **Step 3: Configure environment**

Add `SLACK_BOT_TOKEN` and any other required Slack env vars to `.env`.

- [ ] **Step 4: Register channel**

Follow the skill's registration steps.

- [ ] **Step 5: Verify**

Message the bot in Slack. Verify it responds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Slack channel"
```

---

## Task 4: Google OAuth2 Auth Script

**Note:** This must be done before Gmail (Task 5) since Gmail uses the same OAuth2 credentials.

**Files:**
- Create: `scripts/google-auth.ts`
- Modify: `package.json` (add script, add `googleapis`)

- [ ] **Step 1: Install googleapis**

```bash
npm install googleapis
```

- [ ] **Step 2: Create auth script**

`scripts/google-auth.ts`:
```typescript
import { google } from 'googleapis';
import http from 'http';
import url from 'url';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
];

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3333/callback');
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

  console.log('Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization...');

  const code = await new Promise<string>((resolve) => {
    const server = http.createServer((req, res) => {
      const query = url.parse(req.url || '', true).query;
      if (query.code) {
        res.end('Authorization successful! You can close this tab.');
        server.close();
        resolve(query.code as string);
      }
    });
    server.listen(3333);
  });

  const { tokens } = await oauth2Client.getToken(code);
  console.log('\nAdd this to your Railway environment variables:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
}

main().catch(console.error);
```

- [ ] **Step 3: Add npm script**

Add to `package.json` scripts:
```json
"auth:google": "npx tsx scripts/google-auth.ts"
```

- [ ] **Step 4: Set up Google Cloud project**

1. Go to Google Cloud Console
2. Create a new project
3. Enable Gmail API, Google Calendar API, Google Drive API
4. Create OAuth2 credentials (Desktop app)
5. Add `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` to `.env`

- [ ] **Step 5: Run auth flow**

```bash
npm run auth:google
```

Open the URL, authorize, save the `GOOGLE_REFRESH_TOKEN` to `.env`.

- [ ] **Step 6: Commit**

```bash
git add scripts/google-auth.ts package.json
git commit -m "feat: add Google OAuth2 authorization script for headless deploy"
```

---

## Task 5: Add Gmail Channel

**Files:**
- Created by skill: `src/channels/gmail.ts`

**Prerequisite:** Task 4 (Google OAuth2 credentials must exist)

- [ ] **Step 1: Run add-gmail skill**

```bash
claude
/add-gmail
```

- [ ] **Step 2: Configure**

The OAuth2 credentials from Task 4 should already be in `.env`. Follow the skill's instructions for any additional Gmail-specific setup.

- [ ] **Step 3: Verify**

Confirm the assistant can read Gmail messages.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Gmail channel (read-only)"
```

---

## Task 6: Group Routing Setup

**Files:**
- Create: `groups/jobb/CLAUDE.md`
- Create: `groups/privat/CLAUDE.md`
- Modify: `src/config.ts`

- [ ] **Step 1: Create group directories and CLAUDE.md files**

```bash
mkdir -p groups/jobb groups/privat
```

`groups/jobb/CLAUDE.md`:
```markdown
# Jobb-assistent

Du er en jobbassistent. Du hjelper med arbeidsrelaterte oppgaver.

## Kontekst
- Kanal: Slack
- Fokus: jobb, prosjekter, møter, kode
```

`groups/privat/CLAUDE.md`:
```markdown
# Privat-assistent

Du er en personlig assistent. Du hjelper med private oppgaver.

## Kontekst
- Kanal: Telegram
- Fokus: privat, personlige gjøremål, påminnelser
```

- [ ] **Step 2: Configure group routing**

Modify `src/config.ts` to route Slack messages to the `jobb` group and Telegram messages to the `privat` group. Check how NanoClaw's existing group routing works in `src/index.ts` and adapt accordingly.

- [ ] **Step 3: Verify routing**

Send a message via Slack → verify it uses `jobb` group context.
Send a message via Telegram → verify it uses `privat` group context.

- [ ] **Step 4: Commit**

```bash
git add groups/ src/config.ts
git commit -m "feat: add group routing (Slack→jobb, Telegram→privat)"
```

---

## Task 7: Outlook IMAP Channel — Core

**Files:**
- Create: `src/channels/outlook.ts`
- Create: `tests/outlook.test.ts`
- Modify: `package.json` (add `imapflow`)

- [ ] **Step 1: Install imapflow**

```bash
npm install imapflow
npm install -D @types/imapflow
```

- [ ] **Step 2: Write failing test for connection and parsing**

`tests/outlook.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { OutlookChannel } from '../src/channels/outlook';

describe('OutlookChannel', () => {
  it('should create an instance with IMAP config', () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'test-app-password' },
    });
    expect(channel).toBeDefined();
    expect(channel.name).toBe('outlook');
  });

  it('should parse email into standard message format', () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });

    const rawEmail = {
      uid: 123,
      from: { address: 'sender@example.com', name: 'Sender' },
      subject: 'Test Subject',
      text: 'Hello world',
      date: new Date('2026-03-19'),
    };

    const message = channel.parseEmail(rawEmail);
    expect(message.from).toBe('sender@example.com');
    expect(message.subject).toBe('Test Subject');
    expect(message.body).toBe('Hello world');
  });

  it('should throw when fetching without connection', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });
    await expect(channel.fetchRecent()).rejects.toThrow('Not connected');
  });

  it('should throw when moving without connection', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });
    await expect(channel.moveToFolder(1, 'Archive')).rejects.toThrow('Not connected');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/outlook.test.ts
```

Expected: FAIL — `OutlookChannel` not found.

- [ ] **Step 4: Implement OutlookChannel core**

`src/channels/outlook.ts`:
```typescript
import { ImapFlow } from 'imapflow';

interface OutlookConfig {
  host: string;
  port: number;
  auth: { user: string; pass: string };
}

interface ParsedEmail {
  uid: number;
  from: string;
  subject: string;
  body: string;
  date: Date;
  hasAttachments: boolean;
}

export class OutlookChannel {
  public readonly name = 'outlook';
  private config: OutlookConfig;
  private client: ImapFlow | null = null;

  constructor(config: OutlookConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: this.config.auth,
      logger: false,
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.logout();
      this.client = null;
    }
  }

  parseEmail(raw: any): ParsedEmail {
    return {
      uid: raw.uid,
      from: raw.from?.address || '',
      subject: raw.subject || '',
      body: raw.text || '',
      date: raw.date || new Date(),
      hasAttachments: !!(raw.attachments && raw.attachments.length > 0),
    };
  }

  async fetchRecent(folder: string = 'INBOX', limit: number = 10): Promise<ParsedEmail[]> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock(folder);
    try {
      const messages: ParsedEmail[] = [];
      for await (const msg of this.client.fetch(
        { seq: `${Math.max(1, this.client.mailbox.exists - limit + 1)}:*` },
        { envelope: true, bodyStructure: true }
      )) {
        messages.push(this.parseEmail({
          uid: msg.uid,
          from: msg.envelope.from?.[0],
          subject: msg.envelope.subject,
          date: msg.envelope.date,
        }));
      }
      return messages;
    } finally {
      lock.release();
    }
  }

  async moveToFolder(uid: number, targetFolder: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      await this.client.messageMove(uid.toString(), targetFolder);
    } finally {
      lock.release();
    }
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/outlook.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/channels/outlook.ts tests/outlook.test.ts package.json package-lock.json
git commit -m "feat: add Outlook IMAP channel core with connection, parsing, and folder ops"
```

---

## Task 8: Outlook IMAP — IDLE Watch and Reconnect

**Files:**
- Modify: `src/channels/outlook.ts`
- Create: `tests/outlook-idle.test.ts`

- [ ] **Step 1: Write failing test for IDLE and reconnect**

`tests/outlook-idle.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { OutlookChannel } from '../src/channels/outlook';

describe('OutlookChannel IDLE and Reconnect', () => {
  it('should throw when starting idle without connection', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });
    await expect(
      channel.startIdleWatch('INBOX', vi.fn())
    ).rejects.toThrow('Not connected');
  });

  it('should attempt reconnect on connection error', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });

    const connectSpy = vi.spyOn(channel, 'connect').mockRejectedValue(new Error('Connection refused'));

    await expect(channel.reconnectWithRetry(3, 10)).rejects.toThrow();
    expect(connectSpy).toHaveBeenCalledTimes(3);
  });

  it('should succeed on reconnect after transient failure', async () => {
    const channel = new OutlookChannel({
      host: 'outlook.office365.com',
      port: 993,
      auth: { user: 'test@outlook.com', pass: 'pass' },
    });

    let attempts = 0;
    vi.spyOn(channel, 'connect').mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new Error('Connection refused');
      // Success on 3rd attempt
    });

    await channel.reconnectWithRetry(5, 10);
    expect(attempts).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/outlook-idle.test.ts
```

Expected: FAIL — `reconnectWithRetry` and `startIdleWatch` not found.

- [ ] **Step 3: Add IDLE watch and reconnect to OutlookChannel**

Add to `src/channels/outlook.ts`:
```typescript
  private onError?: (error: Error) => void;

  setErrorHandler(handler: (error: Error) => void): void {
    this.onError = handler;
  }

  async reconnectWithRetry(maxRetries: number = 5, delayMs: number = 5000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.disconnect();
        await this.connect();
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  async startIdleWatch(
    folder: string,
    onNewMail: (email: ParsedEmail) => void
  ): Promise<void> {
    if (!this.client) throw new Error('Not connected');

    this.client.on('exists', async () => {
      try {
        const emails = await this.fetchRecent(folder, 1);
        if (emails.length > 0) onNewMail(emails[0]);
      } catch (error) {
        this.onError?.(error as Error);
      }
    });

    this.client.on('error', async (error: Error) => {
      this.onError?.(error);
      try {
        await this.reconnectWithRetry();
        await this.startIdleWatch(folder, onNewMail);
      } catch (reconnectError) {
        this.onError?.(reconnectError as Error);
      }
    });

    await this.client.idle();
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/outlook-idle.test.ts
```

Expected: PASS

- [ ] **Step 5: Register channel in NanoClaw**

Add the Outlook channel to `src/channels/index.ts` following the pattern used by Telegram/Slack. Auto-register when `OUTLOOK_EMAIL` and `OUTLOOK_APP_PASSWORD` env vars are present.

- [ ] **Step 6: Add env vars**

Add to `.env`:
```
OUTLOOK_EMAIL=your-email@outlook.com
OUTLOOK_APP_PASSWORD=your-app-password
```

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/channels/outlook.ts tests/outlook-idle.test.ts src/channels/index.ts
git commit -m "feat: add IMAP IDLE watch with auto-reconnect and register Outlook channel"
```

---

## Task 9: Error Notifier

**Files:**
- Create: `src/error-notifier.ts`
- Create: `tests/error-notifier.test.ts`

- [ ] **Step 1: Write failing test**

`tests/error-notifier.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { ErrorNotifier, formatErrorMessage } from '../src/error-notifier';

describe('ErrorNotifier', () => {
  it('should format error messages with context', () => {
    const msg = formatErrorMessage('IMAP', new Error('Connection lost'));
    expect(msg).toContain('IMAP');
    expect(msg).toContain('Connection lost');
  });

  it('should call send function with formatted message', async () => {
    const sendFn = vi.fn();
    const notifier = new ErrorNotifier(sendFn);
    await notifier.notify('IMAP', new Error('Connection lost'));
    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('IMAP'));
  });

  it('should not send duplicate errors within cooldown', async () => {
    const sendFn = vi.fn();
    const notifier = new ErrorNotifier(sendFn, 1000);
    await notifier.notify('IMAP', new Error('Connection lost'));
    await notifier.notify('IMAP', new Error('Connection lost'));
    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/error-notifier.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement error notifier**

`src/error-notifier.ts`:
```typescript
export function formatErrorMessage(source: string, error: Error): string {
  return `⚠️ Feil i ${source}: ${error.message}\n\nTidspunkt: ${new Date().toISOString()}`;
}

export class ErrorNotifier {
  private sendFn: (message: string) => Promise<void> | void;
  private cooldownMs: number;
  private lastNotified: Map<string, number> = new Map();

  constructor(sendFn: (message: string) => Promise<void> | void, cooldownMs: number = 300000) {
    this.sendFn = sendFn;
    this.cooldownMs = cooldownMs;
  }

  async notify(source: string, error: Error): Promise<void> {
    const key = `${source}:${error.message}`;
    const now = Date.now();
    const last = this.lastNotified.get(key) || 0;

    if (now - last < this.cooldownMs) return;

    this.lastNotified.set(key, now);
    const message = formatErrorMessage(source, error);
    await this.sendFn(message);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/error-notifier.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/error-notifier.ts tests/error-notifier.test.ts
git commit -m "feat: add error notifier with cooldown for Telegram alerts"
```

---

## Task 10: SQLite Schema for Skills

**Files:**
- Modify: `src/db.ts`
- Create: `tests/db-schema.test.ts`

- [ ] **Step 1: Write failing test for new tables**

`tests/db-schema.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';

describe('Skill database tables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSkillTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should create email_categories table', () => {
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='email_categories'"
    ).get();
    expect(result).toBeDefined();
  });

  it('should create receipts table', () => {
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='receipts'"
    ).get();
    expect(result).toBeDefined();
  });

  it('should insert and query a receipt', () => {
    db.prepare(`
      INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(123, 'gmail', 'Meta', 1500.00, 'NOK', '2026-03-19', 'receipts/meta-2026-03-19.pdf', 'pending');

    const receipt = db.prepare('SELECT * FROM receipts WHERE email_uid = ?').get(123) as any;
    expect(receipt.vendor).toBe('Meta');
    expect(receipt.amount).toBe(1500.00);
    expect(receipt.status).toBe('pending');
  });

  it('should insert and query learned email categories', () => {
    db.prepare(`
      INSERT INTO email_categories (sender, category, confidence)
      VALUES (?, ?, ?)
    `).run('noreply@facebookmail.com', 'kvittering', 0.95);

    const cat = db.prepare('SELECT * FROM email_categories WHERE sender = ?')
      .get('noreply@facebookmail.com') as any;
    expect(cat.category).toBe('kvittering');
    expect(cat.confidence).toBe(0.95);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/db-schema.test.ts
```

Expected: FAIL — `initSkillTables` not found.

- [ ] **Step 3: Implement schema**

Add to `src/db.ts`:
```typescript
export function initSkillTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(sender, category)
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_uid INTEGER NOT NULL,
      source TEXT NOT NULL,
      vendor TEXT,
      amount REAL,
      currency TEXT DEFAULT 'NOK',
      date TEXT,
      pdf_path TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/db-schema.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db-schema.test.ts
git commit -m "feat: add SQLite schema for email categories and receipts"
```

---

## Task 11: Email Sorter — Heuristic Categorization

**Files:**
- Create: `src/skills/email-sorter.ts`
- Create: `tests/email-sorter.test.ts`

- [ ] **Step 1: Write failing test for categorization**

`tests/email-sorter.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { categorizeEmail, lookupLearnedCategory, EmailInput } from '../src/skills/email-sorter';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';

describe('Email Sorter - Heuristic', () => {
  it('should detect receipt emails by common patterns', () => {
    const email: EmailInput = {
      from: 'noreply@facebookmail.com',
      subject: 'Your receipt from Meta',
      body: 'Amount charged: 1,500.00 NOK',
    };
    const result = categorizeEmail(email);
    expect(result.category).toBe('kvittering');
  });

  it('should detect newsletters', () => {
    const email: EmailInput = {
      from: 'newsletter@example.com',
      subject: 'Weekly digest',
      body: 'Unsubscribe from this newsletter',
    };
    const result = categorizeEmail(email);
    expect(result.category).toBe('nyhetsbrev');
  });

  it('should return unknown for ambiguous emails', () => {
    const email: EmailInput = {
      from: 'person@company.com',
      subject: 'Hello',
      body: 'Just checking in',
    };
    const result = categorizeEmail(email);
    expect(result.category).toBe('ukjent');
    expect(result.needsAI).toBe(true);
  });
});

describe('Email Sorter - Learned Categories', () => {
  it('should use learned category from database', () => {
    const db = new Database(':memory:');
    initSkillTables(db);
    db.prepare('INSERT INTO email_categories (sender, category, confidence) VALUES (?, ?, ?)')
      .run('person@company.com', 'jobb', 0.9);

    const result = lookupLearnedCategory(db, 'person@company.com');
    expect(result?.category).toBe('jobb');
    expect(result?.confidence).toBe(0.9);
    db.close();
  });

  it('should return null for unknown senders', () => {
    const db = new Database(':memory:');
    initSkillTables(db);
    const result = lookupLearnedCategory(db, 'unknown@example.com');
    expect(result).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/email-sorter.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement email sorter with heuristic pre-filter and learned categories**

`src/skills/email-sorter.ts`:
```typescript
import Database from 'better-sqlite3';

export interface EmailInput {
  from: string;
  subject: string;
  body: string;
}

export interface CategoryResult {
  category: 'kvittering' | 'nyhetsbrev' | 'viktig' | 'jobb' | 'privat' | 'ukjent';
  confidence: number;
  needsAI: boolean;
}

const RECEIPT_PATTERNS = [
  /receipt/i, /invoice/i, /faktura/i, /kvittering/i,
  /payment.*confirm/i, /amount.*charged/i, /order.*confirm/i,
];

const NEWSLETTER_PATTERNS = [
  /unsubscribe/i, /newsletter/i, /weekly.*digest/i,
  /nyhetsbrev/i, /avmeld/i, /list-unsubscribe/i,
];

const RECEIPT_SENDERS = [
  'facebookmail.com', 'paypal.com', 'stripe.com',
  'vipps.no', 'klarna.com',
];

export function categorizeEmail(email: EmailInput): CategoryResult {
  const text = `${email.subject} ${email.body}`;
  const senderDomain = email.from.split('@')[1] || '';

  if (
    RECEIPT_SENDERS.some(s => senderDomain.includes(s)) ||
    RECEIPT_PATTERNS.some(p => p.test(text))
  ) {
    return { category: 'kvittering', confidence: 0.9, needsAI: false };
  }

  if (NEWSLETTER_PATTERNS.some(p => p.test(text))) {
    return { category: 'nyhetsbrev', confidence: 0.8, needsAI: false };
  }

  return { category: 'ukjent', confidence: 0, needsAI: true };
}

export function lookupLearnedCategory(
  db: Database.Database,
  sender: string
): { category: string; confidence: number } | null {
  const row = db.prepare(
    'SELECT category, confidence FROM email_categories WHERE sender = ? ORDER BY confidence DESC LIMIT 1'
  ).get(sender) as any;
  return row ? { category: row.category, confidence: row.confidence } : null;
}

export function saveLearnedCategory(
  db: Database.Database,
  sender: string,
  category: string,
  confidence: number
): void {
  db.prepare(`
    INSERT INTO email_categories (sender, category, confidence)
    VALUES (?, ?, ?)
    ON CONFLICT(sender, category) DO UPDATE SET confidence = ?, created_at = datetime('now')
  `).run(sender, category, confidence, confidence);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/email-sorter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/email-sorter.ts tests/email-sorter.test.ts
git commit -m "feat: add email sorter with heuristic pre-filter and learned categories"
```

---

## Task 12: Email Sorter — Claude Classification and Actions

**Files:**
- Create: `src/skills/email-actions.ts`
- Create: `tests/email-actions.test.ts`
- Modify: `src/skills/email-sorter.ts`

- [ ] **Step 1: Write failing test for Claude classification**

Add to `tests/email-sorter.test.ts`:
```typescript
import { classifyWithClaude } from '../src/skills/email-sorter';

describe('Email Sorter - Claude Classification', () => {
  it('should return a valid category result', async () => {
    // Mock the Claude API call
    const mockClaude = vi.fn().mockResolvedValue({
      category: 'jobb',
      confidence: 0.85,
    });

    const email: EmailInput = {
      from: 'person@company.com',
      subject: 'Q1 budget review',
      body: 'Please review the attached budget',
    };

    const result = await classifyWithClaude(email, mockClaude);
    expect(result.category).toBe('jobb');
    expect(result.confidence).toBe(0.85);
    expect(result.needsAI).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/email-sorter.test.ts
```

Expected: FAIL — `classifyWithClaude` not found.

- [ ] **Step 3: Implement Claude classification**

Add to `src/skills/email-sorter.ts`:
```typescript
type ClaudeClassifier = (email: EmailInput) => Promise<{ category: string; confidence: number }>;

export async function classifyWithClaude(
  email: EmailInput,
  classifier: ClaudeClassifier
): Promise<CategoryResult> {
  const result = await classifier(email);
  return {
    category: result.category as CategoryResult['category'],
    confidence: result.confidence,
    needsAI: false,
  };
}
```

- [ ] **Step 4: Write failing test for email actions**

`tests/email-actions.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { getCategoryFolder, getCategoryLabel } from '../src/skills/email-actions';

describe('Email Actions', () => {
  it('should map category to Gmail label', () => {
    expect(getCategoryLabel('kvittering')).toBe('Kvitteringer');
    expect(getCategoryLabel('nyhetsbrev')).toBe('Nyhetsbrev');
    expect(getCategoryLabel('viktig')).toBe('Viktig');
  });

  it('should map category to Outlook folder', () => {
    expect(getCategoryFolder('kvittering')).toBe('Kvitteringer');
    expect(getCategoryFolder('nyhetsbrev')).toBe('Nyhetsbrev');
    expect(getCategoryFolder('viktig')).toBe('Viktig');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

```bash
npx vitest run tests/email-actions.test.ts
```

Expected: FAIL

- [ ] **Step 6: Implement email actions**

`src/skills/email-actions.ts`:
```typescript
import { OutlookChannel } from '../channels/outlook';

const CATEGORY_LABELS: Record<string, string> = {
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  viktig: 'Viktig',
  jobb: 'Jobb',
  privat: 'Privat',
};

export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

export function getCategoryFolder(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

export async function moveOutlookEmail(
  channel: OutlookChannel,
  uid: number,
  category: string
): Promise<void> {
  const folder = getCategoryFolder(category);
  await channel.moveToFolder(uid, folder);
}
```

- [ ] **Step 7: Run tests**

```bash
npx vitest run tests/email-actions.test.ts tests/email-sorter.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/skills/email-sorter.ts src/skills/email-actions.ts tests/email-sorter.test.ts tests/email-actions.test.ts
git commit -m "feat: add Claude classification fallback and email sorting actions"
```

---

## Task 13: Daily Email Summary

**Files:**
- Create: `src/skills/email-summary.ts`
- Create: `tests/email-summary.test.ts`

- [ ] **Step 1: Write failing test**

`tests/email-summary.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';
import { generateDailySummary } from '../src/skills/email-summary';

describe('Daily Email Summary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSkillTables(db);
    // Add categorized_emails table for tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS categorized_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_uid INTEGER NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => { db.close(); });

  it('should generate summary from categorized emails', () => {
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(1, 'gmail', 'viktig');
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(2, 'outlook', 'kvittering');
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(3, 'gmail', 'nyhetsbrev');
    db.prepare('INSERT INTO categorized_emails (email_uid, source, category) VALUES (?, ?, ?)')
      .run(4, 'gmail', 'nyhetsbrev');

    const summary = generateDailySummary(db);
    expect(summary).toContain('4');
    expect(summary).toContain('viktig');
    expect(summary).toContain('kvittering');
    expect(summary).toContain('nyhetsbrev');
  });

  it('should return empty message when no emails', () => {
    const summary = generateDailySummary(db);
    expect(summary).toContain('0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/email-summary.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement daily summary**

`src/skills/email-summary.ts`:
```typescript
import Database from 'better-sqlite3';

export function generateDailySummary(db: Database.Database): string {
  const rows = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM categorized_emails
    WHERE date(created_at) = date('now')
    GROUP BY category
  `).all() as { category: string; count: number }[];

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return '📬 0 nye e-poster i dag.';

  const parts = rows.map(r => `${r.count} ${r.category}`).join(', ');
  return `📬 ${total} nye i dag — ${parts}`;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/email-summary.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/email-summary.ts tests/email-summary.test.ts
git commit -m "feat: add daily email summary generator"
```

---

## Task 14: Receipt PDF Generator

**Files:**
- Create: `src/skills/receipt-pdf.ts`
- Create: `tests/receipt-pdf.test.ts`
- Modify: `package.json` (add `pdfkit`)

- [ ] **Step 1: Install pdfkit**

```bash
npm install pdfkit
npm install -D @types/pdfkit
```

- [ ] **Step 2: Write failing test**

`tests/receipt-pdf.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { generateReceiptPdf, ReceiptData } from '../src/skills/receipt-pdf';
import fs from 'fs';
import path from 'path';

describe('Receipt PDF Generator', () => {
  const testDir = '/tmp/test-receipts';

  it('should generate a PDF file from receipt data', async () => {
    fs.mkdirSync(testDir, { recursive: true });

    const receipt: ReceiptData = {
      vendor: 'Meta (Facebook)',
      amount: 1500.00,
      currency: 'NOK',
      date: '2026-03-19',
      reference: 'INV-2026-0319',
      description: 'Facebook Ads - Campaign March',
    };

    const outputPath = path.join(testDir, 'test-receipt.pdf');
    await generateReceiptPdf(receipt, outputPath);

    expect(fs.existsSync(outputPath)).toBe(true);
    const stats = fs.statSync(outputPath);
    expect(stats.size).toBeGreaterThan(0);

    fs.unlinkSync(outputPath);
  });

  it('should generate PDF without optional fields', async () => {
    fs.mkdirSync(testDir, { recursive: true });

    const receipt: ReceiptData = {
      vendor: 'Stripe',
      amount: 299.00,
      currency: 'USD',
      date: '2026-03-19',
    };

    const outputPath = path.join(testDir, 'test-receipt-minimal.pdf');
    await generateReceiptPdf(receipt, outputPath);

    expect(fs.existsSync(outputPath)).toBe(true);
    fs.unlinkSync(outputPath);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/receipt-pdf.test.ts
```

Expected: FAIL

- [ ] **Step 4: Implement PDF generator**

`src/skills/receipt-pdf.ts`:
```typescript
import PDFDocument from 'pdfkit';
import fs from 'fs';

export interface ReceiptData {
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  reference?: string;
  description?: string;
}

export async function generateReceiptPdf(
  receipt: ReceiptData,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(20).text('Kvittering', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Leverandør: ${receipt.vendor}`);
    doc.text(`Dato: ${receipt.date}`);
    doc.text(`Beløp: ${receipt.amount.toFixed(2)} ${receipt.currency}`);
    if (receipt.reference) {
      doc.text(`Referanse: ${receipt.reference}`);
    }
    if (receipt.description) {
      doc.moveDown();
      doc.text(`Beskrivelse: ${receipt.description}`);
    }

    doc.moveDown(2);
    doc.fontSize(8).fillColor('gray')
      .text('Generert automatisk av NanoClaw assistent', { align: 'center' });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/receipt-pdf.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/skills/receipt-pdf.ts tests/receipt-pdf.test.ts package.json package-lock.json
git commit -m "feat: add receipt PDF generator from structured data"
```

---

## Task 15: Receipt Collector Skill

**Files:**
- Create: `src/skills/receipt-collector.ts`
- Create: `tests/receipt-collector.test.ts`
- Create: `tests/receipt-process.test.ts`

- [ ] **Step 1: Write failing test for extraction**

`tests/receipt-collector.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { extractReceiptData, isReceiptEmail } from '../src/skills/receipt-collector';

describe('Receipt Collector', () => {
  it('should extract receipt data from Meta email body', () => {
    const body = `
      Payment confirmation
      Amount: 1,500.00 NOK
      Date: March 19, 2026
      Ad Account: My Business
      Invoice ID: INV-2026-0319
    `;
    const data = extractReceiptData('noreply@facebookmail.com', 'Your receipt', body);
    expect(data.vendor).toBe('Meta');
    expect(data.amount).toBe(1500.00);
    expect(data.currency).toBe('NOK');
  });

  it('should detect attachment-based receipts', () => {
    const email = {
      from: 'billing@service.com',
      subject: 'Invoice attached',
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf' }],
    };
    expect(isReceiptEmail(email)).toBe(true);
  });

  it('should not flag non-receipt emails', () => {
    const email = {
      from: 'person@company.com',
      subject: 'Meeting notes',
      attachments: [],
    };
    expect(isReceiptEmail(email)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/receipt-collector.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement receipt collector**

`src/skills/receipt-collector.ts`:
```typescript
import { ReceiptData, generateReceiptPdf } from './receipt-pdf';
import path from 'path';
import fs from 'fs';

const VENDOR_MAP: Record<string, string> = {
  'facebookmail.com': 'Meta',
  'paypal.com': 'PayPal',
  'stripe.com': 'Stripe',
  'vipps.no': 'Vipps',
};

export function isReceiptEmail(email: {
  from: string;
  subject: string;
  attachments?: { filename: string; contentType: string }[];
}): boolean {
  const hasReceiptAttachment = email.attachments?.some(
    a => a.contentType === 'application/pdf' &&
    /invoice|receipt|faktura|kvittering/i.test(a.filename)
  ) ?? false;

  const hasReceiptSubject = /receipt|invoice|faktura|kvittering|payment.*confirm/i.test(email.subject);

  return hasReceiptAttachment || hasReceiptSubject;
}

export function extractReceiptData(
  from: string,
  subject: string,
  body: string
): ReceiptData {
  const domain = from.split('@')[1] || '';
  const vendor = VENDOR_MAP[domain] || domain;

  const amountMatch = body.match(
    /(?:amount|beløp|total|charged)[:\s]*([0-9,]+(?:\.[0-9]{2})?)\s*(NOK|USD|EUR)?/i
  ) || body.match(
    /(NOK|USD|EUR)\s*([0-9,]+(?:\.[0-9]{2})?)/i
  );

  let amount = 0;
  let currency = 'NOK';
  if (amountMatch) {
    const amountStr = (amountMatch[1] || amountMatch[2]).replace(/,/g, '');
    amount = parseFloat(amountStr);
    currency = (amountMatch[2] || amountMatch[1] || 'NOK').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) currency = 'NOK';
  }

  const dateMatch = body.match(
    /(?:date|dato)[:\s]*([A-Za-z]+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})/i
  );
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

  const refMatch = body.match(/(?:invoice|referanse|ref|id)[:\s#]*([A-Z0-9-]+)/i);
  const reference = refMatch ? refMatch[1] : undefined;

  return { vendor, amount, currency, date, reference };
}

export async function processReceipt(
  from: string,
  subject: string,
  body: string,
  attachments: { filename: string; content: Buffer; contentType: string }[],
  receiptsDir: string
): Promise<string> {
  fs.mkdirSync(receiptsDir, { recursive: true });

  const pdfAttachment = attachments.find(a => a.contentType === 'application/pdf');

  if (pdfAttachment) {
    const filename = `${Date.now()}-${pdfAttachment.filename}`;
    const outputPath = path.join(receiptsDir, filename);
    fs.writeFileSync(outputPath, pdfAttachment.content);
    return outputPath;
  }

  const data = extractReceiptData(from, subject, body);
  const filename = `${data.date}-${data.vendor.toLowerCase().replace(/\s+/g, '-')}.pdf`;
  const outputPath = path.join(receiptsDir, filename);
  await generateReceiptPdf(data, outputPath);
  return outputPath;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/receipt-collector.test.ts
```

Expected: PASS

- [ ] **Step 5: Write failing test for full pipeline**

`tests/receipt-process.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { processReceipt } from '../src/skills/receipt-collector';
import fs from 'fs';

describe('Receipt Processing Pipeline', () => {
  const testDir = '/tmp/test-receipts-pipeline';

  it('should save PDF attachment directly', async () => {
    const path = await processReceipt(
      'billing@service.com',
      'Invoice',
      'Your invoice',
      [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf' }],
      testDir
    );
    expect(fs.existsSync(path)).toBe(true);
    expect(path).toContain('invoice.pdf');
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should generate PDF from inline receipt', async () => {
    const path = await processReceipt(
      'noreply@facebookmail.com',
      'Your receipt from Meta',
      'Amount: 1,500.00 NOK\nDate: 2026-03-19\nInvoice ID: INV-001',
      [],
      testDir
    );
    expect(fs.existsSync(path)).toBe(true);
    expect(path).toContain('meta.pdf');
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 6: Run test**

```bash
npx vitest run tests/receipt-process.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/skills/receipt-collector.ts tests/receipt-collector.test.ts tests/receipt-process.test.ts
git commit -m "feat: add receipt collector with attachment and inline extraction"
```

---

## Task 16: Regnskapsbot Bridge

**Files:**
- Create: `src/skills/regnskapsbot-bridge.ts`
- Create: `tests/regnskapsbot-bridge.test.ts`

- [ ] **Step 1: Write failing test**

`tests/regnskapsbot-bridge.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSkillTables } from '../src/db';
import { getPendingReceipts, markReceiptSent } from '../src/skills/regnskapsbot-bridge';

describe('Regnskapsbot Bridge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSkillTables(db);
    db.prepare(`
      INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'gmail', 'Meta', 1500, 'NOK', '2026-03-19', 'receipts/meta.pdf', 'pending');
    db.prepare(`
      INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 'outlook', 'Stripe', 299, 'USD', '2026-03-18', 'receipts/stripe.pdf', 'sent');
  });

  afterEach(() => { db.close(); });

  it('should return only pending receipts', () => {
    const pending = getPendingReceipts(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].vendor).toBe('Meta');
  });

  it('should mark receipt as sent', () => {
    markReceiptSent(db, 1);
    const pending = getPendingReceipts(db);
    expect(pending).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/regnskapsbot-bridge.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement bridge**

`src/skills/regnskapsbot-bridge.ts`:
```typescript
import Database from 'better-sqlite3';

interface PendingReceipt {
  id: number;
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  pdf_path: string;
}

export function getPendingReceipts(db: Database.Database): PendingReceipt[] {
  return db.prepare(
    "SELECT id, vendor, amount, currency, date, pdf_path FROM receipts WHERE status = 'pending'"
  ).all() as PendingReceipt[];
}

export function markReceiptSent(db: Database.Database, receiptId: number): void {
  db.prepare("UPDATE receipts SET status = 'sent' WHERE id = ?").run(receiptId);
}
```

Note: The actual transfer mechanism to regnskapsbotten (API call, file drop, etc.) will be implemented when the regnskapsbotten project's interface is defined. This bridge provides the data access layer.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/regnskapsbot-bridge.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/regnskapsbot-bridge.ts tests/regnskapsbot-bridge.test.ts
git commit -m "feat: add regnskapsbot bridge for receipt forwarding"
```

---

## Task 17: Google Calendar Skill

**Files:**
- Create: `src/skills/google-calendar.ts`
- Create: `tests/google-calendar.test.ts`

- [ ] **Step 1: Write failing test**

`tests/google-calendar.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { formatEvent, parseEventRequest } from '../src/skills/google-calendar';

describe('Google Calendar', () => {
  it('should format a calendar event for display', () => {
    const event = {
      summary: 'Team standup',
      start: { dateTime: '2026-03-19T09:00:00+01:00' },
      end: { dateTime: '2026-03-19T09:15:00+01:00' },
      location: 'Zoom',
    };
    const formatted = formatEvent(event);
    expect(formatted).toContain('Team standup');
    expect(formatted).toContain('09:00');
  });

  it('should parse natural language event request', () => {
    const parsed = parseEventRequest('Book møte med Anders tirsdag kl 10');
    expect(parsed.summary).toContain('Anders');
    expect(parsed.hour).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/google-calendar.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement calendar skill**

`src/skills/google-calendar.ts` — implement `formatEvent()`, `parseEventRequest()`, `listEvents(date)`, and `createEvent(details)` using the `googleapis` library with the refresh token from env vars.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/google-calendar.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/google-calendar.ts tests/google-calendar.test.ts
git commit -m "feat: add Google Calendar skill with read and create"
```

---

## Task 18: Google Drive Skill

**Files:**
- Create: `src/skills/google-drive.ts`
- Create: `tests/google-drive.test.ts`

- [ ] **Step 1: Write failing test**

`tests/google-drive.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildSearchQuery } from '../src/skills/google-drive';

describe('Google Drive', () => {
  it('should build a Drive search query from natural language', () => {
    const query = buildSearchQuery('kvitteringer fra mars 2026');
    expect(query).toContain("name contains 'kvittering'");
  });

  it('should build query for PDF files', () => {
    const query = buildSearchQuery('alle PDF-filer');
    expect(query).toContain("mimeType='application/pdf'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/google-drive.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement Drive skill**

`src/skills/google-drive.ts` — implement `buildSearchQuery()`, `searchFiles(query)`, `readFile(fileId)`, and `uploadFile(localPath, folderId)` using the `googleapis` library.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/google-drive.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/google-drive.ts tests/google-drive.test.ts
git commit -m "feat: add Google Drive skill with search, read, and upload"
```

---

## Task 19: Config — Path Management

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add environment-aware path configuration**

Add to `src/config.ts`:
```typescript
import path from 'path';

const isProduction = process.env.NODE_ENV === 'production';
const dataDir = isProduction ? '/app/data' : process.cwd();

export const paths = {
  receiptsDir: path.join(dataDir, 'receipts'),
  dbPath: path.join(dataDir, 'db.sqlite'),
};
```

- [ ] **Step 2: Update all skill imports to use config paths**

Ensure `receipt-collector.ts`, `regnskapsbot-bridge.ts`, and `db.ts` use `paths.receiptsDir` and `paths.dbPath` instead of hardcoded paths.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add environment-aware path config for local/Railway"
```

---

## Task 20: Railway Deployment

**Files:**
- Create: `Dockerfile`
- Create: `railway.json`
- Create: `.env.example`

- [ ] **Step 1: Create Dockerfile**

`Dockerfile`:
```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

VOLUME ["/app/data"]

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create railway.json**

`railway.json`:
```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "node dist/index.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

- [ ] **Step 3: Create .env.example**

`.env.example`:
```
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
SLACK_BOT_TOKEN=
OUTLOOK_EMAIL=
OUTLOOK_APP_PASSWORD=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GITHUB_TOKEN=
```

- [ ] **Step 4: Create Railway project and add volume**

```bash
railway login
railway init
railway link
```

In Railway dashboard, add a persistent volume mounted at `/app/data`.

- [ ] **Step 5: Set environment variables**

Set all env vars via Railway dashboard or CLI.

- [ ] **Step 6: Deploy**

```bash
git push origin main
```

- [ ] **Step 7: Verify Telegram responds**

Send a message to the bot. Verify it responds from Railway.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile railway.json .env.example
git commit -m "feat: add Railway deployment config with Dockerfile and persistent volume"
```

---

## Task 21: Wire Email Sorter to Channels

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Hook email sorter to Gmail new-email events**

In `src/index.ts`, when a new Gmail message arrives, run it through `categorizeEmail()`. If `needsAI`, fall back to `classifyWithClaude()`. Then call `applyGmailLabel()`. If category is `kvittering`, trigger `processReceipt()`. Save category to `categorized_emails` table. If the category was resolved by Claude, save to `email_categories` for learning.

- [ ] **Step 2: Hook email sorter to Outlook IDLE events**

Connect the Outlook channel's `startIdleWatch` callback to the same sorting pipeline. Use `moveOutlookEmail()` for folder sorting.

- [ ] **Step 3: Connect error notifier**

Pass the ErrorNotifier to Outlook channel's `setErrorHandler()` and wrap Gmail/Calendar/Drive API calls with error notification on failure.

- [ ] **Step 4: Verify email sorting works**

Send a test email to both Gmail and Outlook. Verify categorization and label/folder assignment.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire email sorter to Gmail and Outlook channels"
```

---

## Task 22: Wire Scheduled Jobs

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add daily email summary job**

Using NanoClaw's `task-scheduler.ts`, schedule a daily job (e.g., 08:00) that calls `generateDailySummary()` and sends the result via Telegram channel.

- [ ] **Step 2: Add daily receipt scan job**

Schedule a daily job that scans Gmail and Outlook for receipt emails missed by real-time sorting, processes them with `processReceipt()`.

- [ ] **Step 3: Verify scheduled jobs**

Manually trigger both jobs and verify output.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add daily email summary and receipt scan scheduled jobs"
```

---

## Task 23: Register Skills as Agent Tools

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Register Calendar tool**

Make `listEvents()` and `createEvent()` available as tools the Claude agent can call conversationally.

- [ ] **Step 2: Register Drive tool**

Make `searchFiles()`, `readFile()`, and `uploadFile()` available as agent tools.

- [ ] **Step 3: Register Receipt tool**

Make `processReceipt()` and `getPendingReceipts()` available as agent tools.

- [ ] **Step 4: Register Email Summary tool**

Make `generateDailySummary()` available as an agent tool.

- [ ] **Step 5: Verify end-to-end via Telegram**

Test conversationally:
- "Hva har jeg i kalenderen i dag?" → Calendar response
- "Hent kvitteringer fra siste uke" → Receipt collection runs
- "Oppsummer e-postene mine" → Email summary
- "Søk etter filer i Drive" → Drive search

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: register Calendar, Drive, Receipt, and Summary as agent tools"
```

---

## Task 24: Final Deploy and Verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Deploy to Railway**

```bash
git push origin main
```

- [ ] **Step 3: End-to-end verification**

From Telegram:
1. Send "Hei" → bot responds
2. "Hva har jeg i kalenderen i dag?" → calendar events listed
3. "Hent kvitteringer" → receipts processed
4. "Oppsummer e-post" → daily summary

From Slack:
1. Send "Hei" → bot responds (using jobb-group context)

- [ ] **Step 4: Verify email sorting is running**

Send a test email, check that labels/folders are applied.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete personal assistant v1"
```
