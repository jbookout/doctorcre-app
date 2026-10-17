import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/staging',
  outputDir: '.e2e/playwright',
  use: {
    baseURL: 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
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
