import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-026 one incident occurrence uses singular time', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser }) => {
  await app.open('/control-room?tab=attention');
  const incident = browser.locator('[data-incident="INC-20260916-03"]');
  await expect(incident).toContainText('Demo staging deploy retried once and then succeeded');
  await expect(browser.locator('[data-incident="INC-20260916-03"] .work-meta').nth(0)).toContainText(/seen 1 time(?:\s|$)/);
});
