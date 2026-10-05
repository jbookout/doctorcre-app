import { expect } from 'e2e';
import { reproTest, textContrast } from './support.mjs';

const test = reproTest();
test('QA-002 light Home deal and invoice titles have readable contrast', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/');
  await expect(browser.locator('#dealFlags strong').first()).toBeVisible();
  await screen.getByRole('button', /account and settings/i).tap();
  await screen.getByRole('button', 'Theme', { exact: true }).tap();
  await expect(browser.locator('[data-pref="theme"]')).toHaveAttribute('aria-pressed', 'false');
  const deal = await textContrast(browser, '#dealFlags strong');
  const invoice = await textContrast(browser, '#homeInvoices strong');
  expect.soft(deal.ratio, JSON.stringify(deal)).toBeGreaterThanOrEqual(4.5);
  expect.soft(invoice.ratio, JSON.stringify(invoice)).toBeGreaterThanOrEqual(4.5);
});
