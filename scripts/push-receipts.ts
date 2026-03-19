#!/usr/bin/env tsx
/**
 * Pushes all pending receipts from the local SQLite receipts table into
 * the regnskapsbotten voucher inbox (Supabase Storage + inbox_items table).
 *
 * Usage:
 *   npx tsx scripts/push-receipts.ts
 *
 * Environment variables required (set in .env or shell):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   TENANT_ID  (optional, defaults to 'allvit')
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

pushReceiptsToVoucherInbox()
  .then(({ pushed, errors }) => {
    console.log('Results:');
    console.log(`  Pushed: ${pushed}`);
    if (errors.length > 0) {
      console.log(`  Errors (${errors.length}):`);
      for (const e of errors) {
        console.log(`    - ${e}`);
      }
    } else {
      console.log('  Errors: 0');
    }
    process.exit(errors.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
