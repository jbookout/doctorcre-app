import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-013 vendor search destination identifies Vendors', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  const row = screen.getByRole('listitem').filter({ hasText: 'Demo Pensacola Buildout Contractors' });
  await row.getByRole('link', 'Open', { exact: true }).tap();
  await browser.waitForURL(/\/vendors/);
  await expect(screen.getByRole('heading', 'Vendors', { exact: true })).toBeVisible();
});
