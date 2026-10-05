import { expect } from 'e2e';
import { reproTest, refuseReads, proveVisibleFailure } from './support.mjs';

const test = reproTest();
test('QA-003 unavailable Deals feedback is visibly readable', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser);
  await app.open('/deals?mode=live');
  await expect(browser.locator('#boardLive')).toContainText(/could not be read|unavailable/i);
  await proveVisibleFailure(browser, '#boardLive');
});
