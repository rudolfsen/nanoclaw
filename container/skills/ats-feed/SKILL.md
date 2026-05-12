# ATS Feed Tool

Query the ATS Norway product database for used machinery listings.

## Commands

### List published ads
```bash
ats-feed list        # First 50 published ads
ats-feed list 10     # First 10
```

### Get full details
```bash
ats-feed get 22898   # Full specs, prices, descriptions in NO/EN/DE
```

### Search by keyword
```bash
ats-feed search "volvo"       # Find Volvo machines
ats-feed search "excavator"   # Find excavators
ats-feed search "lastebil"    # Search in Norwegian
```

All commands read from a local SQLite cache. Each result includes a `url` field
linking to the live ad on ats.no — share that link instead of constructing it
yourself.

## Response Fields

- `id` — Ad ID (use with `get` for full details)
- `url` — Direct link to the ad on ats.no
- `price` — Price in NOK
- `price_euro` — Price in EUR
- `year` — Manufacturing year
- `make_id` / `model_id` — Manufacturer and model
- `category_id` — Equipment category
- `title_no` / `title_en` / `title_de` — Title and embedded description in NO/EN/DE

## Usage in Email Responses

When responding to a customer inquiry about machinery:
1. Use `ats-feed search` to find matching products
2. Use `ats-feed get <id>` for full details on the best matches
3. Include relevant details (price, year, key specs from `title_no`) in the draft
4. Always include the `url` field so the customer can see photos and contact info
