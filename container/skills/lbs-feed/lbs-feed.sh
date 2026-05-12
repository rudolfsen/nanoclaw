#!/usr/bin/env bash
# Tool for querying the Landbrukssalg.no product feed.
# Runs against the local SQLite cache only (built by lbs-feed-sync when enabled).
# The upstream API (data.landbrukssalg.no) is unreachable from production, so
# all commands read from cache. Each result includes a 'url' field linking to
# the live ad on landbrukssalg.no.

set -euo pipefail

CACHE_DB="${LBS_CACHE_DB:-data/lbs-feed-cache.sqlite}"
AD_URL_PREFIX="https://landbrukssalg.no/annonse"

require_cache() {
  if [ ! -f "$CACHE_DB" ]; then
    echo "Error: LBS cache not available at $CACHE_DB" >&2
    exit 1
  fi
}

case "${1:-help}" in
  list)
    require_cache
    COUNT="${2:-20}"
    sqlite3 -json "$CACHE_DB" "
      SELECT id, substr(title, 1, 80) as title, price, price_eur, year, make, model, category, county,
             '$AD_URL_PREFIX/' || id || '/-' AS url
      FROM ads WHERE status = 'published'
      ORDER BY published_at DESC
      LIMIT $COUNT
    " | jq '.[]'
    ;;

  get)
    if [ -z "${2:-}" ]; then
      echo "Usage: lbs-feed get <id>" >&2
      exit 1
    fi
    require_cache
    AD_ID="$2"
    RESULT=$(sqlite3 -json "$CACHE_DB" "
      SELECT id, title, description, maincategory, category, make, model, year,
             price, price_eur, county, zipcode, hours, km, image_url,
             published_at, changed_at,
             '$AD_URL_PREFIX/' || id || '/-' AS url
      FROM ads WHERE id = '$AD_ID'
    " | jq '.[0] // null')
    if [ "$RESULT" = "null" ]; then
      echo "Ad $AD_ID not found in cache"
    else
      echo "$RESULT"
    fi
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: lbs-feed search <query>" >&2
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
      SELECT a.id, substr(a.title, 1, 80) as title, a.price, a.price_eur, a.year, a.make, a.model, a.category, a.county,
             '$AD_URL_PREFIX/' || a.id || '/-' AS url
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

  categories)
    require_cache
    sqlite3 -json "$CACHE_DB" "
      SELECT category, COUNT(*) as count
      FROM ads WHERE status = 'published'
      GROUP BY category ORDER BY count DESC
    " | jq '.[]'
    ;;

  help|*)
    cat <<EOF
LBS Feed Tool — Query Landbrukssalg.no product database (cache-only)

Usage:
  lbs-feed list [count]      List published ads (default: 20)
  lbs-feed get <id>          Get ad details by ID
  lbs-feed search <query>    Search ads by keyword (FTS5)
  lbs-feed categories        List categories with counts

All commands read from a local cache. Each result includes a 'url' field
linking to the live ad on landbrukssalg.no — share that URL with the
customer for the latest photos and contact info.

Examples:
  lbs-feed list 10
  lbs-feed get 2450
  lbs-feed search "john deere"
  lbs-feed categories
EOF
    ;;
esac
