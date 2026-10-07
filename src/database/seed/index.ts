import { logger } from '../../utils/logger/winston';
import { seedLocations } from './locations.seed';
import { seedCatalog } from './catalog.seed';

type Seed = { name: string; run: () => Promise<void> };

/**
 * Register idempotent seeds here. Each seed must be safe to run on every boot
 * (use upserts / existence checks).
 */
const seeds: Seed[] = [
  { name: 'locations', run: seedLocations },
  { name: 'catalog', run: seedCatalog },
];

export const runSeeds = async () => {
  for (const seed of seeds) {
    await seed.run();
    logger.info(`Seed done: ${seed.name}`);
  }
};
