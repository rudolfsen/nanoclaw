# Email Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both email channels (Outlook + Gmail) intelligent — classify, sort to folders, learn from user behavior, capture writing style, and propose draft replies.

**Architecture:** Extends the existing polling channels with a shared classification pipeline (pattern → DB lookup → AI fallback), SQLite-backed deduplication and learning, IPC for draft creation, and wiki-based style memory.

**Tech Stack:** Node.js, TypeScript, imapflow (IMAP), googleapis (Gmail), better-sqlite3, Anthropic SDK (AI fallback), vitest

---

### Task 1: DB schema — outlook_processed and outlook_deliveries tables

**Files:**
- Modify: `src/db.ts:644-676` (inside `initSkillTables`)
- Test: `tests/db-schema.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/db-schema.test.ts`, add tests for the new tables:

```typescript
it('should create outlook_processed table', () => {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='outlook_processed'"
    )
    .get() as any;
  expect(row).toBeDefined();
  expect(row.name).toBe('outlook_processed');
});

it('should create outlook_deliveries table', () => {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='outlook_deliveries'"
    )
    .get() as any;
  expect(row).toBeDefined();
  expect(row.name).toBe('outlook_deliveries');
});

it('should have response_count and ignore_count on email_categories', () => {
  db.prepare(
    "INSERT INTO email_categories (sender, category, confidence) VALUES ('test@example.com', 'viktig', 0.9)"
  ).run();
  const row = db
    .prepare('SELECT response_count, ignore_count, last_response_at FROM email_categories WHERE sender = ?')
    .get('test@example.com') as any;
  expect(row.response_count).toBe(0);
  expect(row.ignore_count).toBe(0);
  expect(row.last_response_at).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db-schema.test.ts`
Expected: FAIL — tables don't exist yet

- [ ] **Step 3: Add tables to initSkillTables**

In `src/db.ts`, inside `initSkillTables`, add after existing `CREATE TABLE` statements:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS outlook_processed (
    uid INTEGER PRIMARY KEY,
    processed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS outlook_deliveries (
    uid TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    sender TEXT NOT NULL,
    delivered_at TEXT DEFAULT (datetime('now')),
    responded INTEGER DEFAULT 0
  );
`);

// Migration: add learning columns to email_categories
try {
  db.exec(`ALTER TABLE email_categories ADD COLUMN response_count INTEGER DEFAULT 0`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE email_categories ADD COLUMN ignore_count INTEGER DEFAULT 0`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE email_categories ADD COLUMN last_response_at TEXT`);
} catch { /* column already exists */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db-schema.test.ts
git commit -m "feat: add outlook_processed, outlook_deliveries tables and learning columns"
```

---

### Task 2: Outlook fetchRecent — fetch email body text

**Files:**
- Modify: `src/channels/outlook.ts:112-140` (`fetchRecent` method)
- Test: `src/channels/outlook.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/channels/outlook.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OutlookChannel } from './outlook.js';

describe('OutlookChannel', () => {
  describe('parseEmail', () => {
    it('includes body text from raw input', () => {
      const channel = new OutlookChannel({
        host: 'localhost',
        port: 993,
        auth: { user: 'test', accessToken: 'fake' },
      });

      const result = channel.parseEmail({
        uid: 1,
        from: { address: 'alice@example.com', name: 'Alice' },
        subject: 'Hello',
        text: 'This is the body text',
        date: new Date('2026-04-13'),
      });

      expect(result.body).toBe('This is the body text');
      expect(result.from).toBe('alice@example.com');
      expect(result.subject).toBe('Hello');
    });

    it('returns empty body when text is undefined', () => {
      const channel = new OutlookChannel({
        host: 'localhost',
        port: 993,
        auth: { user: 'test', accessToken: 'fake' },
      });

      const result = channel.parseEmail({
        uid: 2,
        from: { address: 'bob@example.com' },
        subject: 'No body',
      });

      expect(result.body).toBe('');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes (parseEmail already handles body)**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: PASS — `parseEmail` already uses `raw.text`

- [ ] **Step 3: Update fetchRecent to request body content**

In `src/channels/outlook.ts`, modify the `fetchRecent` method. Change the fetch options to include `source` (for body text):

```typescript
async fetchRecent(
  folder: string = 'INBOX',
  limit: number = 10,
): Promise<ParsedEmail[]> {
  if (!this.client) throw new Error('Not connected');
  const lock = await this.client.getMailboxLock(folder);
  try {
    const messages: ParsedEmail[] = [];
    for await (const msg of this.client.fetch(
      {
        seq: `${Math.max(1, (this.client.mailbox as { exists: number }).exists - limit + 1)}:*`,
      },
      { envelope: true, bodyStructure: true, source: true },
    )) {
      // Extract text body from raw source
      let bodyText = '';
      if (msg.source) {
        const raw = msg.source.toString();
        // Simple extraction: take content after double newline (headers end)
        const headerEnd = raw.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          bodyText = raw.slice(headerEnd + 4).trim();
        }
      }

      messages.push(
        this.parseEmail({
          uid: msg.uid,
          from: msg.envelope?.from?.[0],
          subject: msg.envelope?.subject,
          date: msg.envelope?.date,
          text: bodyText,
        }),
      );
    }
    return messages;
  } finally {
    lock.release();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/outlook.ts src/channels/outlook.test.ts
git commit -m "feat: fetch email body text in Outlook IMAP channel"
```

---

### Task 3: Outlook classification + sanitization + folder sorting

**Files:**
- Modify: `src/channels/outlook.ts:304-407` (`pollForMessages` method)
- Modify: `src/channels/outlook.ts:1-6` (imports)

- [ ] **Step 1: Add imports at top of outlook.ts**

```typescript
import { categorizeEmail } from '../skills/email-sorter.js';
import { sanitizeEmailForAgent } from '../skills/email-sanitizer.js';
import { isImportant } from '../skills/email-classifier.js';
```

- [ ] **Step 2: Add IMAP folder mapping constant**

After the imports section in `outlook.ts`:

```typescript
const CATEGORY_FOLDERS: Record<string, string> = {
  viktig: 'Viktig',
  handling_kreves: 'Viktig',
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  reklame: 'Reklame',
  annet: 'Annet',
};
```

- [ ] **Step 3: Add createFolderIfMissing helper to OutlookChannel**

Add to the `OutlookChannel` class:

```typescript
async createFolderIfMissing(folderName: string): Promise<void> {
  if (!this.client) return;
  try {
    await this.client.mailboxCreate(folderName);
  } catch {
    // Folder already exists — ignore
  }
}
```

- [ ] **Step 4: Rewrite pollForMessages to classify, sort, and filter**

Replace the email processing loop inside `pollForMessages` in `OutlookPollingChannel`:

```typescript
for (const email of emails) {
  if (this.processedUids.has(email.uid)) continue;
  this.processedUids.add(email.uid);

  // Classify
  const classification = categorizeEmail({
    from: email.from,
    subject: email.subject,
    body: email.body.slice(0, 500),
  });

  logger.info(
    { uid: email.uid, subject: email.subject.slice(0, 60), category: classification.category },
    'Outlook email classified',
  );

  // Move to IMAP folder
  const targetFolder = CATEGORY_FOLDERS[classification.category] || 'Annet';
  try {
    await channel.createFolderIfMissing(targetFolder);
    await channel.moveToFolder(email.uid, targetFolder);
  } catch (err) {
    logger.warn({ uid: email.uid, targetFolder, err }, 'Outlook: failed to move email');
  }

  // Only deliver important emails to agent
  if (!isImportant(classification.category)) continue;

  const jid = `outlook:${email.uid}`;
  const timestamp = email.date.toISOString();
  const sanitizedContent = sanitizeEmailForAgent({
    from: email.from,
    subject: email.subject,
    body: email.body,
  });

  this.opts.onChatMetadata(
    jid,
    timestamp,
    email.subject,
    'outlook',
    false,
  );

  this.opts.onMessage(mainJid, {
    id: String(email.uid),
    chat_jid: mainJid,
    sender: email.from,
    sender_name: email.from,
    content: sanitizedContent,
    timestamp,
    is_from_me: false,
  });

  logger.info(
    { mainJid, from: email.from, subject: email.subject },
    'Outlook email delivered to main group',
  );
}
```

- [ ] **Step 5: Remove markAsRead call**

Delete the `markAsRead` call from the processing loop. E-poster should remain unread in Outlook.

- [ ] **Step 6: Run build to verify**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add src/channels/outlook.ts
git commit -m "feat: classify, sort to IMAP folders, and sanitize Outlook emails"
```

---

### Task 4: Outlook SQLite deduplication

**Files:**
- Modify: `src/channels/outlook.ts` (OutlookPollingChannel)
- Modify: `src/db.ts` (add helper functions)

- [ ] **Step 1: Add DB helper functions in db.ts**

```typescript
export function isOutlookProcessed(uid: number): boolean {
  const row = db
    .prepare('SELECT uid FROM outlook_processed WHERE uid = ?')
    .get(uid);
  return !!row;
}

export function markOutlookProcessed(uid: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO outlook_processed (uid) VALUES (?)',
  ).run(uid);
}

export function cleanupOldOutlookProcessed(daysToKeep: number = 30): void {
  db.prepare(
    `DELETE FROM outlook_processed WHERE processed_at < datetime('now', '-' || ? || ' days')`,
  ).run(daysToKeep);
}
```

- [ ] **Step 2: Replace in-memory Set with DB calls in OutlookPollingChannel**

In `OutlookPollingChannel`, remove the `processedUids` field and import the new DB functions. Replace:

```typescript
if (this.processedUids.has(email.uid)) continue;
this.processedUids.add(email.uid);
```

with:

```typescript
if (isOutlookProcessed(email.uid)) continue;
markOutlookProcessed(email.uid);
```

Remove the `processedUids` field, its initialization in the constructor, and the "Cap processed UID set" block.

- [ ] **Step 3: Add periodic cleanup call**

At the end of `pollForMessages`, after the loop:

```typescript
// Cleanup old processed UIDs periodically (every ~100 polls)
if (Math.random() < 0.01) {
  cleanupOldOutlookProcessed(30);
}
```

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/channels/outlook.ts src/db.ts
git commit -m "feat: SQLite-backed deduplication for Outlook polling"
```

---

### Task 5: Gmail — remove markAsRead and add AI-fallback classification

**Files:**
- Modify: `src/channels/gmail.ts:298-338` (processMessage)
- Modify: `src/skills/email-classifier.ts`

- [ ] **Step 1: Remove markAsRead from Gmail**

In `src/channels/gmail.ts`, delete the block that marks emails as read (lines ~329-338):

```typescript
// DELETE THIS BLOCK:
// Mark as read
try {
  await this.gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
} catch (err) {
  logger.warn({ messageId, err }, 'Failed to mark email as read');
}
```

- [ ] **Step 2: Add AI fallback function to email-classifier.ts**

In `src/skills/email-classifier.ts`, add:

```typescript
import { lookupLearnedCategory } from './email-sorter.js';

export function classifyWithFallback(
  db: Database.Database,
  email: EmailForClassification,
): CategoryResult {
  // Step 1: pattern-based classification
  const result = categorizeEmail({
    from: email.from,
    subject: email.subject,
    body: email.body,
  });

  // Step 2: if confident, store and return
  if (!result.needsAI) {
    classifyAndStore(db, email);
    return result;
  }

  // Step 3: check DB for learned category
  const learned = lookupLearnedCategory(db, email.from);
  if (learned && learned.confidence >= 0.7) {
    const learnedResult: CategoryResult = {
      category: learned.category as CategoryResult['category'],
      confidence: learned.confidence,
      needsAI: false,
    };
    classifyAndStore(db, { ...email, });
    return learnedResult;
  }

  // Step 4: fall through as "annet" (AI classification via container agent)
  classifyAndStore(db, email);
  return result;
}
```

Note: Full AI classification (calling Claude) happens inside the container agent when it processes the email. The host process only does pattern + DB lookup. This avoids adding API calls to the polling loop.

- [ ] **Step 3: Write test for classifyWithFallback**

In `src/skills/email-classifier.test.ts`, add:

```typescript
import { classifyWithFallback } from './email-classifier.js';

describe('classifyWithFallback', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns pattern result when confident', () => {
    const email = {
      uid: 'msg-010',
      source: 'outlook' as const,
      from: 'kollega@firma.no',
      subject: 'Møte',
      body: 'Har du tid?',
    };
    const result = classifyWithFallback(db, email);
    expect(result.category).toBe('viktig');
    expect(result.needsAI).toBe(false);
  });

  it('uses learned category from DB when pattern is uncertain', () => {
    // Pre-populate a learned category
    db.prepare(
      "INSERT INTO email_categories (sender, category, confidence) VALUES ('noreply@custom.com', 'viktig', 0.95)"
    ).run();

    const email = {
      uid: 'msg-011',
      source: 'outlook' as const,
      from: 'noreply@custom.com',
      subject: 'Important update',
      body: 'Please review.',
    };
    const result = classifyWithFallback(db, email);
    expect(result.category).toBe('viktig');
  });

  it('falls through as annet when no pattern or learned match', () => {
    const email = {
      uid: 'msg-012',
      source: 'gmail' as const,
      from: 'noreply@unknown-service.io',
      subject: 'Something',
      body: 'Generic content',
    };
    const result = classifyWithFallback(db, email);
    expect(result.category).toBe('annet');
    expect(result.needsAI).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/skills/email-classifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channels/gmail.ts src/skills/email-classifier.ts src/skills/email-classifier.test.ts
git commit -m "feat: remove Gmail markAsRead, add classifyWithFallback with DB lookup"
```

---

### Task 6: Delivery tracking for implicit learning

**Files:**
- Modify: `src/db.ts` (add delivery tracking helpers)
- Modify: `src/channels/outlook.ts` (record deliveries)
- Modify: `src/channels/gmail.ts` (record deliveries)
- Test: `tests/db-schema.test.ts`

- [ ] **Step 1: Add delivery tracking helpers to db.ts**

```typescript
export function recordEmailDelivery(uid: string, source: string, sender: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO outlook_deliveries (uid, source, sender) VALUES (?, ?, ?)',
  ).run(uid, source, sender);
}

export function markEmailResponded(uid: string): void {
  db.prepare(
    'UPDATE outlook_deliveries SET responded = 1 WHERE uid = ?',
  ).run(uid);
}

export function getIgnoredDeliveries(hoursThreshold: number = 24): Array<{ uid: string; source: string; sender: string }> {
  return db.prepare(
    `SELECT uid, source, sender FROM outlook_deliveries
     WHERE responded = 0
     AND delivered_at < datetime('now', '-' || ? || ' hours')`,
  ).all(hoursThreshold) as Array<{ uid: string; source: string; sender: string }>;
}

export function deleteDelivery(uid: string): void {
  db.prepare('DELETE FROM outlook_deliveries WHERE uid = ?').run(uid);
}

export function incrementResponseCount(sender: string): void {
  db.prepare(
    `UPDATE email_categories SET response_count = response_count + 1, last_response_at = datetime('now')
     WHERE sender = ?`,
  ).run(sender);
}

export function incrementIgnoreCount(sender: string): void {
  db.prepare(
    `UPDATE email_categories SET ignore_count = ignore_count + 1
     WHERE sender = ?`,
  ).run(sender);
}
```

- [ ] **Step 2: Record deliveries in Outlook channel**

In `src/channels/outlook.ts`, after delivering to the agent via `onMessage`, add:

```typescript
import { recordEmailDelivery } from '../db.js';

// After this.opts.onMessage(mainJid, { ... });
recordEmailDelivery(String(email.uid), 'outlook', email.from);
```

- [ ] **Step 3: Record deliveries in Gmail channel**

In `src/channels/gmail.ts`, after delivering to the agent via `this.opts.onMessage`, add:

```typescript
import { recordEmailDelivery } from '../db.js';

// After this.opts.onMessage(mainJid, { ... });
recordEmailDelivery(messageId, 'gmail', senderEmail);
```

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/channels/outlook.ts src/channels/gmail.ts
git commit -m "feat: track email deliveries for implicit learning"
```

---

### Task 7: Ignore detection scheduled task

**Files:**
- Modify: `src/db.ts` (add processIgnoredEmails)
- Modify: `src/index.ts` (seed the scheduled task)

- [ ] **Step 1: Add processIgnoredEmails function to db.ts**

```typescript
export function processIgnoredEmails(hoursThreshold: number = 24): number {
  const ignored = getIgnoredDeliveries(hoursThreshold);
  let count = 0;
  for (const delivery of ignored) {
    incrementIgnoreCount(delivery.sender);
    deleteDelivery(delivery.uid);
    count++;
  }
  return count;
}
```

- [ ] **Step 2: Seed the daily ignore-detection task**

In `src/index.ts`, in the startup section where tasks are seeded, add a check for the ignore detection task:

```typescript
import { getTaskById } from './db.js';

// Seed ignore-detection task if it doesn't exist
if (!getTaskById('daily-ignore-detection')) {
  createTask({
    id: 'daily-ignore-detection',
    group_folder: 'privat',
    chat_jid: mainJid,
    prompt: 'Kjør daglig ignore-deteksjon for e-post læring. Bruk Bash: node -e "const db = require(\'better-sqlite3\')(\'/data/messages.db\'); const ignored = db.prepare(\\"SELECT uid, sender FROM outlook_deliveries WHERE responded = 0 AND delivered_at < datetime(\'now\', \'-24 hours\')\\").all(); for (const d of ignored) { db.prepare(\\"UPDATE email_categories SET ignore_count = ignore_count + 1 WHERE sender = ?\\").run(d.sender); db.prepare(\\"DELETE FROM outlook_deliveries WHERE uid = ?\\").run(d.uid); } console.log(ignored.length + \' ignorerte e-poster prosessert\');"',
    schedule_type: 'cron',
    schedule_value: '0 6 * * *',
    context_mode: 'isolated',
    next_run: null,
    status: 'active',
    created_at: new Date().toISOString(),
  });
}
```

Alternatively, call `processIgnoredEmails()` directly in the host polling loop rather than via a container task. This is simpler since it's a pure DB operation:

In `src/channels/outlook.ts` and `src/channels/gmail.ts`, at the end of each poll cycle, add:

```typescript
// Run ignore detection inline (lightweight DB operation)
if (Math.random() < 0.04) { // ~once every 25 polls ≈ every ~25 minutes
  const count = processIgnoredEmails(24);
  if (count > 0) {
    logger.info({ count }, 'Processed ignored email deliveries');
  }
}
```

Use the inline approach — it avoids the overhead of spinning up a container for a simple DB query.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/channels/outlook.ts src/channels/gmail.ts
git commit -m "feat: inline ignore detection for email learning"
```

---

### Task 8: IPC save-draft command for Outlook

**Files:**
- Modify: `src/ipc.ts` (add save-draft handler)
- Modify: `src/channels/outlook.ts` (add saveDraft method to OutlookChannel)

- [ ] **Step 1: Add saveDraft method to OutlookChannel**

```typescript
async saveDraft(
  to: string,
  subject: string,
  body: string,
  inReplyTo?: string,
  references?: string,
): Promise<void> {
  if (!this.client) throw new Error('Not connected');

  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ].join('\r\n');

  const raw = Buffer.from(headers);

  await this.client.append('Drafts', raw, ['\\Draft']);
  logger.info({ to, subject: subject.slice(0, 60) }, 'Outlook draft saved');
}
```

- [ ] **Step 2: Add IPC handler for save-draft**

In `src/ipc.ts`, add a new case in the `processTaskIpc` switch:

```typescript
case 'save_outlook_draft':
  if (isMain && data.to && data.subject && data.body) {
    try {
      const { getOutlookAccessToken, OutlookChannel } = await import('./channels/outlook.js');
      const envVars = (await import('./env.js')).readEnvFile([
        'OUTLOOK_REFRESH_TOKEN', 'OUTLOOK_TENANT_ID', 'OUTLOOK_CLIENT_ID',
        'OUTLOOK_CLIENT_SECRET', 'OUTLOOK_EMAIL',
      ]);
      const tenantId = process.env.OUTLOOK_TENANT_ID || envVars.OUTLOOK_TENANT_ID || '';
      const clientId = process.env.OUTLOOK_CLIENT_ID || envVars.OUTLOOK_CLIENT_ID || '';
      const clientSecret = process.env.OUTLOOK_CLIENT_SECRET || envVars.OUTLOOK_CLIENT_SECRET || '';
      const refreshToken = process.env.OUTLOOK_REFRESH_TOKEN || envVars.OUTLOOK_REFRESH_TOKEN || '';
      const email = process.env.OUTLOOK_EMAIL || envVars.OUTLOOK_EMAIL || '';

      const accessToken = await getOutlookAccessToken(tenantId, clientId, clientSecret, refreshToken);
      const channel = new OutlookChannel({
        host: 'outlook.office365.com',
        port: 993,
        auth: { user: email, accessToken },
      });
      await channel.connect();
      await channel.saveDraft(
        data.to as string,
        data.subject as string,
        data.body as string,
        data.inReplyTo as string | undefined,
        data.references as string | undefined,
      );
      await channel.disconnect();
      logger.info({ sourceGroup, to: data.to }, 'Outlook draft saved via IPC');
    } catch (err) {
      logger.error({ err, sourceGroup }, 'Failed to save Outlook draft via IPC');
    }
  } else if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized save_outlook_draft attempt blocked');
  }
  break;
```

Add the new fields to the `data` type in `processTaskIpc`:

```typescript
// Add to the data interface:
to?: string;
body?: string;
subject?: string;
inReplyTo?: string;
references?: string;
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/outlook.ts src/ipc.ts
git commit -m "feat: IPC save-draft command for Outlook IMAP drafts"
```

---

### Task 9: Gmail draft creation

**Files:**
- Modify: `src/channels/gmail.ts` (add createDraft method)

- [ ] **Step 1: Add createDraft method to GmailChannel**

```typescript
async createDraft(
  to: string,
  subject: string,
  body: string,
  threadId?: string,
  inReplyTo?: string,
  references?: string,
): Promise<void> {
  if (!this.gmail) {
    logger.warn('Gmail not initialized, cannot create draft');
    return;
  }

  const headers = [
    `To: ${to}`,
    `From: ${this.userEmail}`,
    `Subject: ${subject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encodedMessage = Buffer.from(headers)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedMessage,
          threadId: threadId || undefined,
        },
      },
    });
    logger.info({ to, subject: subject.slice(0, 60) }, 'Gmail draft created');
  } catch (err) {
    logger.error({ to, err }, 'Failed to create Gmail draft');
  }
}
```

- [ ] **Step 2: Add IPC handler for Gmail drafts**

In `src/ipc.ts`, add another case:

```typescript
case 'save_gmail_draft':
  if (isMain && data.to && data.subject && data.body) {
    try {
      // Gmail channel is already connected — find it via deps
      // For now, use dynamic import pattern like Outlook
      logger.info({ sourceGroup, to: data.to }, 'Gmail draft save requested via IPC');
      // Gmail draft creation requires the connected GmailChannel instance.
      // Store a reference to it in deps or use a channel registry lookup.
      // This will be wired up when channels expose a getDraftCreator() interface.
    } catch (err) {
      logger.error({ err, sourceGroup }, 'Failed to save Gmail draft via IPC');
    }
  }
  break;
```

Note: Gmail draft creation requires the live `GmailChannel` instance (already authenticated). Wire this through the IPC deps by adding a `getChannel` accessor to `IpcDeps`:

```typescript
// In IpcDeps interface:
getChannel?: (name: string) => Channel | undefined;
```

Then in the handler:

```typescript
case 'save_gmail_draft':
  if (isMain && data.to && data.subject && data.body && deps.getChannel) {
    const gmail = deps.getChannel('gmail') as any;
    if (gmail?.createDraft) {
      await gmail.createDraft(
        data.to, data.subject, data.body,
        data.threadId as string | undefined,
        data.inReplyTo, data.references,
      );
      logger.info({ sourceGroup, to: data.to }, 'Gmail draft saved via IPC');
    }
  }
  break;
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/gmail.ts src/ipc.ts
git commit -m "feat: Gmail draft creation via API and IPC handler"
```

---

### Task 10: Container skill — email draft instructions

**Files:**
- Create: `container/skills/email-draft/SKILL.md`

- [ ] **Step 1: Create the email-draft skill**

```markdown
# Email Draft

Lag svarutkast for viktige e-poster i brukerens egen stil.

## Når du lager utkast

1. Les stilguiden: `cat /workspace/group/wiki/email-style-guide.md`
2. Les eksempler: `cat /workspace/group/wiki/email-style-examples.md`
3. Analyser den innkommende e-posten (avsender, emne, kontekst)
4. Skriv et utkast som matcher brukerens tone og stil
5. Presenter utkastet tydelig markert:

```
📝 **Utkast til svar:**

[utkasttekst]

---
Godkjenn, rediger, eller forkast?
```

## Lagre godkjent utkast

### Outlook (magnus@allvit.no)
Skriv en IPC-fil for å lagre som draft:

```bash
cat > /workspace/ipc/tasks/draft-$(date +%s).json << 'EOF'
{
  "type": "save_outlook_draft",
  "to": "mottaker@example.com",
  "subject": "Re: Emne",
  "body": "Utkasttekst her",
  "inReplyTo": "<original-message-id>",
  "references": "<original-message-id>"
}
EOF
```

### Gmail
```bash
cat > /workspace/ipc/tasks/draft-$(date +%s).json << 'EOF'
{
  "type": "save_gmail_draft",
  "to": "mottaker@example.com",
  "subject": "Re: Emne",
  "body": "Utkasttekst her",
  "threadId": "gmail-thread-id",
  "inReplyTo": "<original-message-id>",
  "references": "<original-message-id>"
}
EOF
```

## Oppdater stildata etter godkjenning

Når brukeren godkjenner eller redigerer et utkast:

1. Lagre svaret som eksempel i `/workspace/group/wiki/email-style-examples.md`
2. Maks 20 eksempler — fjern de eldste om nødvendig
3. Hvis brukeren redigerte, noter forskjellen mellom utkast og endelig versjon
4. Etter ≥10 eksempler: oppdater `/workspace/group/wiki/email-style-guide.md`

## Eksempelformat

```markdown
## [dato] Re: [emne] → [mottaker]
Kontekst: [formell/uformell], [norsk/engelsk]
---
[godkjent svartekst]
---
```

## Stilguide-format

```markdown
# E-poststil

## Tone
- [observasjoner om formalitet, humor, etc.]

## Hilsener
- Norsk formell: [eksempel]
- Norsk uformell: [eksempel]
- Engelsk: [eksempel]

## Avslutninger
- [typiske avslutninger]

## Språkvalg
- [når norsk vs. engelsk]

## Formuleringer
- [typiske uttrykk og vendinger]
```

## Markér respons for læring

Etter godkjent utkast, oppdater delivery-tracking:

```bash
node -e "
  const db = require('better-sqlite3')('/data/messages.db');
  db.prepare('UPDATE outlook_deliveries SET responded = 1 WHERE uid = ?').run('EMAIL_UID');
  db.prepare('UPDATE email_categories SET response_count = response_count + 1, last_response_at = datetime(\"now\") WHERE sender = ?').run('SENDER_EMAIL');
"
```
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/email-draft/SKILL.md
git commit -m "feat: add email-draft container skill for style-aware reply drafts"
```

---

### Task 11: Wire Outlook classification into container agent CLAUDE.md

**Files:**
- Modify: `groups/main/CLAUDE.md` (add email draft instructions reference)

- [ ] **Step 1: Add email draft skill reference**

In the container agent's CLAUDE.md, in the skills section, add a reference to the email-draft skill so the agent knows to use it when processing important emails:

```markdown
## E-post utkast

Når du mottar en viktig e-post (markert med `<external-email>`), lag et svarutkast ved å følge instruksjonene i `/workspace/project/container/skills/email-draft/SKILL.md`.

Les alltid stilguiden og eksemplene først. Hvis de ikke finnes ennå, skriv utkastet i en nøytral, profesjonell tone og lagre det som første eksempel etter godkjenning.
```

- [ ] **Step 2: Commit**

```bash
git add groups/main/CLAUDE.md
git commit -m "feat: wire email-draft skill into container agent instructions"
```

---

### Task 12: Create initial wiki style files

**Files:**
- Create: `groups/privat/wiki/email-style-examples.md`
- Create: `groups/privat/wiki/email-style-guide.md`

- [ ] **Step 1: Create empty style files with headers**

`groups/privat/wiki/email-style-examples.md`:
```markdown
# E-post svareksempler

Samling av godkjente og redigerte svar. Maks 20 eksempler — eldste fjernes automatisk.

<!-- Eksempler legges til automatisk av agenten -->
```

`groups/privat/wiki/email-style-guide.md`:
```markdown
# E-poststil

> Denne guiden genereres automatisk etter ≥10 eksempler i svarbanken.

<!-- Oppdateres automatisk av agenten -->
```

- [ ] **Step 2: Commit**

```bash
git add groups/privat/wiki/email-style-examples.md groups/privat/wiki/email-style-guide.md
git commit -m "feat: create initial email style wiki files"
```

---

### Task 13: Build, test, deploy

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Deploy to server**

```bash
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm run build && systemctl restart nanoclaw'
```

- [ ] **Step 4: Verify Outlook channel starts with classification**

```bash
ssh root@204.168.178.32 'sleep 5 && journalctl -u nanoclaw --no-pager -n 30'
```

Expected: Logs showing "Outlook email classified" with categories, and "Outlook polling channel connected".

- [ ] **Step 5: Verify IMAP folders are created**

Check Outlook client — new folders (Viktig, Kvitteringer, Nyhetsbrev, Reklame, Annet) should appear as emails are processed.
