#!/usr/bin/env tsx
/**
 * Ad invoice fetcher — fetches invoices from Meta and Snapchat ad platforms,
 * downloads PDFs, and logs them to the SQLite receipts table.
 *
 * Usage:
 *   npx tsx scripts/fetch-ad-invoices.ts [--days <n>]
 *
 * Environment variables required (set in .env or shell):
 *   META_ACCESS_TOKEN, META_BUSINESS_ID
 *   SNAP_CLIENT_ID, SNAP_CLIENT_SECRET, SNAP_REFRESH_TOKEN, SNAP_AD_ACCOUNT_ID
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

import { fetchMetaInvoices, fetchSnapInvoices } from '../src/skills/ad-invoices.js';

// Parse --days flag
const daysIdx = process.argv.indexOf('--days');
const days =
  daysIdx !== -1 && process.argv[daysIdx + 1]
    ? parseInt(process.argv[daysIdx + 1], 10)
    : 90;

console.log(`Fetching ad invoices from the last ${days} day(s)...\n`);

async function main(): Promise<void> {
  const [metaResult, snapResult] = await Promise.allSettled([
    fetchMetaInvoices({ days }),
    fetchSnapInvoices({ days }),
  ]);

  let totalFound = 0;
  let totalDownloaded = 0;
  const allErrors: string[] = [];

  if (metaResult.status === 'fulfilled') {
    const r = metaResult.value;
    totalFound += r.found;
    totalDownloaded += r.downloaded;
    allErrors.push(...r.errors);
    console.log(`Meta:`);
    console.log(`  Found:      ${r.found}`);
    console.log(`  Downloaded: ${r.downloaded}`);
    if (r.errors.length > 0) {
      for (const e of r.errors) {
        console.log(`  Error: ${e}`);
      }
    }
  } else {
    const msg = `Meta fetcher threw: ${metaResult.reason}`;
    allErrors.push(msg);
    console.log(`Meta: FAILED — ${metaResult.reason}`);
  }

  console.log('');

  if (snapResult.status === 'fulfilled') {
    const r = snapResult.value;
    totalFound += r.found;
    totalDownloaded += r.downloaded;
    allErrors.push(...r.errors);
    console.log(`Snap:`);
    console.log(`  Found:      ${r.found}`);
    console.log(`  Downloaded: ${r.downloaded}`);
    if (r.errors.length > 0) {
      for (const e of r.errors) {
        console.log(`  Error: ${e}`);
      }
    }
  } else {
    const msg = `Snap fetcher threw: ${snapResult.reason}`;
    allErrors.push(msg);
    console.log(`Snap: FAILED — ${snapResult.reason}`);
  }

  console.log('');
  console.log(`Totals:`);
  console.log(`  Found:      ${totalFound}`);
  console.log(`  Downloaded: ${totalDownloaded}`);
  console.log(`  Errors:     ${allErrors.length}`);

  process.exit(allErrors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
