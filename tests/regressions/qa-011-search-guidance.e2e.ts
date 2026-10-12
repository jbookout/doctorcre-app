import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-011 multiple-match guidance describes available interface controls', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  await expect(browser.locator('#searchCandidates')).toBeVisible();
  await expect(browser.locator('#searchCandidates')).not.toContainText(/call catch-me-up|this verb/i);
  await expect(browser.locator('#searchCandidates')).toContainText(/open|select|choose/i);
});
