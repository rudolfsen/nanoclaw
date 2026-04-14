/**
 * Lead Scoring — ranks leads by estimated value.
 *
 * Score range: 0-100
 * Factors:
 *   - Signal type (demand > supply > growth > change)
 *   - Match status (has_match >> price_opportunity > no_match)
 *   - Price diff magnitude (larger = better for supply)
 *   - Freshness (newer = higher)
 *   - Contact info availability
 */

export interface LeadRow {
  id: number;
  source: string;
  signal_type: string;
  match_status: string;
  price_diff_pct: number | null;
  status: string;
  contact_info: string | null;
  contact_name: string | null;
  created_at: string;
}

export function scoreLead(lead: LeadRow): number {
  let score = 0;

  // Signal type weight (0-30)
  switch (lead.signal_type) {
    case 'demand':
      score += 30;
      break; // Someone wants to buy — highest value
    case 'supply':
      score += 20;
      break; // Price opportunity
    case 'growth':
      score += 15;
      break; // Growth signal (Phase 3)
    case 'change':
      score += 10;
      break; // Change signal (Phase 3)
  }

  // Match status (0-30)
  switch (lead.match_status) {
    case 'has_match':
      score += 30;
      break; // We have what they want
    case 'price_opportunity':
      score += 25;
      break; // Arbitrage opportunity
    case 'no_match':
      score += 0;
      break; // No match in our inventory
  }

  // Price diff bonus for supply signals (0-15)
  if (lead.signal_type === 'supply' && lead.price_diff_pct != null) {
    const diffScore = Math.min(15, Math.abs(lead.price_diff_pct) / 3);
    score += diffScore;
  }

  // Freshness — leads decay over time (0-15)
  const ageMs = Date.now() - new Date(lead.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) score += 15;
  else if (ageDays < 3) score += 12;
  else if (ageDays < 7) score += 8;
  else if (ageDays < 14) score += 4;
  else score += 0;

  // Contact info bonus (0-10)
  if (lead.contact_info) score += 7;
  if (lead.contact_name) score += 3;

  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Classify a score into a tier for display.
 */
export function scoreTier(score: number): 'hot' | 'warm' | 'cold' {
  if (score >= 60) return 'hot';
  if (score >= 30) return 'warm';
  return 'cold';
}
