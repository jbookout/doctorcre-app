import { defineConfig } from 'playwright/test';

import { targets } from './scripts/e2e-staging/screens.mjs';
import { STAGING_ORIGIN, STAGING_STORAGE_STATE } from './scripts/e2e-staging/session.mjs';

const artifactRoot = '.e2e/staging-playwright';
const targetProjects = targets.map((target, index) => ({
  name: target.name,
  testMatch: /sweep\.spec\.mjs/,
  dependencies: [index === 0 ? 'staging-auth' : targets[index - 1].name],
  metadata: { stagingTarget: target.name },
  use: {
    baseURL: STAGING_ORIGIN,
    storageState: STAGING_STORAGE_STATE,
    viewport: target.viewport,
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'x-e2e-staging-run': '1' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
}));

export default defineConfig({
  testDir: './tests/staging-live/playwright',
  outputDir: `${artifactRoot}/results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 4 * 60 * 60 * 1_000,
  globalTimeout: 20 * 60 * 60 * 1_000,
  maxFailures: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: `${artifactRoot}/report.json` }],
    ['html', { outputFolder: `${artifactRoot}/html`, open: 'never' }],
  ],
  projects: [
    {
      name: 'staging-auth',
      testMatch: /auth\.setup\.spec\.mjs/,
      use: { baseURL: STAGING_ORIGIN },
    },
    ...targetProjects,
  ],
});
