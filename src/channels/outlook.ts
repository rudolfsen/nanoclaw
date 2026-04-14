import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  isOutlookProcessed,
  markOutlookProcessed,
  cleanupOldOutlookProcessed,
  recordEmailDelivery,
  processIgnoredEmails,
  lookupLearnedSender,
  saveLearnedSender,
} from '../db.js';
import { Channel } from '../types.js';
import { categorizeEmail } from '../skills/email-sorter.js';
import { sanitizeEmailForAgent } from '../skills/email-sanitizer.js';
import { isImportant } from '../skills/email-classifier.js';
import { tagEmail } from '../skills/email-tagger.js';
import { classifyEmailWithAI } from '../skills/email-ai-classifier.js';
import { EMAIL_CLASSIFICATION_ENABLED } from '../config.js';

export function getGraphBase(sharedMailbox?: string): string {
  if (sharedMailbox) {
    return `https://graph.microsoft.com/v1.0/users/${sharedMailbox}`;
  }
  return 'https://graph.microsoft.com/v1.0/me';
}

const CATEGORY_FOLDERS: Record<string, string> = {
  viktig: 'Viktig',
  handling_kreves: 'Viktig',
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  reklame: 'Reklame',
  annet: 'Annet',
};

const CATEGORY_COLORS: Record<string, string> = {
  Viktig: 'preset0',
  Kvitteringer: 'preset4',
  Nyhetsbrev: 'preset7',
  Reklame: 'preset14',
  Annet: 'preset9',
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
    scope:
      'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/MailboxSettings.ReadWrite offline_access',
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

export interface DraftOptions {
  to: string;
  subject: string;
  body: string;
  conversationId?: string;
  fromAddress?: string;
}

export function buildDraftMessage(opts: DraftOptions): Record<string, any> {
  const message: Record<string, any> = {
    subject: opts.subject,
    body: { contentType: 'text', content: opts.body },
    toRecipients: [{ emailAddress: { address: opts.to } }],
    isDraft: true,
  };
  if (opts.conversationId) {
    message.conversationId = opts.conversationId;
  }
  if (opts.fromAddress) {
    message.from = { emailAddress: { address: opts.fromAddress } };
  }
  return message;
}

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
      $select:
        'id,from,subject,body,receivedDateTime,conversationId,categories,hasAttachments',
      $orderby: 'receivedDateTime desc',
    });
    const data = await this.graphFetch(`/mailFolders/Inbox/messages?${params}`);
    return data.value || [];
  }

  async getOrCreateFolder(displayName: string): Promise<string> {
    const cached = this.folderCache.get(displayName);
    if (cached) return cached;

    if (this.folderCache.size === 0) {
      const data = await this.graphFetch('/mailFolders?$top=50');
      for (const f of data.value || []) {
        this.folderCache.set(f.displayName, f.id);
      }
      const found = this.folderCache.get(displayName);
      if (found) return found;
    }

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

  async ensureMasterCategories(
    categories: Record<string, string>,
  ): Promise<void> {
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

  async createDraft(opts: DraftOptions): Promise<void> {
    const message = buildDraftMessage(opts);
    await this.graphFetch('/messages', {
      method: 'POST',
      body: JSON.stringify(message),
    });
    logger.info(
      {
        to: opts.to,
        from: opts.fromAddress,
        subject: opts.subject.slice(0, 60),
      },
      'Outlook draft created via Graph',
    );
  }

  async searchMessages(query: string, top: number = 20): Promise<GraphEmail[]> {
    const params = new URLSearchParams({
      $search: `"${query}"`,
      $top: String(top),
      $select:
        'id,from,subject,body,receivedDateTime,conversationId,categories,hasAttachments',
    });
    const data = await this.graphFetch(`/messages?${params}`);
    return data.value || [];
  }
}

// ---------------------------------------------------------------------------
// HTML to text helper
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

// ---------------------------------------------------------------------------
// Outlook Polling Channel (Graph-based)
// ---------------------------------------------------------------------------

export class OutlookPollingChannel implements Channel {
  name = 'outlook';

  private opts: ChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private connected = false;

  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private email: string;
  private sharedMailbox: string | undefined;

  constructor(opts: ChannelOpts, pollIntervalMs = 60_000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;

    const envVars = readEnvFile([
      'OUTLOOK_REFRESH_TOKEN',
      'OUTLOOK_TENANT_ID',
      'OUTLOOK_CLIENT_ID',
      'OUTLOOK_CLIENT_SECRET',
      'OUTLOOK_EMAIL',
      'OUTLOOK_SHARED_MAILBOX',
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
    const sharedMailbox =
      process.env.OUTLOOK_SHARED_MAILBOX ||
      envVars.OUTLOOK_SHARED_MAILBOX ||
      '';
    this.sharedMailbox = sharedMailbox || undefined;
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

  private async pollForMessages(): Promise<void> {
    try {
      const accessToken = await getOutlookAccessToken(
        this.tenantId,
        this.clientId,
        this.clientSecret,
        this.refreshToken,
      );
      const client = new OutlookGraphClient(
        accessToken,
        getGraphBase(this.sharedMailbox),
      );

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

        // Check DB for learned sender first (overrides pattern matcher)
        const learned = lookupLearnedSender(fromAddress);
        let classification;
        if (learned && learned.confidence >= 0.85) {
          classification = {
            category: learned.category as
              | 'viktig'
              | 'handling_kreves'
              | 'kvittering'
              | 'nyhetsbrev'
              | 'reklame'
              | 'annet',
            confidence: learned.confidence,
            needsAI: false,
          };
        } else {
          classification = categorizeEmail({
            from: fromAddress,
            subject: msg.subject,
            body: bodyText.slice(0, 500),
          });
        }

        // AI fallback for ambiguous emails
        if (classification.needsAI) {
          if (learned && learned.confidence >= 0.7) {
            classification = {
              category: learned.category as typeof classification.category,
              confidence: learned.confidence,
              needsAI: false,
            };
          } else {
            // Call Claude to classify
            const aiResult = await classifyEmailWithAI(
              fromAddress,
              msg.subject,
              bodyText,
            );
            classification = {
              category: aiResult.category,
              confidence: aiResult.confidence,
              needsAI: false,
            };
            // Save for future lookups
            saveLearnedSender(
              fromAddress,
              aiResult.category,
              aiResult.confidence,
            );
          }
        }

        logger.info(
          {
            id: msg.id.slice(0, 20),
            subject: msg.subject.slice(0, 60),
            category: classification.category,
            ai: classification.confidence < 0.7,
          },
          'Outlook email classified',
        );

        const tags = tagEmail(
          msg.id,
          'outlook',
          classification.category,
          fromAddress,
          msg.subject,
        );

        try {
          await client.setCategories(msg.id, tags);
        } catch (err) {
          logger.warn(
            { id: msg.id.slice(0, 20), err },
            'Outlook: failed to set categories',
          );
        }

        // Move kvitteringer and nyhetsbrev out of inbox, keep viktig visible
        const moveCategories: Record<string, string> = {
          kvittering: 'Kvitteringer',
          nyhetsbrev: 'Nyhetsbrev',
          reklame: 'Reklame',
        };
        const moveTarget = moveCategories[classification.category];
        if (moveTarget) {
          try {
            const folderId = await client.getOrCreateFolder(moveTarget);
            await client.moveMessage(msg.id, folderId);
          } catch (err) {
            logger.warn(
              { id: msg.id.slice(0, 20), folder: moveTarget, err },
              'Outlook: failed to move email',
            );
          }
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
          { mainJid, from: fromName, subject: msg.subject },
          'Outlook email delivered to main group',
        );
      }

      if (Math.random() < 0.01) {
        cleanupOldOutlookProcessed(30);
      }

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
