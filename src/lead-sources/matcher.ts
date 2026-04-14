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
    ftsQuery = otherWords.slice(0, 3).map((w) => `"${w}"`).join(' AND ');
  }

  try {
    const titleCol = source === 'ats' ? 'a.title_no' : 'a.title';
    const joinCol = source === 'ats' ? 'a.id' : 'a.rowid';

    const rows = db
      .prepare(
        `SELECT ${joinCol} as id, ${titleCol} as title, a.price as price
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
