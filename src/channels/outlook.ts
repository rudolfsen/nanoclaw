import { ImapFlow } from 'imapflow';

export interface OutlookConfig {
  host: string;
  port: number;
  auth: { user: string; pass: string };
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
        { seq: `${Math.max(1, (this.client.mailbox as { exists: number }).exists - limit + 1)}:*` },
        { envelope: true, bodyStructure: true },
      )) {
        messages.push(
          this.parseEmail({
            uid: msg.uid,
            from: msg.envelope?.from?.[0],
            subject: msg.envelope?.subject,
            date: msg.envelope?.date,
          }),
        );
      }
      return messages;
    } finally {
      lock.release();
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
}
