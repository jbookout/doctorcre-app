import { requireSupervisedRun } from '../../../scripts/e2e-staging/run-limits.mjs';
import { test } from 'playwright/test';

import { stagingSession, STAGING_ORIGIN, STAGING_STORAGE_STATE } from '../../../scripts/e2e-staging/session.mjs';

test('obtain the dedicated staging partner storage state', async ({ request }) => {
  requireSupervisedRun();
  await stagingSession(STAGING_ORIGIN, { requestContext: request, storageStatePath: STAGING_STORAGE_STATE });
});
