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

## Response Fields

- `id` — Ad ID (use with `get` for full details)
- `price` — Price in NOK
- `price_euro` — Price in EUR
- `year` — Manufacturing year
- `make_id` / `model_id` — Manufacturer and model
- `category_id` — Equipment category
- `fts_nb_no` / `fts_en_us` / `fts_de_de` — Descriptions in Norwegian, English, German
- `vegvesenjson` / `specs` — Technical specifications (engine, weight, etc.)

## Usage in Email Responses

When responding to a customer inquiry about machinery:
1. Use `ats-feed search` to find matching products
2. Use `ats-feed get <id>` for full specs on the best matches
3. Include relevant details (price, specs, year) in the draft
4. Link to the ad: `https://ats.no/no/gjenstand/<id>`
