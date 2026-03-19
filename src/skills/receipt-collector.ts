import { ReceiptData, generateReceiptPdf } from './receipt-pdf.js';
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
  const hasReceiptAttachment =
    email.attachments?.some(
      (a) =>
        a.contentType === 'application/pdf' &&
        /invoice|receipt|faktura|kvittering/i.test(a.filename),
    ) ?? false;

  const hasReceiptSubject =
    /receipt|invoice|faktura|kvittering|payment.*confirm/i.test(email.subject);

  return hasReceiptAttachment || hasReceiptSubject;
}

export function extractReceiptData(
  from: string,
  subject: string,
  body: string,
): ReceiptData {
  const domain = from.split('@')[1] || '';
  const vendor = VENDOR_MAP[domain] || domain;

  const amountMatch =
    body.match(
      /(?:amount|beløp|total|charged)[:\s]*([0-9,]+(?:\.[0-9]{2})?)\s*(NOK|USD|EUR)?/i,
    ) || body.match(/(NOK|USD|EUR)\s*([0-9,]+(?:\.[0-9]{2})?)/i);

  let amount = 0;
  let currency = 'NOK';
  if (amountMatch) {
    const amountStr = (amountMatch[1] || amountMatch[2]).replace(/,/g, '');
    amount = parseFloat(amountStr);
    currency = (amountMatch[2] || amountMatch[1] || 'NOK').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) currency = 'NOK';
  }

  const dateMatch = body.match(
    /(?:date|dato)[:\s]*([A-Za-z]+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})/i,
  );
  const date = dateMatch
    ? dateMatch[1]
    : new Date().toISOString().split('T')[0];

  const refMatch = body.match(
    /(?:invoice|referanse|ref|id)[:\s#]*([A-Z0-9-]+)/i,
  );
  const reference = refMatch ? refMatch[1] : undefined;

  return { vendor, amount, currency, date, reference };
}

export async function processReceipt(
  from: string,
  subject: string,
  body: string,
  attachments: { filename: string; content: Buffer; contentType: string }[],
  receiptsDir: string,
): Promise<string> {
  fs.mkdirSync(receiptsDir, { recursive: true });

  const pdfAttachment = attachments.find(
    (a) => a.contentType === 'application/pdf',
  );

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
