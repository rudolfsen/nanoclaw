import { describe, it, expect } from 'vitest';
import { extractReceiptData, isReceiptEmail } from '../src/skills/receipt-collector';

describe('Receipt Collector', () => {
  it('should extract receipt data from Meta email body', () => {
    const body = `
      Payment confirmation
      Amount: 1,500.00 NOK
      Date: March 19, 2026
      Ad Account: My Business
      Invoice ID: INV-2026-0319
    `;
    const data = extractReceiptData('noreply@facebookmail.com', 'Your receipt', body);
    expect(data.vendor).toBe('Meta');
    expect(data.amount).toBe(1500.00);
    expect(data.currency).toBe('NOK');
  });

  it('should detect attachment-based receipts', () => {
    const email = {
      from: 'billing@service.com',
      subject: 'Invoice attached',
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf' }],
    };
    expect(isReceiptEmail(email)).toBe(true);
  });

  it('should not flag non-receipt emails', () => {
    const email = {
      from: 'person@company.com',
      subject: 'Meeting notes',
      attachments: [],
    };
    expect(isReceiptEmail(email)).toBe(false);
  });
});
