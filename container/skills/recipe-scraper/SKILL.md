# Recipe Scraper

Scrape recipes from Norwegian food sites and save to the recipe library.

## Usage

Use agent-browser to visit recipe sites and extract structured recipe data.

### Scraping a recipe from godt.no

```bash
agent-browser open "https://www.godt.no/oppskrifter"
agent-browser snapshot -i
# Navigate to a recipe, then extract:
agent-browser get-text
```

### Saving a recipe

Save each recipe as a markdown file in `/workspace/group/recipes/`:

```markdown
# [Recipe Title]

**Kilde:** [URL]
**Porsjoner:** [N]
**Tid:** [N min]
**Sesong:** [vår/sommer/høst/vinter/hele året]
**Tags:** [middag/lunsj/frokost/snacks/dessert]

## Ingredienser

- 400g kyllingfilet
- 2 dl fløte
- ...

## Fremgangsmåte

1. Skjær kyllingen i biter
2. Stek i panne...
```

### Building the library

To proactively build the recipe library, search recipe sites for seasonal recipes:
- godt.no: Browse categories or search
- matprat.no: Browse "Oppskrifter" section
- tine.no: Browse "Oppskrifter" section

Save 5-10 recipes per session. Vary categories (middag, lunsj, etc.) and seasons.

### Generating a weekly plan

Read recipes from `/workspace/group/recipes/`, pick 7 dinners based on:
1. Season (current month)
2. Variety (different proteins, cuisines)
3. Magnus' preferences (check CLAUDE.md "Matpreferanser")

Output: meal plan + consolidated shopping list.
