# Outlook Graph API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace IMAP-based Outlook channel with Microsoft Graph API, adding color categories and automatic tagging with learning.

**Architecture:** Rewrite `src/channels/outlook.ts` to use `fetch` against Graph REST endpoints instead of `imapflow`. Add tag tables to DB. Update IPC and scan-receipts to use Graph. Remove imapflow dependency.

**Tech Stack:** Node.js fetch (built-in), Microsoft Graph REST API v1.0, better-sqlite3, vitest

---

### Task 1: DB schema — email_tags, learned_tags, migrate outlook_processed

**Files:**
- Modify: `src/db.ts`
- Modify: `tests/db-schema.test.ts`

- [ ] **Step 1: Add new tables to initSkillTables in src/db.ts**

Add after the existing `outlook_deliveries` CREATE TABLE:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS email_tags (
    email_uid TEXT NOT NULL,
    source TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(email_uid, source, tag)
  );

  CREATE TABLE IF NOT EXISTS learned_tags (
    tag TEXT NOT NULL UNIQUE,
    pattern_type TEXT NOT NULL,
    pattern_value TEXT NOT NULL,
    occurrence_count INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(pattern_type, pattern_value)
  );
`);
```

- [ ] **Step 2: Migrate outlook_processed from INTEGER to TEXT primary key**

Add migration after the CREATE TABLE statements:

```typescript
// Migrate outlook_processed from INTEGER to TEXT uid (Graph API uses string IDs)
try {
  const hasIntUid = db.prepare(
    "SELECT type FROM pragma_table_info('outlook_processed') WHERE name = 'uid'"
  ).get() as { type: string } | undefined;
  if (hasIntUid && hasIntUid.type === 'INTEGER') {
    db.exec(`
      DROP TABLE outlook_processed;
      CREATE TABLE outlook_processed (
        uid TEXT PRIMARY KEY,
        processed_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }
} catch { /* table doesn't exist yet or already migrated */ }
```

Also update the original CREATE TABLE to use TEXT:

```sql
CREATE TABLE IF NOT EXISTS outlook_processed (
  uid TEXT PRIMARY KEY,
  processed_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 3: Add DB helper functions for tags**

Add to `src/db.ts`:

```typescript
export function addEmailTag(emailUid: string, source: string, tag: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO email_tags (email_uid, source, tag) VALUES (?, ?, ?)',
  ).run(emailUid, source, tag);
}

export function getEmailTags(emailUid: string, source: string): string[] {
  const rows = db.prepare(
    'SELECT tag FROM email_tags WHERE email_uid = ? AND source = ?',
  ).all(emailUid, source) as Array<{ tag: string }>;
  return rows.map(r => r.tag);
}

export function incrementLearnedTag(patternType: string, patternValue: string, tag: string): number {
  db.prepare(
    `INSERT INTO learned_tags (tag, pattern_type, pattern_value, occurrence_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(pattern_type, pattern_value) DO UPDATE SET occurrence_count = occurrence_count + 1`,
  ).run(tag, patternType, patternValue);
  const row = db.prepare(
    'SELECT occurrence_count FROM learned_tags WHERE pattern_type = ? AND pattern_value = ?',
  ).get(patternType, patternValue) as { occurrence_count: number };
  return row.occurrence_count;
}

export function getLearnedTags(minOccurrences: number = 3): Array<{ tag: string; pattern_type: string; pattern_value: string }> {
  return db.prepare(
    'SELECT tag, pattern_type, pattern_value FROM learned_tags WHERE occurrence_count >= ?',
  ).all(minOccurrences) as Array<{ tag: string; pattern_type: string; pattern_value: string }>;
}
```

- [ ] **Step 4: Update isOutlookProcessed and markOutlookProcessed signatures**

Change the parameter type from `number` to `string` in both functions:

```typescript
export function isOutlookProcessed(uid: string): boolean {
  const row = db
    .prepare('SELECT uid FROM outlook_processed WHERE uid = ?')
    .get(uid);
  return !!row;
}

export function markOutlookProcessed(uid: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO outlook_processed (uid) VALUES (?)',
  ).run(uid);
}
```

- [ ] **Step 5: Add tests**

In `tests/db-schema.test.ts`:

```typescript
it('should create email_tags table', () => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_tags'")
    .get() as any;
  expect(row).toBeDefined();
});

it('should create learned_tags table', () => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_tags'")
    .get() as any;
  expect(row).toBeDefined();
});

it('outlook_processed should accept TEXT uid', () => {
  db.prepare("INSERT INTO outlook_processed (uid) VALUES ('AAMkAGQ123')").run();
  const row = db.prepare("SELECT uid FROM outlook_processed WHERE uid = 'AAMkAGQ123'").get() as any;
  expect(row.uid).toBe('AAMkAGQ123');
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/db-schema.test.ts`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/db.ts tests/db-schema.test.ts
git commit -m "feat: add email_tags, learned_tags tables, migrate outlook_processed to TEXT"
```

---

### Task 2: Auto-tagging module

**Files:**
- Create: `src/skills/email-tagger.ts`
- Create: `src/skills/email-tagger.test.ts`

- [ ] **Step 1: Create email-tagger.ts**

```typescript
import {
  addEmailTag,
  incrementLearnedTag,
  getLearnedTags,
} from '../db.js';
import { logger } from '../logger.js';

const STOPWORDS = new Set([
  'og', 'i', 'for', 'med', 'til', 'fra', 'på', 'av', 'er', 'det', 'en', 'et',
  'den', 'de', 'som', 'har', 'var', 'kan', 'vil', 'om', 'vi', 'du', 'meg',
  'the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'are', 'was',
  'has', 'have', 'will', 'can', 'our', 'not', 'but', 'from',
  're', 'fw', 'sv', 'vs', 'fwd',
]);

/**
 * Extract a readable tag from an email domain.
 * e.g. "beate.molander@gyldendal.no" → "Gyldendal"
 */
export function extractDomainTag(email: string): string | null {
  const domain = email.split('@')[1];
  if (!domain) return null;

  // Strip common prefixes/suffixes
  let name = domain
    .replace(/\.(com|no|org|net|io|co|se|dk|fi|eu|uk|de)$/i, '')
    .replace(/^(mail|email|noreply|no-reply|notifications?|alerts?|support|info|hello|news|newsletter|mailer|updates?)\./i, '');

  // Skip generic email service domains
  const genericDomains = ['gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'live',
    'googlemail', 'protonmail', 'fastmail', 'metamail', 'global.metamail'];
  if (genericDomains.some(g => name.includes(g))) return null;

  // Skip automated senders
  if (/^(noreply|no-reply|donotreply|notifications?)$/i.test(name)) return null;

  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * Extract significant keywords from an email subject.
 */
export function extractSubjectKeywords(subject: string): string[] {
  // Strip reply/forward prefixes
  const cleaned = subject.replace(/^(Re|Fw|Fwd|SV|VS|Svar):\s*/gi, '').trim();

  return cleaned
    .split(/[\s\-_/,;:!?()[\]{}]+/)
    .map(w => w.replace(/[^a-zA-ZæøåÆØÅ0-9]/g, ''))
    .filter(w => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
}

/**
 * Generate tags for an email and store them.
 * Returns the list of tags applied.
 */
export function tagEmail(
  emailUid: string,
  source: string,
  category: string,
  from: string,
  subject: string,
): string[] {
  const tags: string[] = [];

  // Level 1: category tag
  tags.push(category);
  addEmailTag(emailUid, source, category);

  // Level 2: domain tag
  const domainTag = extractDomainTag(from);
  if (domainTag) {
    tags.push(domainTag);
    addEmailTag(emailUid, source, domainTag);

    // Count for learning
    incrementLearnedTag('domain', from.split('@')[1] || '', domainTag);
  }

  // Level 3: apply learned tags
  const learnedTags = getLearnedTags(3);
  const senderDomain = from.split('@')[1] || '';
  const keywords = extractSubjectKeywords(subject);

  for (const learned of learnedTags) {
    let matches = false;
    if (learned.pattern_type === 'domain' && senderDomain.includes(learned.pattern_value)) {
      matches = true;
    } else if (learned.pattern_type === 'subject_keyword' && keywords.some(k => k.toLowerCase() === learned.pattern_value.toLowerCase())) {
      matches = true;
    }
    if (matches && !tags.includes(learned.tag)) {
      tags.push(learned.tag);
      addEmailTag(emailUid, source, learned.tag);
    }
  }

  // Count subject keywords for future learning
  for (const keyword of keywords) {
    if (keyword.length >= 4) {
      const tag = keyword.charAt(0).toUpperCase() + keyword.slice(1).toLowerCase();
      incrementLearnedTag('subject_keyword', keyword.toLowerCase(), tag);
    }
  }

  logger.debug({ emailUid, tags }, 'Email tagged');
  return tags;
}
```

- [ ] **Step 2: Create email-tagger.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
import { extractDomainTag, extractSubjectKeywords } from './email-tagger.js';

describe('extractDomainTag', () => {
  it('extracts company name from domain', () => {
    expect(extractDomainTag('beate@gyldendal.no')).toBe('Gyldendal');
  });

  it('strips common prefixes', () => {
    expect(extractDomainTag('noreply@mail.bonnier.com')).toBe('Bonnier');
  });

  it('returns null for generic email domains', () => {
    expect(extractDomainTag('user@gmail.com')).toBeNull();
  });

  it('returns null for automated senders on generic domains', () => {
    expect(extractDomainTag('noreply@notifications.com')).toBeNull();
  });

  it('handles metamail domain', () => {
    expect(extractDomainTag('noreply@global.metamail.com')).toBeNull();
  });
});

describe('extractSubjectKeywords', () => {
  it('strips reply prefixes', () => {
    const keywords = extractSubjectKeywords('Re: SV: Bundling e-bok og pbok');
    expect(keywords).not.toContain('Re');
    expect(keywords).not.toContain('SV');
  });

  it('filters stopwords and short words', () => {
    const keywords = extractSubjectKeywords('Oppgradering av metadata-synk og status');
    expect(keywords).toContain('Oppgradering');
    expect(keywords).toContain('metadata');
    expect(keywords).toContain('synk');
    expect(keywords).toContain('status');
    expect(keywords).not.toContain('av');
    expect(keywords).not.toContain('og');
  });

  it('returns empty array for empty subject', () => {
    expect(extractSubjectKeywords('')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/skills/email-tagger.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/skills/email-tagger.ts src/skills/email-tagger.test.ts
git commit -m "feat: add email auto-tagging module with domain and keyword learning"
```

---

### Task 3: Rewrite outlook.ts — replace IMAP with Graph API

**Files:**
- Rewrite: `src/channels/outlook.ts`

This is the big task. Replace the entire file content. The new file keeps `getOutlookAccessToken` (with updated scope), removes all IMAP classes, and creates a new `OutlookGraphClient` + updated `OutlookPollingChannel`.

- [ ] **Step 1: Rewrite src/channels/outlook.ts**

Replace the entire file with:

```typescript
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  isOutlookProcessed,
  markOutlookProcessed,
  cleanupOldOutlookProcessed,
  recordEmailDelivery,
  processIgnoredEmails,
} from '../db.js';
import { Channel } from '../types.js';
import { categorizeEmail } from '../skills/email-sorter.js';
import { sanitizeEmailForAgent } from '../skills/email-sanitizer.js';
import { isImportant } from '../skills/email-classifier.js';
import { tagEmail } from '../skills/email-tagger.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';

const CATEGORY_FOLDERS: Record<string, string> = {
  viktig: 'Viktig',
  handling_kreves: 'Viktig',
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  reklame: 'Reklame',
  annet: 'Annet',
};

const CATEGORY_COLORS: Record<string, string> = {
  Viktig: 'preset0',        // red
  Kvitteringer: 'preset4',  // green
  Nyhetsbrev: 'preset7',    // blue
  Reklame: 'preset14',      // darkGray
  Annet: 'preset9',         // olive
};

// ---------------------------------------------------------------------------
// OAuth2 token refresh
// ---------------------------------------------------------------------------

export async function getOutlookAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const tokens = (await response.json()) as any;
  if (tokens.error) {
    throw new Error(`OAuth2 token refresh failed: ${tokens.error_description}`);
  }
  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Graph API client
// ---------------------------------------------------------------------------

export interface GraphEmail {
  id: string;
  from: { emailAddress: { address: string; name: string } };
  subject: string;
  body: { contentType: string; content: string };
  receivedDateTime: string;
  conversationId: string;
  categories: string[];
  hasAttachments: boolean;
}

export class OutlookGraphClient {
  private accessToken: string;
  private folderCache = new Map<string, string>();

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async graphFetch(path: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`${GRAPH_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph API ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async fetchInboxMessages(top: number = 20): Promise<GraphEmail[]> {
    const params = new URLSearchParams({
      $filter: 'isRead eq false',
      $top: String(top),
      $select: 'id,from,subject,body,receivedDateTime,conversationId,categories,hasAttachments',
      $orderby: 'receivedDateTime desc',
    });
    const data = await this.graphFetch(`/mailFolders/Inbox/messages?${params}`);
    return data.value || [];
  }

  async getOrCreateFolder(displayName: string): Promise<string> {
    const cached = this.folderCache.get(displayName);
    if (cached) return cached;

    // Try to find existing folder
    if (this.folderCache.size === 0) {
      const data = await this.graphFetch('/mailFolders?$top=50');
      for (const f of data.value || []) {
        this.folderCache.set(f.displayName, f.id);
      }
      const found = this.folderCache.get(displayName);
      if (found) return found;
    }

    // Create folder
    const created = await this.graphFetch('/mailFolders', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    });
    this.folderCache.set(displayName, created.id);
    return created.id;
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    await this.graphFetch(`/messages/${messageId}/move`, {
      method: 'POST',
      body: JSON.stringify({ destinationId: folderId }),
    });
  }

  async setCategories(messageId: string, categories: string[]): Promise<void> {
    await this.graphFetch(`/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ categories: categories.slice(0, 10) }),
    });
  }

  async ensureMasterCategories(categories: Record<string, string>): Promise<void> {
    let existing: string[];
    try {
      const data = await this.graphFetch('/outlook/masterCategories');
      existing = (data.value || []).map((c: any) => c.displayName);
    } catch {
      existing = [];
    }

    for (const [name, color] of Object.entries(categories)) {
      if (existing.includes(name)) continue;
      try {
        await this.graphFetch('/outlook/masterCategories', {
          method: 'POST',
          body: JSON.stringify({ displayName: name, color }),
        });
      } catch {
        // Category may already exist
      }
    }
  }

  async createDraft(
    to: string,
    subject: string,
    body: string,
    conversationId?: string,
  ): Promise<void> {
    const message: any = {
      subject,
      body: { contentType: 'text', content: body },
      toRecipients: [{ emailAddress: { address: to } }],
      isDraft: true,
    };
    if (conversationId) {
      message.conversationId = conversationId;
    }
    await this.graphFetch('/messages', {
      method: 'POST',
      body: JSON.stringify(message),
    });
    logger.info({ to, subject: subject.slice(0, 60) }, 'Outlook draft created via Graph');
  }

  async searchMessages(query: string, top: number = 20): Promise<GraphEmail[]> {
    const params = new URLSearchParams({
      $search: `"${query}"`,
      $top: String(top),
      $select: 'id,from,subject,body,receivedDateTime,conversationId,categories,hasAttachments',
    });
    const data = await this.graphFetch(`/messages?${params}`);
    return data.value || [];
  }
}

// ---------------------------------------------------------------------------
// Outlook Polling Channel (Graph-based)
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export class OutlookPollingChannel implements Channel {
  name = 'outlook';

  private opts: ChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private connected = false;

  // Credentials
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private email: string;

  constructor(opts: ChannelOpts, pollIntervalMs = 60_000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;

    const envVars = readEnvFile([
      'OUTLOOK_REFRESH_TOKEN',
      'OUTLOOK_TENANT_ID',
      'OUTLOOK_CLIENT_ID',
      'OUTLOOK_CLIENT_SECRET',
      'OUTLOOK_EMAIL',
    ]);
    this.refreshToken =
      process.env.OUTLOOK_REFRESH_TOKEN || envVars.OUTLOOK_REFRESH_TOKEN || '';
    this.tenantId =
      process.env.OUTLOOK_TENANT_ID || envVars.OUTLOOK_TENANT_ID || '';
    this.clientId =
      process.env.OUTLOOK_CLIENT_ID || envVars.OUTLOOK_CLIENT_ID || '';
    this.clientSecret =
      process.env.OUTLOOK_CLIENT_SECRET || envVars.OUTLOOK_CLIENT_SECRET || '';
    this.email = process.env.OUTLOOK_EMAIL || envVars.OUTLOOK_EMAIL || '';
  }

  async connect(): Promise<void> {
    this.connected = true;
    logger.info({ email: this.email }, 'Outlook Graph channel connected');

    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Outlook poll error'))
          .finally(() => {
            if (this.connected) schedulePoll();
          });
      }, backoffMs);
    };

    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, _text: string): Promise<void> {
    logger.warn({ jid }, 'Outlook channel is read-only, cannot send messages');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('outlook:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('Outlook Graph channel stopped');
  }

  // --- Private ---

  private async pollForMessages(): Promise<void> {
    try {
      const accessToken = await getOutlookAccessToken(
        this.tenantId,
        this.clientId,
        this.clientSecret,
        this.refreshToken,
      );

      const client = new OutlookGraphClient(accessToken);

      // Ensure master categories exist on first poll
      await client.ensureMasterCategories(CATEGORY_COLORS);

      const messages = await client.fetchInboxMessages(20);

      const groups = this.opts.registeredGroups();
      const mainEntry = Object.entries(groups).find(
        ([, g]) => g.isMain === true,
      );

      if (!mainEntry) {
        logger.debug('Outlook: no main group registered, skipping emails');
        return;
      }

      const mainJid = mainEntry[0];

      for (const msg of messages) {
        if (isOutlookProcessed(msg.id)) continue;
        markOutlookProcessed(msg.id);

        const fromAddress = msg.from?.emailAddress?.address || '';
        const fromName = msg.from?.emailAddress?.name || fromAddress;
        const bodyText = msg.body?.contentType === 'html'
          ? stripHtml(msg.body.content)
          : msg.body?.content || '';

        // Classify
        const classification = categorizeEmail({
          from: fromAddress,
          subject: msg.subject,
          body: bodyText.slice(0, 500),
        });

        logger.info(
          {
            id: msg.id.slice(0, 20),
            subject: msg.subject.slice(0, 60),
            category: classification.category,
          },
          'Outlook email classified',
        );

        // Tag the email
        const tags = tagEmail(
          msg.id,
          'outlook',
          classification.category,
          fromAddress,
          msg.subject,
        );

        // Set Outlook categories (color tags)
        try {
          await client.setCategories(msg.id, tags);
        } catch (err) {
          logger.warn({ id: msg.id.slice(0, 20), err }, 'Outlook: failed to set categories');
        }

        // Move to folder
        const targetFolder =
          CATEGORY_FOLDERS[classification.category] || 'Annet';
        try {
          const folderId = await client.getOrCreateFolder(targetFolder);
          await client.moveMessage(msg.id, folderId);
        } catch (err) {
          logger.warn(
            { id: msg.id.slice(0, 20), targetFolder, err },
            'Outlook: failed to move email',
          );
        }

        // Only deliver important emails to agent
        if (!isImportant(classification.category)) continue;

        const jid = `outlook:${msg.id}`;
        const timestamp = msg.receivedDateTime || new Date().toISOString();
        const sanitizedContent = sanitizeEmailForAgent({
          from: `${fromName} <${fromAddress}>`,
          subject: msg.subject,
          body: bodyText,
        });

        this.opts.onChatMetadata(
          jid,
          timestamp,
          msg.subject,
          'outlook',
          false,
        );

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
          { mainJid, from: fromName, subject: msg.subject },
          'Outlook email delivered to main group',
        );
      }

      // Cleanup old processed IDs periodically
      if (Math.random() < 0.01) {
        cleanupOldOutlookProcessed(30);
      }

      // Run ignore detection inline
      if (Math.random() < 0.04) {
        const count = processIgnoredEmails(24);
        if (count > 0) {
          logger.info({ count }, 'Processed ignored email deliveries');
        }
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Outlook poll failed',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

registerChannel('outlook', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'OUTLOOK_REFRESH_TOKEN',
    'OUTLOOK_TENANT_ID',
    'OUTLOOK_CLIENT_ID',
    'OUTLOOK_CLIENT_SECRET',
    'OUTLOOK_EMAIL',
  ]);
  const refreshToken =
    process.env.OUTLOOK_REFRESH_TOKEN || envVars.OUTLOOK_REFRESH_TOKEN || '';
  if (!refreshToken) {
    logger.warn('Outlook: OUTLOOK_REFRESH_TOKEN not set, skipping');
    return null;
  }
  return new OutlookPollingChannel(opts);
});
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Compilation errors from `src/ipc.ts`, `src/skills/scan-receipts.ts`, `src/skills/email-actions.ts` (they still import IMAP types). These are fixed in Tasks 4-5.

- [ ] **Step 3: Commit**

```bash
git add src/channels/outlook.ts
git commit -m "feat: replace IMAP with Graph API for Outlook channel"
```

---

### Task 4: Update IPC draft handler for Graph

**Files:**
- Modify: `src/ipc.ts`

- [ ] **Step 1: Update save_outlook_draft IPC handler**

Replace the existing `case 'save_outlook_draft'` block with:

```typescript
case 'save_outlook_draft':
  if (isMain && data.to && data.subject && data.body) {
    try {
      const { getOutlookAccessToken, OutlookGraphClient } = await import('./channels/outlook.js');
      const { readEnvFile } = await import('./env.js');
      const envVars = readEnvFile([
        'OUTLOOK_REFRESH_TOKEN', 'OUTLOOK_TENANT_ID', 'OUTLOOK_CLIENT_ID',
        'OUTLOOK_CLIENT_SECRET',
      ]);
      const tenantId = process.env.OUTLOOK_TENANT_ID || envVars.OUTLOOK_TENANT_ID || '';
      const clientId = process.env.OUTLOOK_CLIENT_ID || envVars.OUTLOOK_CLIENT_ID || '';
      const clientSecret = process.env.OUTLOOK_CLIENT_SECRET || envVars.OUTLOOK_CLIENT_SECRET || '';
      const refreshToken = process.env.OUTLOOK_REFRESH_TOKEN || envVars.OUTLOOK_REFRESH_TOKEN || '';

      const accessToken = await getOutlookAccessToken(tenantId, clientId, clientSecret, refreshToken);
      const client = new OutlookGraphClient(accessToken);
      await client.createDraft(
        data.to as string,
        data.subject as string,
        data.body as string,
        data.conversationId as string | undefined,
      );
      logger.info({ sourceGroup, to: data.to }, 'Outlook draft saved via IPC (Graph)');
    } catch (err) {
      logger.error({ err, sourceGroup }, 'Failed to save Outlook draft via IPC');
    }
  } else if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized save_outlook_draft attempt blocked');
  }
  break;
```

Add `conversationId?: string;` to the data type if not already present.

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: May still have errors from scan-receipts.ts

- [ ] **Step 3: Commit**

```bash
git add src/ipc.ts
git commit -m "feat: update IPC draft handler to use Graph API"
```

---

### Task 5: Update scan-receipts and email-actions for Graph

**Files:**
- Modify: `src/skills/scan-receipts.ts`
- Modify: `src/skills/email-actions.ts`

- [ ] **Step 1: Replace IMAP import and logic in scan-receipts.ts**

Replace the IMAP import:
```typescript
// Remove: import { ImapFlow } from 'imapflow';
```

Replace the `scanOutlook` function to use Graph API:

```typescript
import { getOutlookAccessToken, OutlookGraphClient } from '../channels/outlook.js';

async function scanOutlook(
  days: number,
  receiptsDir: string,
  db: Database.Database,
  errors: string[],
): Promise<{ found: number; processed: number }> {
  const email = process.env.OUTLOOK_EMAIL;
  const tenantId = process.env.OUTLOOK_TENANT_ID;
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
  const refreshToken = process.env.OUTLOOK_REFRESH_TOKEN;

  if (!email || !tenantId || !clientId || !clientSecret || !refreshToken) {
    errors.push('Outlook: missing credentials');
    return { found: 0, processed: 0 };
  }

  let accessToken: string;
  try {
    accessToken = await getOutlookAccessToken(tenantId, clientId, clientSecret, refreshToken);
  } catch (err) {
    errors.push(`Outlook token refresh failed: ${(err as Error).message}`);
    return { found: 0, processed: 0 };
  }

  const client = new OutlookGraphClient(accessToken);

  let found = 0;
  let processed = 0;

  try {
    const messages = await client.searchMessages('receipt OR invoice OR kvittering OR faktura', 50);
    const since = new Date();
    since.setDate(since.getDate() - days);

    for (const msg of messages) {
      const receivedDate = new Date(msg.receivedDateTime);
      if (receivedDate < since) continue;

      found++;
      if (isAlreadyLogged(db, msg.id, 'outlook')) {
        found--;
        continue;
      }

      try {
        const from = msg.from?.emailAddress?.address || '';
        const subject = msg.subject || '';
        const body = msg.body?.contentType === 'html'
          ? msg.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          : msg.body?.content || '';

        const category = categorizeEmail({ from, subject, body });
        if (category.category !== 'kvittering') {
          found--;
          continue;
        }

        const data = extractReceiptData(from, subject, body);
        logReceipt(db, msg.id, 'outlook', data.vendor, data.amount, data.currency, data.date, null);
        processed++;
      } catch (err) {
        errors.push(`Outlook message ${msg.id.slice(0, 20)}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`Outlook Graph search failed: ${(err as Error).message}`);
  }

  return { found, processed };
}
```

Note: The `isAlreadyLogged` function signature needs to accept `string` for uid instead of `number`. Check if it already does — if it uses a TEXT column, it should work. If it strictly expects number, adjust the call.

- [ ] **Step 2: Rewrite email-actions.ts for Graph**

Replace entire file:

```typescript
import { OutlookGraphClient } from '../channels/outlook.js';

const CATEGORY_LABELS: Record<string, string> = {
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  viktig: 'Viktig',
  handling_kreves: 'Handling',
  reklame: 'Reklame',
  annet: 'Annet',
};

export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

export function getCategoryFolder(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

export async function moveOutlookEmail(
  client: OutlookGraphClient,
  messageId: string,
  category: string,
): Promise<void> {
  const folder = getCategoryFolder(category);
  const folderId = await client.getOrCreateFolder(folder);
  await client.moveMessage(messageId, folderId);
}
```

- [ ] **Step 3: Remove imapflow import from scan-receipts.ts**

Make sure the `ImapFlow` import is removed and there are no remaining IMAP references.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Clean — no type errors

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/skills/scan-receipts.ts src/skills/email-actions.ts
git commit -m "feat: migrate scan-receipts and email-actions from IMAP to Graph"
```

---

### Task 6: Remove imapflow dependency + update tests

**Files:**
- Modify: `package.json`
- Modify: `src/channels/outlook.test.ts`
- Modify: `tests/outlook.test.ts`
- Modify: `tests/outlook-idle.test.ts`

- [ ] **Step 1: Remove imapflow from package.json**

Run: `npm uninstall imapflow`

- [ ] **Step 2: Update or remove IMAP-based tests**

Update `src/channels/outlook.test.ts` to test Graph client:

```typescript
import { describe, it, expect } from 'vitest';
import { OutlookGraphClient } from './outlook.js';

describe('OutlookGraphClient', () => {
  it('can be instantiated with an access token', () => {
    const client = new OutlookGraphClient('fake-token');
    expect(client).toBeDefined();
  });
});
```

For `tests/outlook.test.ts` and `tests/outlook-idle.test.ts` — check if they reference IMAP types (`OutlookChannel`, `ImapFlow`). If so, update or remove them. They may already have been written to test the IMAP channel which no longer exists.

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove imapflow dependency, update Outlook tests for Graph"
```

---

### Task 7: Update container email-draft skill for Graph

**Files:**
- Modify: `container/skills/email-draft/SKILL.md`

- [ ] **Step 1: Update Outlook draft IPC format**

In `container/skills/email-draft/SKILL.md`, update the Outlook IPC example to use `conversationId` instead of `inReplyTo`/`references`:

Replace the Outlook section with:

```markdown
### Outlook (magnus@allvit.no)
Skriv en IPC-fil for å lagre som draft:

\`\`\`bash
cat > /workspace/ipc/tasks/draft-$(date +%s).json << 'EOF'
{
  "type": "save_outlook_draft",
  "to": "mottaker@example.com",
  "subject": "Re: Emne",
  "body": "Utkasttekst her",
  "conversationId": "original-conversation-id"
}
EOF
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/email-draft/SKILL.md
git commit -m "docs: update email-draft skill for Graph API draft format"
```

---

### Task 8: Build, test, deploy

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean

- [ ] **Step 3: Deploy**

```bash
git push origin main
ssh root@204.168.178.32 'cd /opt/assistent && git pull && npm install && npm run build && systemctl restart nanoclaw'
```

- [ ] **Step 4: Verify**

```bash
ssh root@204.168.178.32 'sleep 5 && journalctl -u nanoclaw --no-pager -n 30'
```

Expected: "Outlook Graph channel connected", "Outlook email classified" logs, no IMAP errors.
