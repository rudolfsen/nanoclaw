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
    echo "--- By source ---"
    sqlite3 "$LEAD_DB" "SELECT source || ': ' || count(*) FROM leads GROUP BY source"
    ;;

  help|*)
    cat <<EOF
Leads Tool — Query lead intelligence database

Usage:
  leads list [count]        List newest leads (default: 20)
  leads demand [count]      Show buy signals (people looking for equipment)
  leads opportunities       Show price opportunities (cheaper elsewhere)
  leads search <query>      Search leads by keyword
  leads stats               Show summary statistics
EOF
    ;;
esac
