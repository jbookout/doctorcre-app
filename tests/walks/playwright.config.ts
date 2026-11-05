import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { sessionFile } from './session';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
if (process.argv.includes('--no-deps') && !existsSync(sessionFile)) throw new Error('no saved session');

export default defineConfig({
  testDir: '.',
  outputDir: '/tmp/doctorcre-walk-artifacts',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  retries: 0,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'https://app.doctorcre.com', browserName: 'chromium',
    serviceWorkers: 'block',
    timezoneId: 'America/Chicago', screenshot: 'off', trace: 'off', video: 'off',
    actionTimeout: 8_000, navigationTimeout: 20_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, timeout: 330_000, use: { headless: false } },
    { name: 'walks', testMatch: /\d\d-.*\.spec\.ts/, dependencies: ['setup'], use: { storageState: sessionFile } },
  ],
});
