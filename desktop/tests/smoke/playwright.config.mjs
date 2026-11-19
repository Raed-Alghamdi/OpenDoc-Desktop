import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.mjs/,
  outputDir: path.join(here, '..', '..', 'build', 'smoke-results'),
  // One app at a time: the tests share one display and a machine that may be busy.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
});
