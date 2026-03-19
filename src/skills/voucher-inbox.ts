import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getPendingReceipts, markReceiptSent } from './regnskapsbot-bridge.js';
import { initSkillTables } from '../db.js';

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sha256Hex(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function pushReceiptsToVoucherInbox(options?: {
  supabaseUrl?: string;
  supabaseKey?: string;
  tenantId?: string;
  dbPath?: string;
}): Promise<{ pushed: number; errors: string[] }> {
  const supabaseUrl =
    options?.supabaseUrl ||
    process.env.SUPABASE_URL ||
    'https://mjthfhnqivmvionvqghs.supabase.co';

  const supabaseKey =
    options?.supabaseKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';

  const tenantId =
    options?.tenantId ||
    process.env.TENANT_ID ||
    'allvit';

  const dbPath =
    options?.dbPath ||
    path.resolve(process.cwd(), 'store', 'messages.db');

  if (!supabaseKey) {
    return { pushed: 0, errors: ['SUPABASE_SERVICE_ROLE_KEY is not set'] };
  }

  const db = new Database(dbPath);
  initSkillTables(db);

  const receipts = getPendingReceipts(db);

  let pushed = 0;
  const errors: string[] = [];

  for (const receipt of receipts) {
    try {
      if (!receipt.pdf_path) {
        errors.push(`Receipt ${receipt.id}: no pdf_path, skipping`);
        continue;
      }

      if (!fs.existsSync(receipt.pdf_path)) {
        errors.push(`Receipt ${receipt.id}: file not found at ${receipt.pdf_path}`);
        continue;
      }

      const fileContent = fs.readFileSync(receipt.pdf_path);
      const fileSize = fileContent.length;
      const fileHash = sha256Hex(fileContent);
      const originalFilename = path.basename(receipt.pdf_path);
      const filename = sanitizeFilename(originalFilename);
      const itemId = crypto.randomUUID();

      // Upload to Supabase Storage
      const storagePath = `${tenantId}/uploads/${itemId}/${filename}`;
      const uploadResponse = await fetch(
        `${supabaseUrl}/storage/v1/object/bilag/${storagePath}`,
        {
          method: 'POST',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/pdf',
          },
          body: fileContent,
        },
      );

      if (!uploadResponse.ok) {
        const text = await uploadResponse.text();
        errors.push(
          `Receipt ${receipt.id}: storage upload failed (${uploadResponse.status}): ${text}`,
        );
        continue;
      }

      const filePath = `${supabaseUrl}/storage/v1/object/public/bilag/${storagePath}`;

      // Insert into vouchers.inbox_items via PostgREST
      const insertResponse = await fetch(
        `${supabaseUrl}/rest/v1/inbox_items`,
        {
          method: 'POST',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            id: itemId,
            tenant_id: tenantId,
            source: 'receipt_finder',
            status: 'received',
            document_type: 'receipt',
            file_path: filePath,
            file_name: filename,
            file_type: 'application/pdf',
            file_size: fileSize,
            file_hash: fileHash,
            external_id: `receipt_${receipt.id}`,
          }),
        },
      );

      if (insertResponse.status === 409) {
        // Duplicate — already in inbox, mark as sent locally and move on
        markReceiptSent(db, receipt.id);
        pushed++;
        continue;
      }

      if (!insertResponse.ok) {
        const text = await insertResponse.text();
        errors.push(
          `Receipt ${receipt.id}: inbox insert failed (${insertResponse.status}): ${text}`,
        );
        continue;
      }

      markReceiptSent(db, receipt.id);
      pushed++;
    } catch (err) {
      errors.push(`Receipt ${receipt.id}: ${(err as Error).message}`);
    }
  }

  db.close();
  return { pushed, errors };
}
