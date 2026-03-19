#!/usr/bin/env tsx
/**
 * Pushes all pending receipts to the regnskapsbotten voucher inbox
 * via the backend API (POST /api/v1/vouchers/upload-async).
 *
 * Usage:
 *   npx tsx scripts/push-receipts.ts
 *
 * Environment variables (set in .env or shell):
 *   REGNSKAPSBOT_URL  (optional, defaults to Railway backend)
 *   TENANT_ID         (optional, defaults to 'allvit')
 */
import { readFileSync } from 'fs';
import path from 'path';

// Load .env from project root before importing any module that reads env vars.
try {
  const envPath = path.resolve(process.cwd(), '.env');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
} catch {
  // No .env file present — rely on shell environment
}

import { pushReceiptsToVoucherInbox } from '../src/skills/voucher-inbox.js';

console.log('Pushing pending receipts to voucher inbox...\n');

pushReceiptsToVoucherInbox({
  onProgress: (current, total, filename) => {
    process.stdout.write(`\r  [${current}/${total}] ${filename.slice(0, 50).padEnd(50)}`);
  },
})
  .then(({ pushed, skipped, errors }) => {
    process.stdout.write('\r' + ' '.repeat(70) + '\r');
    console.log('Results:');
    console.log(`  Pushed:  ${pushed}`);
    console.log(`  Skipped: ${skipped} (duplicates)`);
    if (errors.length > 0) {
      console.log(`  Errors (${errors.length}):`);
      for (const e of errors) {
        console.log(`    - ${e}`);
      }
    } else {
      console.log('  Errors:  0');
    }
    process.exit(errors.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
