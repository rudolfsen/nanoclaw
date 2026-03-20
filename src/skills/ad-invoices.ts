import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { initSkillTables } from '../db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdInvoiceResult {
  found: number;
  downloaded: number;
  errors: string[];
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
  externalId: string,
  source: string,
): boolean {
  const row = db
    .prepare(
      'SELECT id FROM receipts WHERE email_uid = ? AND source = ? LIMIT 1',
    )
    .get(externalId, source) as { id: number } | undefined;
  return !!row;
}

function logReceipt(
  db: Database.Database,
  externalId: string,
  source: string,
  vendor: string,
  amount: number,
  currency: string,
  date: string,
  pdfPath: string,
): void {
  db.prepare(
    `INSERT INTO receipts (email_uid, source, vendor, amount, currency, date, pdf_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(externalId, source, vendor, amount, currency, date, pdfPath);
}

// ---------------------------------------------------------------------------
// Meta Business Invoices
// ---------------------------------------------------------------------------

interface MetaInvoice {
  id: string;
  entity_name?: string;
  amount?: number | string;
  currency?: string;
  invoice_date?: string;
  download_url?: string;
}

async function downloadPdf(
  url: string,
  headers: Record<string, string>,
): Promise<Buffer> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function fetchMetaInvoices(options: {
  days?: number;
  receiptsDir?: string;
}): Promise<AdInvoiceResult> {
  const days = options.days ?? 90;
  const receiptsDir =
    options.receiptsDir ?? path.resolve(process.cwd(), 'receipts');
  const dbPath = path.resolve(process.cwd(), 'store', 'messages.db');

  const accessToken = process.env.META_ACCESS_TOKEN;
  const businessId = process.env.META_BUSINESS_ID;

  const errors: string[] = [];

  if (!accessToken || !businessId) {
    errors.push(
      'Meta: missing META_ACCESS_TOKEN or META_BUSINESS_ID env vars',
    );
    return { found: 0, downloaded: 0, errors };
  }

  fs.mkdirSync(receiptsDir, { recursive: true });
  const db = openDb(dbPath);

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const toYMD = (d: Date) => d.toISOString().split('T')[0];
  const startDateStr = toYMD(startDate);
  const endDateStr = toYMD(endDate);

  const url = new URL(
    `https://graph.facebook.com/v25.0/${businessId}/business_invoices`,
  );
  url.searchParams.set('start_date', startDateStr);
  url.searchParams.set('end_date', endDateStr);

  let invoices: MetaInvoice[] = [];
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      errors.push(
        `Meta API error ${res.status}: ${body.slice(0, 200)}`,
      );
      db.close();
      return { found: 0, downloaded: 0, errors };
    }
    const json = (await res.json()) as { data?: MetaInvoice[] };
    invoices = json.data || [];
  } catch (err) {
    errors.push(`Meta API request failed: ${(err as Error).message}`);
    db.close();
    return { found: 0, downloaded: 0, errors };
  }

  const found = invoices.length;
  let downloaded = 0;

  for (const invoice of invoices) {
    const externalId = invoice.id;
    if (isAlreadyLogged(db, externalId, 'meta')) continue;

    try {
      const invoiceDate =
        invoice.invoice_date ?? toYMD(new Date());
      const vendor = 'Meta';
      const amount =
        typeof invoice.amount === 'string'
          ? parseFloat(invoice.amount)
          : (invoice.amount ?? 0);
      const currency = (invoice.currency ?? 'USD').toUpperCase();

      // Determine PDF download URL
      const pdfUrl =
        invoice.download_url ||
        `https://www.facebook.com/ads/manage/billing_transactions/invoice/?business_id=${businessId}&invoice_id=${externalId}`;

      const pdfBuffer = await downloadPdf(pdfUrl, {
        Authorization: `Bearer ${accessToken}`,
      });

      const filename = `${invoiceDate}-meta.pdf`;
      const pdfPath = path.join(receiptsDir, filename);
      fs.writeFileSync(pdfPath, pdfBuffer);

      logReceipt(
        db,
        externalId,
        'meta',
        vendor,
        amount,
        currency,
        invoiceDate,
        pdfPath,
      );
      downloaded++;
    } catch (err) {
      errors.push(
        `Meta invoice ${externalId}: ${(err as Error).message}`,
      );
    }
  }

  db.close();
  return { found, downloaded, errors };
}

// ---------------------------------------------------------------------------
// Snapchat Invoices
// ---------------------------------------------------------------------------

interface SnapTokenResponse {
  access_token: string;
  expires_in?: number;
}

interface SnapInvoiceSummary {
  id: string;
}

interface SnapInvoiceDetail {
  id: string;
  name?: string;
  currency?: string;
  total_amount?: number | string;
  invoice_date?: string;
  start_date?: string;
  pdf_download_url?: string;
  pdf?: string; // base64 encoded PDF
}

async function refreshSnapToken(): Promise<string> {
  const clientId = process.env.SNAP_CLIENT_ID;
  const clientSecret = process.env.SNAP_CLIENT_SECRET;
  const refreshToken = process.env.SNAP_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing SNAP_CLIENT_ID, SNAP_CLIENT_SECRET, or SNAP_REFRESH_TOKEN',
    );
  }

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const res = await fetch(
    'https://accounts.snapchat.com/login/oauth2/access_token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Snap token refresh failed (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as SnapTokenResponse;
  if (!json.access_token) {
    throw new Error('Snap token refresh: no access_token in response');
  }
  return json.access_token;
}

export async function fetchSnapInvoices(options: {
  days?: number;
  receiptsDir?: string;
}): Promise<AdInvoiceResult> {
  const days = options.days ?? 90;
  const receiptsDir =
    options.receiptsDir ?? path.resolve(process.cwd(), 'receipts');
  const dbPath = path.resolve(process.cwd(), 'store', 'messages.db');

  const adAccountId = process.env.SNAP_AD_ACCOUNT_ID;
  const errors: string[] = [];

  if (!adAccountId) {
    errors.push('Snap: missing SNAP_AD_ACCOUNT_ID env var');
    return { found: 0, downloaded: 0, errors };
  }

  // Refresh token (Snap tokens expire every 30 min)
  let accessToken: string;
  try {
    accessToken = await refreshSnapToken();
  } catch (err) {
    errors.push(`Snap token refresh: ${(err as Error).message}`);
    return { found: 0, downloaded: 0, errors };
  }

  fs.mkdirSync(receiptsDir, { recursive: true });
  const db = openDb(dbPath);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  // Step 1: List invoices
  let invoiceSummaries: SnapInvoiceSummary[] = [];
  try {
    const listUrl = `https://adsapi.snapchat.com/v1/adaccounts/${adAccountId}/invoices`;
    const res = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      errors.push(`Snap list invoices error ${res.status}: ${body.slice(0, 200)}`);
      db.close();
      return { found: 0, downloaded: 0, errors };
    }
    const json = (await res.json()) as {
      invoices?: Array<{ invoice?: SnapInvoiceSummary }>;
      request_status?: string;
    };
    // Snap API wraps items: { invoices: [{ invoice: { id, ... } }] }
    invoiceSummaries = (json.invoices || [])
      .map((item) => item.invoice)
      .filter((inv): inv is SnapInvoiceSummary => !!inv);
  } catch (err) {
    errors.push(`Snap list invoices request failed: ${(err as Error).message}`);
    db.close();
    return { found: 0, downloaded: 0, errors };
  }

  const found = invoiceSummaries.length;
  let downloaded = 0;

  for (const summary of invoiceSummaries) {
    const externalId = summary.id;
    if (isAlreadyLogged(db, externalId, 'snap')) continue;

    try {
      // Step 2: Fetch invoice detail with PDF
      const detailUrl = `https://adsapi.snapchat.com/v1/adaccounts/${adAccountId}/invoices/${externalId}?include_pdf=true`;
      const detailRes = await fetch(detailUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!detailRes.ok) {
        const body = await detailRes.text();
        throw new Error(
          `Snap invoice detail ${detailRes.status}: ${body.slice(0, 200)}`,
        );
      }
      const detailJson = (await detailRes.json()) as {
        invoices?: Array<{ invoice?: SnapInvoiceDetail }>;
      };
      const invoiceDetail = detailJson.invoices?.[0]?.invoice;
      if (!invoiceDetail) {
        throw new Error('No invoice detail in response');
      }

      const invoiceDate =
        invoiceDetail.invoice_date ||
        invoiceDetail.start_date ||
        new Date().toISOString().split('T')[0];
      const dateStr = invoiceDate.split('T')[0];

      // Check cutoff date
      if (new Date(dateStr) < cutoffDate) continue;

      const amount =
        typeof invoiceDetail.total_amount === 'string'
          ? parseFloat(invoiceDetail.total_amount)
          : (invoiceDetail.total_amount ?? 0);
      const currency = (invoiceDetail.currency ?? 'USD').toUpperCase();
      const vendor = 'Snap';

      const filename = `${dateStr}-snap.pdf`;
      const pdfPath = path.join(receiptsDir, filename);

      if (invoiceDetail.pdf) {
        // Base64 encoded PDF in response
        const pdfBuffer = Buffer.from(invoiceDetail.pdf, 'base64');
        fs.writeFileSync(pdfPath, pdfBuffer);
      } else if (invoiceDetail.pdf_download_url) {
        const pdfBuffer = await downloadPdf(invoiceDetail.pdf_download_url, {
          Authorization: `Bearer ${accessToken}`,
        });
        fs.writeFileSync(pdfPath, pdfBuffer);
      } else {
        throw new Error('No PDF data or download URL in invoice detail');
      }

      logReceipt(
        db,
        externalId,
        'snap',
        vendor,
        amount,
        currency,
        dateStr,
        pdfPath,
      );
      downloaded++;
    } catch (err) {
      errors.push(`Snap invoice ${externalId}: ${(err as Error).message}`);
    }
  }

  db.close();
  return { found, downloaded, errors };
}
