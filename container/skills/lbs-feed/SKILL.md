# Landbrukssalg Feed Tool

Query the Landbrukssalg.no database for used agricultural equipment.

## Commands

### List published ads
```bash
lbs-feed list        # Latest 20 published ads
lbs-feed list 10     # Latest 10
```

### Get full details
```bash
lbs-feed get 2450    # Full details for ad #2450
```

### Search by keyword
```bash
lbs-feed search "john deere"    # Find John Deere equipment
lbs-feed search "plog"          # Find plows
lbs-feed search "traktor"       # Find tractors
lbs-feed search "rundballepresse"  # Find round balers
```

### List categories
```bash
lbs-feed categories   # Show all categories with counts
```

## Response Fields

- `id` — Ad ID (use with `get` for full details)
- `title` — Equipment title with year and model
- `price` — Price in NOK
- `price_eur` — Price in EUR
- `year` — Manufacturing year
- `make` / `model` — Manufacturer and model name
- `category` — Equipment category (e.g. "Traktor", "Grass production")
- `county` — Norwegian county where equipment is located
- `hours` / `km` — Usage hours or kilometers
- `image_url` — Main image URL

## Usage in Email Responses

When responding to a customer inquiry about agricultural equipment:
1. Use `lbs-feed search` to find matching products
2. Use `lbs-feed get <id>` for full details on the best matches
3. Include relevant details (price, specs, year, location) in the draft
4. Link to the ad: `https://landbrukssalg.no/kjope/?id=<id>`
