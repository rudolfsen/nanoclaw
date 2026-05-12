#!/usr/bin/env bash
# Tool for querying the ATS Norway product feed.
# Runs against the local SQLite cache only (built by ats-feed-sync when enabled).
# The upstream API (api3.ats.no) is unreachable from production, so all
# commands read from cache. Use the returned URL to send users to the live ad.

set -euo pipefail

CACHE_DB="${ATS_CACHE_DB:-data/ats-feed-cache.sqlite}"
AD_URL_PREFIX="https://ats.no/no/ad"

require_cache() {
  if [ ! -f "$CACHE_DB" ]; then
    echo "Error: ATS cache not available at $CACHE_DB" >&2
    exit 1
  fi
}

case "${1:-help}" in
  list)
    require_cache
    COUNT="${2:-20}"
    sqlite3 -json "$CACHE_DB" "
      SELECT id, substr(title_no, 1, 80) as title, price, price_euro, year, make_id, category_id,
             '$AD_URL_PREFIX/' || id AS url
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
    require_cache
    AD_ID="$2"
    RESULT=$(sqlite3 -json "$CACHE_DB" "
      SELECT id, status, price, price_euro, year,
             make_id, model_id, category_id,
             title_no, title_en, title_de,
             county_id, zipcode,
             published_at, changed_at, synced_at,
             '$AD_URL_PREFIX/' || id AS url
      FROM ads WHERE id = $AD_ID
    " | jq '.[0] // null')
    if [ "$RESULT" = "null" ]; then
      echo "Ad $AD_ID not found in cache"
    else
      echo "$RESULT"
    fi
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed search <query>" >&2
      exit 1
    fi
    require_cache
    QUERY="$2"
    # Split query into words and AND them for flexible matching
    FTS_QUERY=""
    for WORD in $QUERY; do
      SAFE_WORD="${WORD//\'/\'\'}"
      [ -n "$FTS_QUERY" ] && FTS_QUERY="$FTS_QUERY AND "
      FTS_QUERY="$FTS_QUERY\"$SAFE_WORD\""
    done
    RESULTS=$(sqlite3 -json "$CACHE_DB" "
      SELECT a.id, substr(a.title_no, 1, 80) as title, a.price, a.price_euro, a.year, a.make_id,
             '$AD_URL_PREFIX/' || a.id AS url
      FROM ads_fts f
      JOIN ads a ON a.rowid = f.rowid
      WHERE ads_fts MATCH '$FTS_QUERY'
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
ATS Feed Tool — Query ATS Norway product database (cache-only)

Usage:
  ats-feed list [count]      List published ads (default: 20)
  ats-feed get <id>          Get ad details by ID
  ats-feed search <query>    Search ads by keyword (FTS5)

All commands read from a local cache. Each result includes a 'url' field
linking to the live ad on ats.no — share that URL with the customer for
full description, photos, and seller contact info.

Examples:
  ats-feed list 10
  ats-feed get 22898
  ats-feed search "volvo"
EOF
    ;;
esac
