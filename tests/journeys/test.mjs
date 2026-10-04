import { test } from '@e2e-dev/web';
import { assertServedBuild } from '../../scripts/browser-proof-contract.mjs';

// e2e re-evaluates entry files but caches their imported helpers. Register the
// hook at each entry's evaluation, so every collection and execution realm
// checks the server the runner actually opened.
export function productTest() {
  test.beforeEach(async ({ app }) => {
    if (process.env.BROWSER_PROOF_BINDING)
      await assertServedBuild(app.baseUrl, JSON.parse(process.env.BROWSER_PROOF_BINDING));
  });
  return test;
}
