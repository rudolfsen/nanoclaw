#!/usr/bin/env bash
set -euo pipefail

LEAD_DB="${LEAD_DB:-data/leads.sqlite}"

case "${1:-help}" in
  list)
    COUNT="${2:-20}"
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, signal_type, substr(title,1,60) as title, price,
             match_status, price_diff_pct, status, created_at
      FROM leads ORDER BY created_at DESC LIMIT $COUNT
    " | jq '.[]'
    ;;

  demand)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,60) as title, contact_name, contact_info,
             match_status, external_url, created_at
      FROM leads WHERE signal_type = 'demand' AND status = 'new'
      ORDER BY created_at DESC LIMIT ${2:-20}
    " | jq '.[]'
    ;;

  opportunities)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,60) as title, price, price_diff_pct,
             matched_ads, external_url, created_at
      FROM leads WHERE match_status = 'price_opportunity' AND status = 'new'
      ORDER BY price_diff_pct DESC LIMIT ${2:-20}
    " | jq '.[]'
    ;;

  search)
    [ -z "${2:-}" ] && echo "Usage: leads search <query>" >&2 && exit 1
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    ESCAPED="${2//\"/\"\"}"
    sqlite3 -json "$LEAD_DB" "
      SELECT l.id, l.source, l.signal_type, substr(l.title,1,60) as title, l.price,
             l.match_status, l.external_url, l.created_at
      FROM leads_fts f JOIN leads l ON l.id = f.rowid
      WHERE leads_fts MATCH '\"${ESCAPED}\"'
      ORDER BY f.rank LIMIT 20
    " | jq '.[]'
    ;;

  stats)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    echo "=== Lead Statistics ==="
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' total leads' FROM leads"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' new' FROM leads WHERE status = 'new'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' demand (buy signals)' FROM leads WHERE signal_type = 'demand'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' supply (price opportunities)' FROM leads WHERE match_status = 'price_opportunity'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' growth (tenders, new companies, hiring)' FROM leads WHERE signal_type = 'growth'"
    sqlite3 "$LEAD_DB" "SELECT count(*) || ' change (bankruptcies, dissolutions)' FROM leads WHERE signal_type = 'change'"
    echo "--- By source ---"
    sqlite3 "$LEAD_DB" "SELECT source || ': ' || count(*) FROM leads GROUP BY source"
    ;;

  stale)
    DAYS="${2:-60}"
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,55) as title, price,
             CAST(julianday('now') - julianday(first_seen_at) AS INTEGER) as days_on_market,
             external_url
      FROM leads
      WHERE signal_type = 'supply' AND status = 'new'
        AND first_seen_at IS NOT NULL
        AND julianday('now') - julianday(first_seen_at) > $DAYS
      ORDER BY days_on_market DESC LIMIT 20
    " | jq '.[]'
    ;;

  price-drops)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT h.lead_id, substr(l.title,1,55) as title, h.old_price, h.new_price,
             CAST((h.old_price - h.new_price) / h.old_price * 100 AS INTEGER) as drop_pct,
             h.changed_at, l.external_url
      FROM lead_price_history h
      JOIN leads l ON l.id = h.lead_id
      WHERE h.new_price < h.old_price
      ORDER BY h.changed_at DESC LIMIT 20
    " | jq '.[]'
    ;;

  positioning)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    echo "=== Market Prices (from Mascus/Machineryline) ==="
    sqlite3 "$LEAD_DB" "
      SELECT substr(title,1,40) as type, count(*) as count,
             CAST(avg(price) AS INTEGER) as avg_price,
             CAST(min(price) AS INTEGER) as min_price,
             CAST(max(price) AS INTEGER) as max_price
      FROM leads WHERE signal_type = 'supply' AND price > 0
      GROUP BY substr(title,1,40) HAVING count > 1
      ORDER BY count DESC LIMIT 15
    "
    ;;

  gaps)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    echo "=== Demand vs Supply Gaps ==="
    sqlite3 "$LEAD_DB" "
      SELECT
        CASE WHEN signal_type = 'demand' THEN 'DEMAND' ELSE 'SUPPLY' END as type,
        count(*) as count,
        SUM(CASE WHEN match_status = 'has_match' THEN 1 ELSE 0 END) as matched,
        SUM(CASE WHEN match_status = 'no_match' THEN 1 ELSE 0 END) as unmatched
      FROM leads GROUP BY signal_type
    "
    ;;

  growth)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,60) as title, company_name, location,
             published_at, status
      FROM leads
      WHERE signal_type = 'growth'
      ORDER BY created_at DESC LIMIT ${2:-20}
    " | jq '.[]'
    ;;

  changes)
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, substr(title,1,60) as title, company_name, nace_code,
             location, published_at, status
      FROM leads
      WHERE signal_type = 'change'
      ORDER BY created_at DESC LIMIT ${2:-20}
    " | jq '.[]'
    ;;

  companies)
    [ -z "${2:-}" ] && echo "Usage: leads companies <name_or_orgnr>" >&2 && exit 1
    [ ! -f "$LEAD_DB" ] && echo "Lead database not ready." && exit 1
    ESCAPED="${2//\"/\"\"}"
    sqlite3 -json "$LEAD_DB" "
      SELECT id, source, signal_type, company_name, company_orgnr, nace_code,
             location, published_at
      FROM leads
      WHERE company_name IS NOT NULL
        AND (company_name LIKE '%${ESCAPED}%' OR company_orgnr = '${ESCAPED}')
      ORDER BY created_at DESC LIMIT 20
    " | jq '.[]'
    ;;

  help|*)
    cat <<EOF
Leads Tool — Query lead intelligence database

Usage:
  leads list [count]        List newest leads (default: 20)
  leads demand [count]      Show buy signals (people looking for equipment)
  leads opportunities       Show price opportunities (cheaper elsewhere)
  leads growth [count]      Show growth signals (new companies, tenders, hiring)
  leads changes [count]     Show change signals (bankruptcies, dissolutions)
  leads companies <query>   Search by company name or org number
  leads search <query>      Search leads by keyword
  leads stats               Show summary statistics
  leads stale [days]        Show supply listings on market >N days (default: 60)
  leads price-drops         Show leads with recent price reductions
  leads positioning         Market price comparison by equipment type
  leads gaps                Demand vs supply gap analysis
EOF
    ;;
esac
