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
        { envelope: true, bodyStructure: true },
      )) {
        messages.push(
          this.parseEmail({
            uid: msg.uid,
            from: msg.envelope.from?.[0],
            subject: msg.envelope.subject,
            date: msg.envelope.date,
          }),
        );
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
