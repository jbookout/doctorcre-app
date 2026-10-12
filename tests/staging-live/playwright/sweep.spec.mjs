import { attachSweepArtifacts, test } from '../../../scripts/e2e-staging/playwright-fixtures.mjs';
import { outputPath, sweep } from '../../../scripts/e2e-staging/sweep.mjs';

test('exhaustive staging control sweep', async ({ freshPage, stagingSession, stagingTarget }, testInfo) => {
  try {
    await sweep({
      resume: process.env.E2E_STAGING_RESUME === '1',
      targetName: stagingTarget.name,
      freshPage,
      session: stagingSession,
    });
  } finally {
    await attachSweepArtifacts(testInfo, outputPath());
  }
});
