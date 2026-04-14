#!/usr/bin/env bash
# Tool for querying the Landbrukssalg.no product feed.
# Uses a local SQLite cache (built by lbs-feed-sync).

set -euo pipefail

FEED_URL="https://data.landbrukssalg.no/export/json/storefront/nb_NO?key=89hgiosdbghKn48gh893nh"
CACHE_DB="${LBS_CACHE_DB:-data/lbs-feed-cache.sqlite}"

case "${1:-help}" in
  list)
    COUNT="${2:-20}"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Falling back to API (first 20)..." >&2
      curl -s "$FEED_URL" | jq "[.[] | select(.status == \"published\")] | sort_by(.published) | reverse | .[0:$COUNT] | .[] | {id, title, price, price_eur, year, make, model, category, county}"
      exit 0
    fi
    sqlite3 -json "$CACHE_DB" "
      SELECT id, substr(title, 1, 80) as title, price, price_eur, year, make, model, category, county
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
    AD_ID="$2"
    if [ -f "$CACHE_DB" ]; then
      sqlite3 -json "$CACHE_DB" "
        SELECT id, title, description, maincategory, category, make, model, year,
               price, price_eur, county, zipcode, hours, km, image_url,
               published_at, changed_at
        FROM ads WHERE id = '$AD_ID'
      " | jq '.[0]'
    else
      curl -s "$FEED_URL" | jq ".[] | select(.id == \"$AD_ID\") | {id, title, description_plain, maincategory, category, make, model, year, price, price_eur, county, zipcode, hours, km, images: [.images[0].url]}"
    fi
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: lbs-feed search <query>" >&2
      exit 1
    fi
    QUERY="$2"
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready. Try again in a moment." >&2
      exit 1
    fi
    ESCAPED="${QUERY//\"/\"\"}"
    RESULTS=$(sqlite3 -json "$CACHE_DB" "
      SELECT a.id, substr(a.title, 1, 80) as title, a.price, a.price_eur, a.year, a.make, a.model, a.category, a.county
      FROM ads_fts f
      JOIN ads a ON a.rowid = f.rowid
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

  categories)
    if [ ! -f "$CACHE_DB" ]; then
      echo "Cache not ready." >&2
      exit 1
    fi
    sqlite3 -json "$CACHE_DB" "
      SELECT category, COUNT(*) as count
      FROM ads WHERE status = 'published'
      GROUP BY category ORDER BY count DESC
    " | jq '.[]'
    ;;

  help|*)
    cat <<EOF
LBS Feed Tool — Query Landbrukssalg.no product database

Usage:
  lbs-feed list [count]      List published ads (default: 20)
  lbs-feed get <id>          Get full ad details by ID
  lbs-feed search <query>    Search ads by keyword (FTS5)
  lbs-feed categories        List categories with counts

Examples:
  lbs-feed list 10
  lbs-feed get 2450
  lbs-feed search "john deere"
  lbs-feed search "plog"
  lbs-feed categories
EOF
    ;;
esac
