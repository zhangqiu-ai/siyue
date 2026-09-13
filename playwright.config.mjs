import { defineConfig } from 'playwright/test';

// Workers reload config: inherit one run identity so all artifacts share a directory.
process.env.SIYUE_E2E_RUN_ID ??= `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  outputDir: `artifacts/e2e/${process.env.SIYUE_E2E_RUN_ID}`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  forbidOnly: !!process.env.CI,
});
