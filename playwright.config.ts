import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/staging',
  outputDir: '.e2e/playwright',
  workers: 1,
  use: {
    baseURL: 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev',
  },
  projects: [
    {
      name: 'fixtures',
      testDir: './tests/fixtures',
      outputDir: '.e2e/fixture-playwright',
      use: { ...devices['Desktop Chrome'] },
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
