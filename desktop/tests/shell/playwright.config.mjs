import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cache } from './support/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.mjs/,
  outputDir: join(cache, 'results'),
  globalSetup: join(here, 'support/global-setup.mjs'),
  globalTeardown: join(here, 'support/global-teardown.mjs'),
  // One Electron at a time: the tests share one virtual display and one machine that may be busy.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
});
