/**
 * Seed registered groups from environment variables.
 * Run at startup to ensure groups are registered even on fresh databases.
 *
 * Environment variable format:
 * SEED_GROUPS='[{"jid":"tg:123","name":"Magnus","folder":"privat","trigger":"@bot","channel":"telegram","requiresTrigger":false,"isMain":true}]'
 */
import { getAllRegisteredGroups, setRegisteredGroup } from '../src/db.js';
import { logger } from '../src/logger.js';
export function seedGroups() {
    const seedJson = process.env.SEED_GROUPS;
    if (!seedJson)
        return;
    let groups;
    try {
        groups = JSON.parse(seedJson);
    }
    catch {
        logger.warn('Invalid SEED_GROUPS JSON, skipping');
        return;
    }
    const existing = getAllRegisteredGroups();
    for (const g of groups) {
        if (existing[g.jid])
            continue;
        setRegisteredGroup(g.jid, {
            name: g.name,
            folder: g.folder,
            trigger: g.trigger,
            channel: g.channel,
            requiresTrigger: g.requiresTrigger ?? true,
            isMain: g.isMain ?? false,
            added_at: new Date().toISOString(),
        });
        logger.info({ jid: g.jid, name: g.name }, 'Seeded group registration');
    }
}
//# sourceMappingURL=seed-groups.js.map