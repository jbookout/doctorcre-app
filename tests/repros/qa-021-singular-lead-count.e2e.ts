import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
test('QA-021 one matching lead uses singular count', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/leads');
  await expect(browser.locator('#leadBoard')).toHaveAttribute('aria-busy', 'false');
  const sidebar = screen.getByRole('button', 'Workspace sidebar', { exact: true });
  if (await sidebar.count()) await sidebar.tap();
  await screen.getByLabel('Stage', { exact: true }).selectOption({ label: 'Qualified' });
  await expect(browser.locator('#leadBoard .lead-card')).toHaveCount(1);
  await expect(browser.locator('#filterSummary')).toHaveText('1 lead');
});
