#!/usr/bin/env bash
# Tool for querying the ATS Norway product feed
# Usage:
#   ats-feed list              — List all published ads (first 50)
#   ats-feed get <id>          — Get full details for a specific ad
#   ats-feed search <query>    — Search ads by keyword in descriptions

set -euo pipefail

API_BASE="https://api3.ats.no/api/v3/ad"

case "${1:-help}" in
  list)
    curl -s "$API_BASE?status=published&\$top=${2:-50}" | \
      jq -r '.data[] | {
        id,
        title: .fts_nb_no[0:80],
        price: .price,
        price_euro: .price_euro,
        year: .year,
        make_id: .make_id,
        category_id: .category_id,
        status: .status
      }'
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
    # API has no server-side search. Fetch last N pages (newest ads) and filter client-side.
    LAST_PAGE=$(curl -s "$API_BASE?page=1" | jq '.meta.last_page // 1')
    START_PAGE=$((LAST_PAGE > 10 ? LAST_PAGE - 9 : 1))
    FOUND=0
    for PAGE in $(seq "$LAST_PAGE" -1 "$START_PAGE"); do
      RESULTS=$(curl -s "$API_BASE?page=$PAGE" | \
        jq --arg q "$QUERY" '[.data[] |
          select(.status == "published") |
          select(
            (.fts_nb_no // "" | ascii_downcase | contains($q | ascii_downcase)) or
            (.fts_en_us // "" | ascii_downcase | contains($q | ascii_downcase)) or
            (.fts_de_de // "" | ascii_downcase | contains($q | ascii_downcase))
          ) | {
            id,
            title: .fts_nb_no[0:80],
            price: .price,
            price_euro: .price_euro,
            year: .year,
            make_id: .make_id
          }]')
      COUNT=$(echo "$RESULTS" | jq 'length')
      if [ "$COUNT" -gt 0 ]; then
        echo "$RESULTS" | jq '.[]'
        FOUND=$((FOUND + COUNT))
      fi
      # Stop after finding enough results
      [ "$FOUND" -ge 10 ] && break
    done
    [ "$FOUND" -eq 0 ] && echo "No results found for: $QUERY"
    ;;

  help|*)
    cat <<EOF
ATS Feed Tool — Query ATS Norway product database

Usage:
  ats-feed list [count]      List published ads (default: 50)
  ats-feed get <id>          Get full ad details by ID
  ats-feed search <query>    Search ads by keyword

Examples:
  ats-feed list 10
  ats-feed get 22898
  ats-feed search "volvo"
  ats-feed search "excavator"
EOF
    ;;
esac
