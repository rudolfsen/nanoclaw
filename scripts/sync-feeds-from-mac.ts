// Run feed sync on this Mac (which can reach api3.ats.no and
// data.landbrukssalg.no) and push the resulting SQLite caches up to
// the Hetzner VPS, whose outbound traffic to both endpoints is blocked.
//
// Usage:  npx tsx scripts/sync-feeds-from-mac.ts

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

import {
  initCacheDb as initAtsCache,
  fullSync as atsFullSync,
} from '../src/ats-feed-sync.js';
import {
  initCacheDb as initLbsCache,
  fullSync as lbsFullSync,
} from '../src/lbs-feed-sync.js';

const SERVER = process.env.FEED_SYNC_SERVER || 'root@204.168.178.32';
const REMOTE_DIR =
  process.env.FEED_SYNC_REMOTE_DIR || '/opt/nanoclaw-customers/ats/data';
const LOCAL_DIR =
  process.env.FEED_SYNC_LOCAL_DIR ||
  path.join(os.homedir(), 'Library/Caches/nanoclaw-feeds');

async function main(): Promise<void> {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });

  console.log(`[sync] Local cache:  ${LOCAL_DIR}`);
  console.log(`[sync] Remote cache: ${SERVER}:${REMOTE_DIR}`);

  const t0 = Date.now();

  console.log('[sync] ATS full sync...');
  const atsPath = path.join(LOCAL_DIR, 'ats-feed-cache.sqlite');
  const atsDb = initAtsCache(atsPath);
  atsDb.pragma('wal_checkpoint(TRUNCATE)');
  await atsFullSync(atsDb);
  atsDb.pragma('wal_checkpoint(TRUNCATE)');
  atsDb.close();

  console.log('[sync] LBS full sync...');
  const lbsPath = path.join(LOCAL_DIR, 'lbs-feed-cache.sqlite');
  const lbsDb = initLbsCache(lbsPath);
  lbsDb.pragma('wal_checkpoint(TRUNCATE)');
  await lbsFullSync(lbsDb);
  lbsDb.pragma('wal_checkpoint(TRUNCATE)');
  lbsDb.close();

  console.log('[sync] Pushing caches to Hetzner...');
  execSync(
    `rsync -az ${atsPath} ${lbsPath} ${SERVER}:${REMOTE_DIR}/`,
    { stdio: 'inherit' },
  );

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] Done in ${secs}s.`);
}

main().catch((err) => {
  console.error('[sync] Fatal:', err);
  process.exit(1);
});
