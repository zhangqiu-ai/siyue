import { defineConfig } from 'playwright/test';

// The editor chrome is DOM React, so it is verified in a real browser with a stubbed host bridge.
// Run with: npx playwright test --config packages/whiteboard/playwright.config.mjs
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  outputDir: './node_modules/.editor-fixture/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  forbidOnly: !!process.env.CI,
});
