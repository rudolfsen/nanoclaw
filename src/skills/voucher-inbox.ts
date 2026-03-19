import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getPendingReceipts, markReceiptSent } from './regnskapsbot-bridge.js';
import { initSkillTables } from '../db.js';

const DEFAULT_BACKEND_URL =
  'https://numra-regnskap-backend.up.railway.app';

export async function pushReceiptsToVoucherInbox(options?: {
  backendUrl?: string;
  tenantId?: string;
  dbPath?: string;
}): Promise<{ pushed: number; skipped: number; errors: string[] }> {
  const backendUrl =
    options?.backendUrl ||
    process.env.REGNSKAPSBOT_URL ||
    DEFAULT_BACKEND_URL;

  const tenantId = options?.tenantId || process.env.TENANT_ID || 'allvit';

  const dbPath =
    options?.dbPath || path.resolve(process.cwd(), 'store', 'messages.db');

  const db = new Database(dbPath);
  initSkillTables(db);

  const receipts = getPendingReceipts(db);

  let pushed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const receipt of receipts) {
    try {
      if (!receipt.pdf_path) {
        errors.push(`Receipt ${receipt.id}: no pdf_path, skipping`);
        continue;
      }

      if (!fs.existsSync(receipt.pdf_path)) {
        errors.push(
          `Receipt ${receipt.id}: file not found at ${receipt.pdf_path}`,
        );
        continue;
      }

      const fileContent = fs.readFileSync(receipt.pdf_path);
      const filename = path.basename(receipt.pdf_path);

      // Build multipart form data
      const formData = new FormData();
      const blob = new Blob([fileContent], { type: 'application/pdf' });
      formData.append('file', blob, filename);

      const response = await fetch(
        `${backendUrl}/api/v1/vouchers/upload-async`,
        {
          method: 'POST',
          headers: {
            'X-Tenant-Id': tenantId,
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const text = await response.text();
        errors.push(
          `Receipt ${receipt.id}: upload failed (${response.status}): ${text}`,
        );
        continue;
      }

      const result = (await response.json()) as {
        item_id: string | null;
        status: string;
        message?: string;
      };

      if (result.status === 'duplicate') {
        skipped++;
        markReceiptSent(db, receipt.id);
        continue;
      }

      markReceiptSent(db, receipt.id);
      pushed++;
    } catch (err) {
      errors.push(`Receipt ${receipt.id}: ${(err as Error).message}`);
    }
  }

  db.close();
  return { pushed, skipped, errors };
}
