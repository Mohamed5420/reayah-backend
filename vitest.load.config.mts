import { defineConfig } from 'vitest/config';

/**
 * Load test (M1.9): `npm run test:load`. Seeds a staging-sized dataset into the in-memory MongoDB and
 * drives the real app over HTTP with concurrent clients. Not part of `npm test` (it takes minutes).
 * Size / concurrency: LOAD_PROVIDERS (default 1000), LOAD_CONCURRENCY (10), LOAD_REQUESTS (400 per scenario).
 */
export default defineConfig({
  test: {
    include: ['tests/load/**/*.load.ts'],
    environment: 'node',
    pool: 'threads',
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/env.ts', 'tests/setup/load-env.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
  },
});
