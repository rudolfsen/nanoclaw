export function formatEmailNotification(
  category: 'viktig' | 'handling_kreves',
  from: string,
  subject: string,
  bodyPreview: string,
): string {
  const icon = category === 'handling_kreves' ? '⚠️' : '📩';
  const label = category === 'handling_kreves' ? 'Handling kreves' : 'Viktig';
  const preview = bodyPreview.slice(0, 200).replace(/\n+/g, ' ').trim();

  return `${icon} *${label}*\nFra: ${from}\nEmne: ${subject}\n\n${preview}`;
}
