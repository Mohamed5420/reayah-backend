import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Worker threads, not child processes: forked workers occasionally crashed natively on Windows
    // (exit 0xC0000409) at startup. Each test file still gets its own isolated module graph.
    pool: 'threads',
    // One in-memory MongoDB replica set for the whole run (transactions need a replica set).
    globalSetup: ['tests/setup/global-setup.ts'],
    // Env vars + Redis mock, before any app module loads.
    setupFiles: ['tests/setup/env.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000, // first run downloads the mongod binary
  },
});
