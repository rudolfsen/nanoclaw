import Database from 'better-sqlite3';

export function generateDailySummary(db: Database.Database): string {
  const rows = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM categorized_emails
    WHERE date(created_at) = date('now')
    GROUP BY category
  `).all() as { category: string; count: number }[];

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return '📬 0 nye e-poster i dag.';

  const parts = rows.map(r => `${r.count} ${r.category}`).join(', ');
  return `📬 ${total} nye i dag — ${parts}`;
}
