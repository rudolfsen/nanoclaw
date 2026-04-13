import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { google } from 'googleapis';
import {
  getOutlookAccessToken,
  OutlookGraphClient,
} from '../channels/outlook.js';
import { initSkillTables } from '../db.js';
import { categorizeEmail } from './email-sorter.js';
import {
  extractReceiptData,
  isReceiptEmail,
  processReceipt,
} from './receipt-collector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanReceiptsResult {
  found: number;
  processed: number;
  errors: string[];
}

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initSkillTables(db);
  return db;
}

function isAlreadyLogged(
  db: Database.Database,
  emailUid: number | string,
  source: string,
): boolean {
  const row = db
    .prepare(
      'SELECT id FROM receipts WHERE email_uid = ? AND source = ? LIMIT 1',
    )
    .get(String(emailUid), source) as { id: number } | undefined;
  return !!row;
}

function logReceipt(
  db: Database.Database,
  emailUid: number | string,
  source: string,
  vendor: string,
  amount: number,
  currency: string,
  date: string,
  pdfPath: string | null,
): void {
  db.prepare(
    `INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(String(emailUid), source, vendor, amount, currency, date, pdfPath);
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

async function scanGmail(
  days: number,
  receiptsDir: string,
  db: Database.Database,
  errors: string[],
): Promise<{ found: number; processed: number }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    errors.push(
      'Gmail: missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN',
    );
    return { found: 0, processed: 0 };
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const query = `subject:(receipt OR invoice OR kvittering OR faktura) newer_than:${days}d`;

  let messages: { id?: string | null }[] = [];
  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50,
    });
    messages = res.data.messages || [];
  } catch (err) {
    errors.push(`Gmail list failed: ${(err as Error).message}`);
    return { found: 0, processed: 0 };
  }

  let found = messages.length;
  let processed = 0;

  for (const stub of messages) {
    if (!stub.id) continue;

    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: stub.id,
        format: 'full',
      });

      const headers = msg.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value || '';

      const from = getHeader('From');
      const subject = getHeader('Subject');

      // Use message ID as uid (numeric hash for the receipts table integer column)
      const emailUid = stub.id;

      if (isAlreadyLogged(db, emailUid, 'gmail')) continue;

      // Extract body text
      const body = extractGmailBody(msg.data.payload);

      // Check if it's actually a receipt via categorizer
      const category = categorizeEmail({ from, subject, body });
      if (category.category !== 'kvittering') {
        found--;
        continue;
      }

      // Gather PDF attachments
      const attachments: EmailAttachment[] = [];
      await collectGmailAttachments(
        gmail,
        stub.id,
        msg.data.payload,
        attachments,
      );

      if (
        !isReceiptEmail({
          from,
          subject,
          attachments: attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
          })),
        })
      ) {
        // categorizer said receipt but isReceiptEmail is more strict — still process
        // based on categorizer result alone
      }

      const pdfPath = await processReceipt(
        from,
        subject,
        body,
        attachments,
        receiptsDir,
      );
      const data = extractReceiptData(from, subject, body);
      logReceipt(
        db,
        emailUid,
        'gmail',
        data.vendor,
        data.amount,
        data.currency,
        data.date,
        pdfPath,
      );
      processed++;
    } catch (err) {
      errors.push(`Gmail message ${stub.id}: ${(err as Error).message}`);
    }
  }

  return { found, processed };
}

function extractGmailBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      const text = extractGmailBody(part);
      if (text) return text;
    }
  }
  return '';
}

async function collectGmailAttachments(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  payload: any,
  out: EmailAttachment[],
): Promise<void> {
  if (!payload) return;

  if (payload.filename && payload.body) {
    const contentType: string = payload.mimeType || '';
    if (
      contentType === 'application/pdf' ||
      /invoice|receipt|faktura|kvittering/i.test(payload.filename)
    ) {
      let content: Buffer;
      if (payload.body.data) {
        content = Buffer.from(payload.body.data, 'base64');
      } else if (payload.body.attachmentId) {
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: payload.body.attachmentId,
        });
        content = Buffer.from(att.data.data || '', 'base64');
      } else {
        return;
      }
      out.push({ filename: payload.filename, content, contentType });
    }
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      await collectGmailAttachments(gmail, messageId, part, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Outlook
// ---------------------------------------------------------------------------

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
    accessToken = await getOutlookAccessToken(
      tenantId,
      clientId,
      clientSecret,
      refreshToken,
    );
  } catch (err) {
    errors.push(`Outlook token refresh failed: ${(err as Error).message}`);
    return { found: 0, processed: 0 };
  }

  const client = new OutlookGraphClient(accessToken);

  let found = 0;
  let processed = 0;

  try {
    const messages = await client.searchMessages(
      'receipt OR invoice OR kvittering OR faktura',
      50,
    );
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
        const body =
          msg.body?.contentType === 'html'
            ? msg.body.content
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
            : msg.body?.content || '';

        const category = categorizeEmail({ from, subject, body });
        if (category.category !== 'kvittering') {
          found--;
          continue;
        }

        const data = extractReceiptData(from, subject, body);
        logReceipt(
          db,
          msg.id,
          'outlook',
          data.vendor,
          data.amount,
          data.currency,
          data.date,
          null,
        );
        processed++;
      } catch (err) {
        errors.push(
          `Outlook message ${msg.id.slice(0, 20)}: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    errors.push(`Outlook Graph search failed: ${(err as Error).message}`);
  }

  return { found, processed };
}

/**
 * Very basic plain-text extractor for raw RFC 2822 messages.
 * Decodes base64 and quoted-printable text/plain parts.
 */
function extractPlainTextFromRaw(raw: string): string {
  const boundary = extractBoundary(raw);
  if (!boundary) {
    // Single-part message — take body after double CRLF
    const bodyStart = raw.indexOf('\r\n\r\n');
    if (bodyStart === -1) return raw;
    return decodeBody(raw.slice(bodyStart + 4), detectEncoding(raw));
  }

  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    if (/content-type:\s*text\/plain/i.test(part)) {
      const bodyStart = part.indexOf('\r\n\r\n');
      if (bodyStart === -1) continue;
      return decodeBody(part.slice(bodyStart + 4), detectEncoding(part));
    }
  }
  return '';
}

function extractBoundary(raw: string): string | null {
  const m = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  return m ? m[1] : null;
}

function detectEncoding(part: string): string {
  const m = part.match(/content-transfer-encoding:\s*(\S+)/i);
  return m ? m[1].toLowerCase() : '7bit';
}

function decodeBody(body: string, encoding: string): string {
  const trimmed = body.replace(/--[^\r\n]*--\s*$/, '').trim();
  if (encoding === 'base64') {
    try {
      return Buffer.from(trimmed.replace(/\s/g, ''), 'base64').toString(
        'utf-8',
      );
    } catch {
      return trimmed;
    }
  }
  if (encoding === 'quoted-printable') {
    return trimmed
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  }
  return trimmed;
}

function extractAttachmentsFromRaw(raw: string, out: EmailAttachment[]): void {
  const boundary = extractBoundary(raw);
  if (!boundary) return;

  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    const contentTypeMatch = part.match(/content-type:\s*([^\r\n;]+)/i);
    const filenameMatch = part.match(/filename="?([^"\r\n]+)"?/i);
    if (!contentTypeMatch || !filenameMatch) continue;

    const contentType = contentTypeMatch[1].trim();
    const filename = filenameMatch[1].trim();

    if (contentType !== 'application/pdf') continue;

    const bodyStart = part.indexOf('\r\n\r\n');
    if (bodyStart === -1) continue;

    const encoding = detectEncoding(part);
    const rawBody = part
      .slice(bodyStart + 4)
      .replace(/--[^\r\n]*--\s*$/, '')
      .trim();

    let content: Buffer;
    if (encoding === 'base64') {
      try {
        content = Buffer.from(rawBody.replace(/\s/g, ''), 'base64');
      } catch {
        continue;
      }
    } else {
      content = Buffer.from(rawBody, 'utf-8');
    }

    out.push({ filename, content, contentType });
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function scanReceipts(options?: {
  days?: number;
}): Promise<ScanReceiptsResult> {
  const days = options?.days ?? 7;
  const dbPath = path.resolve(process.cwd(), 'store', 'messages.db');
  const receiptsDir = path.resolve(process.cwd(), 'receipts');

  fs.mkdirSync(receiptsDir, { recursive: true });

  const db = openDb(dbPath);
  const errors: string[] = [];

  const [gmailResult, outlookResult] = await Promise.allSettled([
    scanGmail(days, receiptsDir, db, errors),
    scanOutlook(days, receiptsDir, db, errors),
  ]);

  let found = 0;
  let processed = 0;

  if (gmailResult.status === 'fulfilled') {
    found += gmailResult.value.found;
    processed += gmailResult.value.processed;
  } else {
    errors.push(`Gmail scan threw: ${gmailResult.reason}`);
  }

  if (outlookResult.status === 'fulfilled') {
    found += outlookResult.value.found;
    processed += outlookResult.value.processed;
  } else {
    errors.push(`Outlook scan threw: ${outlookResult.reason}`);
  }

  db.close();
  return { found, processed, errors };
}
