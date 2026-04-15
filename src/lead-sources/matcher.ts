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
  year: number | null;
}

// Common words that don't help with matching
const STOP_WORDS = new Set([
  'ønskes',
  'kjøpt',
  'selges',
  'til',
  'salgs',
  'brukt',
  'med',
  'for',
  'som',
  'har',
  'kan',
  'fra',
  'eller',
  'evt',
  'etter',
  'pris',
  'god',
  'stand',
  'nice',
  'fin',
  'liten',
  'stor',
  'gammel',
  'ny',
  'nye',
  'bra',
  'rimelig',
  'billig',
  'den',
  'det',
  'denne',
  'per',
  'stk',
  'stykk',
  'type',
  'modell',
  'merke',
  'uten',
  'noe',
  'noen',
  'alle',
  'flere',
]);

// Known equipment brands — these are high-value search terms
const BRANDS = new Set([
  'volvo',
  'caterpillar',
  'cat',
  'komatsu',
  'hitachi',
  'liebherr',
  'jcb',
  'kubota',
  'takeuchi',
  'doosan',
  'hyundai',
  'kobelco',
  'case',
  'john',
  'deere',
  'massey',
  'ferguson',
  'fendt',
  'claas',
  'valtra',
  'new',
  'holland',
  'kverneland',
  'kuhn',
  'igland',
  'maur',
  'scania',
  'man',
  'mercedes',
  'daf',
  'iveco',
  'renault',
]);

// Known equipment types — also high-value
const EQUIPMENT_TYPES = new Set([
  'gravemaskin',
  'beltegraver',
  'hjullaster',
  'minigraver',
  'dumper',
  'dozer',
  'traktor',
  'tresker',
  'skurtresker',
  'rundballepresse',
  'slåmaskin',
  'plog',
  'harv',
  'såmaskin',
  'frontlaster',
  'telehandler',
  'lastebil',
  'trekkvogn',
  'tippbil',
  'semitrailer',
  'tilhenger',
  'hjulgraver',
  'graver',
  'laster',
  'kran',
  'kranbil',
  'gravemaskin',
  'hogstmaskin',
  'lassbærer',
]);

function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\wæøåÆØÅ\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Extract a 4-digit year (19xx or 20xx) from a title string */
export function extractYear(title: string): number | null {
  const match = title.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function searchCache(
  db: Database.Database,
  source: 'ats' | 'lbs',
  title: string,
): CacheMatch[] {
  const keywords = extractKeywords(title);
  if (keywords.length === 0) return [];

  // Separate brand/type keywords (high value) from generic words
  const brandHits = keywords.filter((w) => BRANDS.has(w));
  const typeHits = keywords.filter((w) => EQUIPMENT_TYPES.has(w));
  const otherWords = keywords.filter(
    (w) => !BRANDS.has(w) && !EQUIPMENT_TYPES.has(w),
  );

  // Build FTS query: require brand OR type, plus any other words
  // If we have both brand and type, use AND for precision
  let ftsQuery: string;
  if (brandHits.length > 0 && typeHits.length > 0) {
    // Best case: brand AND type
    ftsQuery = [...brandHits, ...typeHits].map((w) => `"${w}"`).join(' AND ');
  } else if (brandHits.length > 0) {
    // Brand + any other keyword
    const extra = [...typeHits, ...otherWords].slice(0, 2);
    ftsQuery =
      extra.length > 0
        ? brandHits.map((w) => `"${w}"`).join(' AND ') +
          ' AND ' +
          extra.map((w) => `"${w}"`).join(' AND ')
        : brandHits.map((w) => `"${w}"`).join(' AND ');
  } else if (typeHits.length > 0) {
    // Equipment type alone is enough
    ftsQuery = typeHits.map((w) => `"${w}"`).join(' AND ');
  } else {
    // No brand or type — require at least 2 words with AND
    if (otherWords.length < 2) return [];
    ftsQuery = otherWords
      .slice(0, 3)
      .map((w) => `"${w}"`)
      .join(' AND ');
  }

  try {
    const titleCol = source === 'ats' ? 'a.title_no' : 'a.title';
    const joinCol = source === 'ats' ? 'a.id' : 'a.rowid';

    const rows = db
      .prepare(
        `SELECT ${joinCol} as id, ${titleCol} as title, a.price as price, a.year as year
         FROM ads_fts f JOIN ads a ON ${joinCol} = f.rowid
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
        year: r.year ?? null,
      }));
  } catch {
    return [];
  }
}

export interface CacheDbs {
  atsDb: Database.Database | null;
  lbsDb: Database.Database | null;
}

export function openCacheDbs(): CacheDbs {
  return {
    atsDb: openCacheDb('ats-feed-cache.sqlite'),
    lbsDb: openCacheDb('lbs-feed-cache.sqlite'),
  };
}

export function closeCacheDbs(dbs: CacheDbs): void {
  dbs.atsDb?.close();
  dbs.lbsDb?.close();
}

export function matchSignal(signal: RawSignal, dbs: CacheDbs): MatchResult {
  const matches: CacheMatch[] = [];

  if (dbs.atsDb) {
    matches.push(...searchCache(dbs.atsDb, 'ats', signal.title));
  }

  if (dbs.lbsDb) {
    matches.push(...searchCache(dbs.lbsDb, 'lbs', signal.title));
  }

  // Calculate price diff using year-bracket comparison
  let priceDiffPct: number | null = null;
  let comparableCount = 0;

  if (signal.price && matches.length > 0) {
    const signalYear = extractYear(signal.title);

    // Try year-bracket comparison first: only ads within ±3 years
    let comparables: CacheMatch[];
    if (signalYear) {
      comparables = matches.filter(
        (m) => m.year !== null && Math.abs(m.year - signalYear) <= 3,
      );
    } else {
      comparables = [];
    }

    comparableCount = comparables.length;

    if (comparables.length > 0) {
      // Have year-matched comparables — use them for price diff
      const avgOurPrice =
        comparables.reduce((sum, m) => sum + m.price, 0) / comparables.length;
      if (avgOurPrice > 0) {
        priceDiffPct = Math.round(
          ((avgOurPrice - signal.price) / avgOurPrice) * 100,
        );
      }
    } else {
      // No year-matched ads — fall back to overall average but cap at 50%
      const avgOurPrice =
        matches.reduce((sum, m) => sum + m.price, 0) / matches.length;
      comparableCount = matches.length;
      if (avgOurPrice > 0) {
        const raw = Math.round(
          ((avgOurPrice - signal.price) / avgOurPrice) * 100,
        );
        priceDiffPct = Math.min(raw, 50);
      }
    }
  }

  let matchStatus: MatchResult['matchStatus'] = 'no_match';
  if (
    matches.length > 0 &&
    priceDiffPct !== null &&
    priceDiffPct > 15 &&
    comparableCount >= 2
  ) {
    matchStatus = 'price_opportunity';
  } else if (matches.length > 0) {
    matchStatus = 'has_match';
  }

  return { matchStatus, matchedAds: matches, priceDiffPct };
}
