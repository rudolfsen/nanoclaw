export interface RawSignal {
  source: 'finn_wanted' | 'finn_supply' | 'mascus' | 'machineryline';
  externalUrl: string;
  title: string;
  description: string;
  category: string;
  price: number | null;
  contactName: string | null;
  contactInfo: string | null;
  publishedAt: string;
  externalId: string;
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
