import { ImapFlow } from 'imapflow';

import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';
import { categorizeEmail } from '../skills/email-sorter.js';
import { sanitizeEmailForAgent } from '../skills/email-sanitizer.js';
import { isImportant } from '../skills/email-classifier.js';

const CATEGORY_FOLDERS: Record<string, string> = {
  viktig: 'Viktig',
  handling_kreves: 'Viktig',
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  reklame: 'Reklame',
  annet: 'Annet',
};

/**
 * Fetch an OAuth2 access token from Microsoft using a refresh token.
 */
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
    scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
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

export interface OutlookConfig {
  host: string;
  port: number;
  auth: { user: string; pass: string } | { user: string; accessToken: string };
}

export interface ParsedEmail {
  uid: number;
  from: string;
  subject: string;
  body: string;
  date: Date;
  hasAttachments: boolean;
}

export interface RawEmailInput {
  uid: number;
  from?: { address?: string; name?: string };
  subject?: string;
  text?: string;
  date?: Date;
  attachments?: unknown[];
}

/**
 * IMAP-based read-only channel for Outlook/Office365.
 *
 * This does NOT implement the NanoClaw Channel interface because IMAP is
 * ingest-only — there is no sendMessage or JID-based routing. Messages
 * fetched here are forwarded to the agent via other channels (Telegram/Slack).
 */
export class OutlookChannel {
  public readonly name = 'outlook';
  private config: OutlookConfig;
  private client: ImapFlow | null = null;
  private onError?: (error: Error) => void;

  constructor(config: OutlookConfig) {
    this.config = config;
  }

  setErrorHandler(handler: (error: Error) => void): void {
    this.onError = handler;
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

  parseEmail(raw: RawEmailInput): ParsedEmail {
    return {
      uid: raw.uid,
      from: raw.from?.address || '',
      subject: raw.subject || '',
      body: raw.text || '',
      date: raw.date || new Date(),
      hasAttachments: !!(raw.attachments && raw.attachments.length > 0),
    };
  }

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
        let bodyText = '';
        if (msg.source) {
          const raw = msg.source.toString();
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

  async createFolderIfMissing(folderName: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.mailboxCreate(folderName);
    } catch {
      // Folder already exists — ignore
    }
  }

  async moveToFolder(
    uid: number,
    targetFolder: string,
    sourceFolder: string = 'INBOX',
  ): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock(sourceFolder);
    try {
      await this.client.messageMove(uid.toString(), targetFolder);
    } finally {
      lock.release();
    }
  }

  async reconnectWithRetry(
    maxRetries: number = 5,
    delayMs: number = 5000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.disconnect();
        await this.connect();
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async startIdleWatch(
    folder: string,
    onNewMail: (email: ParsedEmail) => void,
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

  async markAsRead(uid: number, folder: string = 'INBOX'): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const lock = await this.client.getMailboxLock(folder);
    try {
      await this.client.messageFlagsAdd(uid.toString(), ['\\Seen'], {
        uid: true,
      });
    } finally {
      lock.release();
    }
  }
}

// ---------------------------------------------------------------------------
// OutlookPollingChannel — implements the NanoClaw Channel interface
// ---------------------------------------------------------------------------

export class OutlookPollingChannel implements Channel {
  name = 'outlook';

  private opts: ChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedUids = new Set<number>();
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
    logger.info({ email: this.email }, 'Outlook polling channel connected');

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
    logger.info('Outlook polling channel stopped');
  }

  // --- Private ---

  private async pollForMessages(): Promise<void> {
    let channel: OutlookChannel | null = null;
    try {
      const accessToken = await getOutlookAccessToken(
        this.tenantId,
        this.clientId,
        this.clientSecret,
        this.refreshToken,
      );

      channel = new OutlookChannel({
        host: 'outlook.office365.com',
        port: 993,
        auth: { user: this.email, accessToken },
      });
      await channel.connect();

      const emails = await channel.fetchRecent('INBOX', 20);

      const groups = this.opts.registeredGroups();
      const mainEntry = Object.entries(groups).find(
        ([, g]) => g.isMain === true,
      );

      if (!mainEntry) {
        logger.debug('Outlook: no main group registered, skipping emails');
        return;
      }

      const mainJid = mainEntry[0];

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
    } finally {
      if (channel) {
        try {
          await channel.disconnect();
        } catch {
          // ignore disconnect errors
        }
      }
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
