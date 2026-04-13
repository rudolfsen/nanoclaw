const Database = require('better-sqlite3');
const db = new Database(':memory:');

// Manually create the tables as they're defined
db.exec(`
  CREATE TABLE IF NOT EXISTS email_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(sender, category)
  );

  CREATE TABLE IF NOT EXISTS outlook_processed (
    uid INTEGER PRIMARY KEY,
    processed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS outlook_deliveries (
    uid TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    sender TEXT NOT NULL,
    delivered_at TEXT DEFAULT (datetime('now')),
    responded INTEGER DEFAULT 0
  );
`);

// Add migration columns
try {
  db.exec(`ALTER TABLE email_categories ADD COLUMN response_count INTEGER DEFAULT 0`);
} catch {}
try {
  db.exec(`ALTER TABLE email_categories ADD COLUMN ignore_count INTEGER DEFAULT 0`);
} catch {}
try {
  db.exec(`ALTER TABLE email_categories ADD COLUMN last_response_at TEXT`);
} catch {}

// Verify outlook_processed
console.log('=== outlook_processed ===');
const outlookProcessed = db.pragma('table_info(outlook_processed)');
outlookProcessed.forEach(col => {
  console.log(`${col.name}: ${col.type}, notnull=${col.notnull}, dflt_value=${col.dflt_value}`);
});

// Verify outlook_deliveries
console.log('\n=== outlook_deliveries ===');
const outlookDeliveries = db.pragma('table_info(outlook_deliveries)');
outlookDeliveries.forEach(col => {
  console.log(`${col.name}: ${col.type}, notnull=${col.notnull}, dflt_value=${col.dflt_value}`);
});

// Verify email_categories migrations
console.log('\n=== email_categories migrations ===');
const emailCats = db.pragma('table_info(email_categories)');
emailCats.filter(c => ['response_count', 'ignore_count', 'last_response_at'].includes(c.name)).forEach(col => {
  console.log(`${col.name}: ${col.type}, dflt_value=${col.dflt_value}`);
});

db.close();
