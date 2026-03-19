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
