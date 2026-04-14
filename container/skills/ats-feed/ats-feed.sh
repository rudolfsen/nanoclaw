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
      jq -r '.data[] | select(.status == "published") | {
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
    curl -s "$API_BASE/$2" | jq '{
      id, status, price, price_euro, year,
      make_id, model_id, category_id,
      title_no: .fts_nb_no[0:200],
      title_en: .fts_en_us[0:200],
      title_de: .fts_de_de[0:200],
      specs: .vegvesenjson,
      county_id, zipcode,
      published, changed
    }'
    ;;

  search)
    if [ -z "${2:-}" ]; then
      echo "Usage: ats-feed search <query>" >&2
      exit 1
    fi
    QUERY="$2"
    curl -s "$API_BASE" | \
      jq --arg q "$QUERY" -r '.data[] |
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
        }'
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
