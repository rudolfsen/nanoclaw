import { describe, it, expect } from 'vitest';
import { processReceipt } from '../src/skills/receipt-collector';
import fs from 'fs';

describe('Receipt Processing Pipeline', () => {
  const testDir = '/tmp/test-receipts-pipeline';

  it('should save PDF attachment directly', async () => {
    const path = await processReceipt(
      'billing@service.com',
      'Invoice',
      'Your invoice',
      [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf' }],
      testDir
    );
    expect(fs.existsSync(path)).toBe(true);
    expect(path).toContain('invoice.pdf');
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should generate PDF from inline receipt', async () => {
    const path = await processReceipt(
      'noreply@facebookmail.com',
      'Your receipt from Meta',
      'Amount: 1,500.00 NOK\nDate: 2026-03-19\nInvoice ID: INV-001',
      [],
      testDir
    );
    expect(fs.existsSync(path)).toBe(true);
    expect(path).toContain('meta.pdf');
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});
