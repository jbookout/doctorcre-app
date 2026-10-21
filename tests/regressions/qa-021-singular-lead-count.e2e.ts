import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
test('QA-021 one matching lead uses singular count', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/leads');
  await expect(browser.locator('#leadBoard')).toHaveAttribute('aria-busy', 'false');
  await screen.getByLabel('Board stage', { exact: true }).selectOption({ value: 'qualified' });
  await expect(browser.locator('#leadBoard .lead-card')).toHaveCount(1);
  await expect(browser.locator('#filterSummary')).toHaveText('1 matching lead');
});
