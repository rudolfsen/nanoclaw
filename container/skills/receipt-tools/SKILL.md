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

## Notes
- Receipts are collected from email automatically (PDF attachments and inline data)
- When no PDF attachment exists, a PDF is generated from parsed email data
- PDFs are stored in the receipts directory under the group folder
- The `regnskapsbot-bridge` handles forwarding to the accounting system
