# Receipt Tools

Samle inn, generere og administrere kvitteringer fra e-post.

## Capabilities

### View Pending Receipts
List receipts that have not yet been sent to regnskapsbotten:

```bash
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH || '/data/messages.db');
  const rows = db.prepare(\"SELECT id, vendor, amount, currency, date, status FROM receipts WHERE status = 'pending' ORDER BY date DESC\").all();
  console.log(JSON.stringify(rows, null, 2));
"
```

### View All Receipts
List all collected receipts with their status:

```bash
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH || '/data/messages.db');
  const rows = db.prepare('SELECT id, vendor, amount, currency, date, status, pdf_path FROM receipts ORDER BY date DESC LIMIT 50').all();
  console.log(JSON.stringify(rows, null, 2));
"
```

### Mark Receipt as Sent
Update a receipt's status after it has been forwarded to regnskapsbotten:

```bash
node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH || '/data/messages.db');
  db.prepare(\"UPDATE receipts SET status = 'sent' WHERE id = ?\").run(RECEIPT_ID);
  console.log('Receipt marked as sent');
"
```

Replace `RECEIPT_ID` with the actual receipt ID.

### Trigger a Receipt Scan
Run a one-shot scan of Gmail and Outlook for receipt emails from the last 7 days (default):

```bash
npx tsx scripts/scan-receipts.ts
```

Scan a custom number of days back:

```bash
npx tsx scripts/scan-receipts.ts --days 30
```

The scanner will:
1. Search Gmail for emails matching receipt/invoice/kvittering/faktura in the subject
2. Search Outlook IMAP inbox for the same patterns
3. For each receipt found, download any PDF attachment or generate one from inline data
4. Save PDFs to the `receipts/` directory at the project root
5. Log each receipt to the SQLite `receipts` table (skips duplicates by `email_uid`)
6. Print a summary: how many were found, processed, and any errors

Required environment variables (in `.env` or shell):
- Gmail: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
- Outlook: `OUTLOOK_EMAIL`, `OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REFRESH_TOKEN`

If one provider's credentials are missing, that provider is skipped and an error is reported in the summary — the other provider still runs.

## Notes
- Receipts are collected from email automatically (PDF attachments and inline data)
- When no PDF attachment exists, a PDF is generated from parsed email data
- PDFs are stored in the `receipts/` directory at the project root
- The `regnskapsbot-bridge` handles forwarding to the accounting system
- Duplicate detection uses the `email_uid` + `source` pair so re-running the scan is safe
