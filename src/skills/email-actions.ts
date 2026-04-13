import { OutlookGraphClient } from '../channels/outlook.js';

const CATEGORY_LABELS: Record<string, string> = {
  kvittering: 'Kvitteringer',
  nyhetsbrev: 'Nyhetsbrev',
  viktig: 'Viktig',
  handling_kreves: 'Handling',
  reklame: 'Reklame',
  annet: 'Annet',
};

export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

export function getCategoryFolder(category: string): string {
  return CATEGORY_LABELS[category] || category;
}

export async function moveOutlookEmail(
  client: OutlookGraphClient,
  messageId: string,
  category: string,
): Promise<void> {
  const folder = getCategoryFolder(category);
  const folderId = await client.getOrCreateFolder(folder);
  await client.moveMessage(messageId, folderId);
}
