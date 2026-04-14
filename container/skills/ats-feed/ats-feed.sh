#!/usr/bin/env bash
# Tool for querying the ATS Norway product feed.
# search/list use a local SQLite cache (built by ats-feed-sync).
# get calls the API directly for the freshest data.

set -euo pipefail

API_BASE="https://api3.ats.no/api/v3/ad"
CACHE_DB="${ATS_CACHE_DB:-data/ats-feed-cache.sqlite}"

case "${1:-help}" in
  list)
    COUNT="${2:-20}"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Falling back to API..." >&2
      curl -s "$API_BASE?status=published&\$top=$COUNT" | \
        jq -r '.data[] | {id, title: .fts_nb_no[0:80], price, price_euro, year, make_id, category_id}'
      exit 0
    fi
    sqlite3 -json "$CACHE_DB" "
      SELECT id, substr(title_no, 1, 80) as title, price, price_euro, year, make_id, category_id
      FROM ads WHERE status = 'published'
      ORDER BY published_at DESC
      LIMIT $COUNT
    " | jq '.[]'
    ;;

  get)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed get <id>" >&2
      exit 1
    fi
    curl -s "$API_BASE/$2" | jq '.data | {
      id, status, price, price_euro, year,
      make_id, model_id, category_id,
      title_no: (.fts_nb_no // "")[0:300],
      title_en: (.fts_en_us // "")[0:300],
      title_de: (.fts_de_de // "")[0:300],
      specs: .vegvesen,
      county_id, zipcode,
      published, changed,
      seller, seller_contact, importantinfo
    }'
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed search <query>" >&2
      exit 1
    fi
    QUERY="$2"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Try again in a moment." >&2
      exit 1
    fi
    # FTS5 query: quote the user's input to prevent syntax errors
    ESCAPED="${QUERY//\"/\"\"}"
    RESULTS=$(sqlite3 -json "$CACHE_DB" "
      SELECT a.id, substr(a.title_no, 1, 80) as title, a.price, a.price_euro, a.year, a.make_id
      FROM ads_fts f
      JOIN ads a ON a.id = f.rowid
      WHERE ads_fts MATCH '\"${ESCAPED}\"'
        AND a.status = 'published'
      ORDER BY f.rank
      LIMIT 20
    " 2>/dev/null || echo "[]")
    COUNT=$(echo "$RESULTS" | jq 'length')
    if [ "$COUNT" -gt 0 ]; then
      echo "$RESULTS" | jq '.[]'
    else
      echo "No results found for: $QUERY"
    fi
    ;;

  help|*)
    cat <<EOF
ATS Feed Tool — Query ATS Norway product database

Usage:
  ats-feed list [count]      List published ads (default: 20)
  ats-feed get <id>          Get full ad details by ID (live API)
  ats-feed search <query>    Search ads by keyword (local cache, FTS5)

Examples:
  ats-feed list 10
  ats-feed get 22898
  ats-feed search "volvo"
  ats-feed search "maur trippelkjerre"
EOF
    ;;
esac
