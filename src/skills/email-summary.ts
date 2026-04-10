import Database from 'better-sqlite3';

const CATEGORY_LABELS: Record<string, string> = {
  viktig: 'viktige',
  handling_kreves: 'handling',
  kvittering: 'kvitteringer',
  nyhetsbrev: 'nyhetsbrev',
  reklame: 'reklame',
  annet: 'annet',
};

const CATEGORY_ORDER = [
  'viktig',
  'handling_kreves',
  'kvittering',
  'nyhetsbrev',
  'reklame',
  'annet',
];

export function generateDailySummary(db: Database.Database): string {
  const rows = db
    .prepare(
      `
    SELECT category, COUNT(*) as count
    FROM categorized_emails
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY category
  `,
    )
    .all() as { category: string; count: number }[];

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) return 'Ingen nye e-poster i går';

  const countByCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));

  const parts = CATEGORY_ORDER.filter((cat) => (countByCategory[cat] ?? 0) > 0).map(
    (cat) => `${countByCategory[cat]} ${CATEGORY_LABELS[cat] ?? cat}`,
  );

  return `📬 ${total} nye i går — ${parts.join(', ')}`;
}
