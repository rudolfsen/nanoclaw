import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

import { RawSignal, MatchResult } from './types.js';

function openCacheDb(filename: string): Database.Database | null {
  const dbPath = path.join(
    process.env.ATS_CACHE_DIR || path.resolve(process.cwd(), 'data'),
    filename,
  );
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

interface CacheMatch {
  source: 'ats' | 'lbs';
  id: string | number;
  title: string;
  price: number;
}

function searchCache(
  db: Database.Database,
  source: 'ats' | 'lbs',
  query: string,
): CacheMatch[] {
  // Extract meaningful keywords (skip short words)
  const words = query
    .replace(/[^\w\sæøåÆØÅ]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5);
  if (words.length === 0) return [];

  const ftsQuery = words.map((w) => `"${w}"`).join(' OR ');

  try {
    const idCol = source === 'ats' ? 'a.id' : 'a.id';
    const titleCol = source === 'ats' ? 'a.title_no' : 'a.title';
    const priceCol = 'a.price';

    const rows = db
      .prepare(
        `SELECT ${idCol} as id, ${titleCol} as title, ${priceCol} as price
         FROM ads_fts f JOIN ads a ON a.${source === 'ats' ? 'id' : 'rowid'} = f.rowid
         WHERE ads_fts MATCH ? AND a.status = 'published'
         ORDER BY f.rank LIMIT 5`,
      )
      .all(ftsQuery) as any[];

    return rows
      .filter((r) => r.price)
      .map((r) => ({
        source,
        id: r.id,
        title: (r.title || '').slice(0, 80),
        price: r.price,
      }));
  } catch {
    return [];
  }
}

export function matchSignal(signal: RawSignal): MatchResult {
  const matches: CacheMatch[] = [];

  const atsDb = openCacheDb('ats-feed-cache.sqlite');
  if (atsDb) {
    matches.push(...searchCache(atsDb, 'ats', signal.title));
    atsDb.close();
  }

  const lbsDb = openCacheDb('lbs-feed-cache.sqlite');
  if (lbsDb) {
    matches.push(...searchCache(lbsDb, 'lbs', signal.title));
    lbsDb.close();
  }

  // Calculate price diff for supply signals
  let priceDiffPct: number | null = null;
  if (signal.price && matches.length > 0) {
    const avgOurPrice =
      matches.reduce((sum, m) => sum + m.price, 0) / matches.length;
    if (avgOurPrice > 0) {
      priceDiffPct = Math.round(
        ((avgOurPrice - signal.price) / avgOurPrice) * 100,
      );
    }
  }

  let matchStatus: MatchResult['matchStatus'] = 'no_match';
  if (matches.length > 0 && priceDiffPct !== null && priceDiffPct > 15) {
    matchStatus = 'price_opportunity';
  } else if (matches.length > 0) {
    matchStatus = 'has_match';
  }

  return { matchStatus, matchedAds: matches, priceDiffPct };
}
