# Email Tools

Sortering, kategorisering og oppsummering av e-post.

## Capabilities

### Daily Summary
Generate a summary of today's categorized emails (count per category).

```bash
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH || '/data/messages.db');
  const rows = db.prepare(\"SELECT category, COUNT(*) as count FROM categorized_emails WHERE date(created_at) = date('now') GROUP BY category\").all();
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total === 0) { console.log('0 nye e-poster i dag.'); }
  else { console.log(total + ' nye i dag: ' + rows.map(r => r.count + ' ' + r.category).join(', ')); }
"
```

### View Categorization Stats
See how many emails have been categorized, by category:

```bash
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH || '/data/messages.db');
  const rows = db.prepare('SELECT category, COUNT(*) as count FROM categorized_emails GROUP BY category ORDER BY count DESC').all();
  console.log(JSON.stringify(rows, null, 2));
"
```

### View Learned Sender Categories
See what senders have been auto-categorized:

```bash
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH || '/data/messages.db');
  const rows = db.prepare('SELECT sender, category, confidence FROM email_categories ORDER BY created_at DESC LIMIT 20').all();
  console.log(JSON.stringify(rows, null, 2));
"
```

## Categories
- `kvittering` — receipts and invoices
- `nyhetsbrev` — newsletters
- `viktig` — important/urgent
- `jobb` — work-related
- `privat` — personal
- `ukjent` — unclassified (needs AI review)
