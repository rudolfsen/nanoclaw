export interface RawSignal {
  source:
    | 'finn_wanted'
    | 'finn_supply'
    | 'mascus'
    | 'machineryline'
    | 'doffin'
    | 'brreg_new'
    | 'brreg_bankrupt'
    | 'finn_jobs';
  externalUrl: string;
  title: string;
  description: string;
  category: string;
  price: number | null;
  contactName: string | null;
  contactInfo: string | null;
  publishedAt: string;
  externalId: string;
  // Phase 3 — business metadata (optional for backward compat)
  companyName?: string;
  companyOrgnr?: string;
  naceCode?: string;
  location?: string;
  multiHire?: boolean;
}

export interface MatchResult {
  matchStatus: 'has_match' | 'no_match' | 'price_opportunity';
  matchedAds: Array<{
    source: 'ats' | 'lbs';
    id: string | number;
    title: string;
    price: number;
  }>;
  priceDiffPct: number | null;
}
