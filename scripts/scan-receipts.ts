#!/usr/bin/env tsx
/**
 * Receipt scanner — scans Gmail and Outlook for receipt emails, downloads or
 * generates PDFs, and logs them to the SQLite receipts table.
 *
 * Usage:
 *   npx tsx scripts/scan-receipts.ts [--days <n>]
 *
 * Environment variables required (set in .env or shell):
 *   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   OUTLOOK_EMAIL, OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID,
 *   OUTLOOK_CLIENT_SECRET, OUTLOOK_REFRESH_TOKEN
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

import { scanReceipts } from '../src/skills/scan-receipts.js';

// Parse --days flag
const daysIdx = process.argv.indexOf('--days');
const days =
  daysIdx !== -1 && process.argv[daysIdx + 1]
    ? parseInt(process.argv[daysIdx + 1], 10)
    : 7;

console.log(`Scanning for receipt emails from the last ${days} day(s)...\n`);

scanReceipts({ days })
  .then(({ found, processed, errors }) => {
    console.log(`Results:`);
    console.log(`  Found:     ${found}`);
    console.log(`  Processed: ${processed}`);
    if (errors.length > 0) {
      console.log(`  Errors (${errors.length}):`);
      for (const e of errors) {
        console.log(`    - ${e}`);
      }
    } else {
      console.log(`  Errors:    0`);
    }
    process.exit(errors.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
