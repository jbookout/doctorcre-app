import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-029 one matching client uses singular count', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser }) => {
  await app.open('/clients?mode=live&q=Demo+Practice+22');
  await expect(browser.locator('a[data-record-id]')).toHaveCount(1);
  await expect(browser.locator('a[data-record-id]')).toContainText('Demo Practice 22');
  await expect(browser.locator('#resultSummary')).toHaveText('1 client');
});
