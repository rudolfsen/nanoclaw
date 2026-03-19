import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getPendingReceipts, markReceiptSent } from './regnskapsbot-bridge.js';
import { initSkillTables } from '../db.js';

const DEFAULT_BACKEND_URL = 'https://numra-regnskap-backend.up.railway.app';

async function wakeBackend(backendUrl: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(`${backendUrl}/`, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function pushReceiptsToVoucherInbox(options?: {
  backendUrl?: string;
  tenantId?: string;
  dbPath?: string;
  onProgress?: (current: number, total: number, filename: string) => void;
}): Promise<{ pushed: number; skipped: number; errors: string[] }> {
  const backendUrl =
    options?.backendUrl || process.env.REGNSKAPSBOT_URL || DEFAULT_BACKEND_URL;

  const tenantId = options?.tenantId || process.env.TENANT_ID || 'allvit';

  const dbPath =
    options?.dbPath || path.resolve(process.cwd(), 'store', 'messages.db');

  const db = new Database(dbPath);
  initSkillTables(db);

  const receipts = getPendingReceipts(db);
  if (receipts.length === 0) {
    db.close();
    return { pushed: 0, skipped: 0, errors: [] };
  }

  // Wake up the backend (Railway sleep mode)
  await wakeBackend(backendUrl);

  let pushed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    try {
      if (!receipt.pdf_path) {
        errors.push(`Receipt ${receipt.id}: no pdf_path`);
        continue;
      }

      if (!fs.existsSync(receipt.pdf_path)) {
        errors.push(`Receipt ${receipt.id}: file not found at ${receipt.pdf_path}`);
        continue;
      }

      const fileContent = fs.readFileSync(receipt.pdf_path);
      const filename = path.basename(receipt.pdf_path);

      options?.onProgress?.(i + 1, receipts.length, filename);

      const formData = new FormData();
      const blob = new Blob([fileContent], { type: 'application/pdf' });
      formData.append('file', blob, filename);

      const response = await fetch(
        `${backendUrl}/api/v1/vouchers/upload-async`,
        {
          method: 'POST',
          headers: { 'X-Tenant-Id': tenantId },
          body: formData,
          signal: AbortSignal.timeout(30000),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        errors.push(`Receipt ${receipt.id} (${filename}): upload failed (${response.status}): ${text.slice(0, 200)}`);
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
      } else {
        pushed++;
        markReceiptSent(db, receipt.id);
      }

      // Pause between uploads to avoid overwhelming the backend
      if (i < receipts.length - 1) await sleep(1000);
    } catch (err) {
      errors.push(`Receipt ${receipt.id}: ${(err as Error).message}`);
    }
  }

  db.close();
  return { pushed, skipped, errors };
}
