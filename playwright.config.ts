import { CHROMIUM_SAFETY_ARGS } from './scripts/chromium-safety-args.mjs';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/staging',
  outputDir: '.e2e/playwright',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    launchOptions: { args: [...CHROMIUM_SAFETY_ARGS] },
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev',
    extraHTTPHeaders: {
      'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID || '',
      'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET || '',
    },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/, use: { trace: 'off' } },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/staging.json',
      },
      dependencies: ['setup'],
    },
  ],
});
