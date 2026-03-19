/**
 * Seed registered groups from environment variables.
 * Run at startup to ensure groups are registered even on fresh databases.
 *
 * Environment variable format:
 * SEED_GROUPS='[{"jid":"tg:123","name":"Magnus","folder":"privat","trigger":"@bot","requiresTrigger":false,"isMain":true}]'
 */
import { getAllRegisteredGroups, setRegisteredGroup } from './db.js';
import { logger } from './logger.js';

export function seedGroups(): void {
  const seedJson = process.env.SEED_GROUPS;
  if (!seedJson) return;

  let groups: Array<{
    jid: string;
    name: string;
    folder: string;
    trigger: string;
    requiresTrigger?: boolean;
    isMain?: boolean;
  }>;

  try {
    groups = JSON.parse(seedJson);
  } catch {
    logger.warn('Invalid SEED_GROUPS JSON, skipping');
    return;
  }

  const existing = getAllRegisteredGroups();

  for (const g of groups) {
    if (existing[g.jid]) continue;

    setRegisteredGroup(g.jid, {
      name: g.name,
      folder: g.folder,
      trigger: g.trigger,
      requiresTrigger: g.requiresTrigger ?? true,
      isMain: g.isMain ?? false,
      added_at: new Date().toISOString(),
    });
    logger.info({ jid: g.jid, name: g.name }, 'Seeded group registration');
  }
}
