import { CHROMIUM_SAFETY_ARGS } from './scripts/chromium-safety-args.mjs';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/staging',
  outputDir: '.e2e/playwright',
  workers: 1,
  use: {
    launchOptions: { args: [...CHROMIUM_SAFETY_ARGS] },
    baseURL: 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev',
  },
  projects: [
    {
      name: 'fixtures',
      testDir: './tests/fixtures',
      outputDir: '.e2e/fixture-playwright',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'live',
      testDir: './tests/live',
      outputDir: '.e2e/live-playwright',
      timeout: 120_000,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:8787', timezoneId: 'America/Chicago', actionTimeout: 15_000, trace: 'retain-on-failure' },
    },
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/staging.json',
        trace: 'retain-on-failure',
      },
      dependencies: ['setup'],
    },
  ],
});
