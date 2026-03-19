import Database from 'better-sqlite3';

interface PendingReceipt {
  id: number;
  vendor: string;
  amount: number;
  currency: string;
  date: string;
  pdf_path: string;
}

export function getPendingReceipts(db: Database.Database): PendingReceipt[] {
  return db
    .prepare(
      "SELECT id, vendor, amount, currency, date, pdf_path FROM receipts WHERE status = 'pending'",
    )
    .all() as PendingReceipt[];
}

export function markReceiptSent(
  db: Database.Database,
  receiptId: number,
): void {
  db.prepare("UPDATE receipts SET status = 'sent' WHERE id = ?").run(receiptId);
}
