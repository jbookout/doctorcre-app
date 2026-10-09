import { effectiveRunLimits } from './scripts/e2e-staging/run-limits.mjs';
import { defineConfig } from 'playwright/test';

import { targets } from './scripts/e2e-staging/screens.mjs';
import { STAGING_ORIGIN, STAGING_STORAGE_STATE } from './scripts/e2e-staging/session.mjs';

const limits = effectiveRunLimits();
const artifactRoot = (process.env.E2E_V2_OUTPUT || '.e2e/bounded-run') + '/playwright';
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
    trace: 'off',
    screenshot: 'off',
  },
}));

export default defineConfig({
  testDir: './tests/staging-live/playwright',
  outputDir: `${artifactRoot}/results`,
  fullyParallel: false,
  workers: limits.workers,
  retries: limits.retries,
  timeout: limits.testTimeoutMs,
  globalTimeout: limits.runTimeoutMs,
  maxFailures: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: `${artifactRoot}/report.json` }],
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
