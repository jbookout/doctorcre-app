import { expect } from 'e2e';
import { reproTest, textContrast } from './support.mjs';

const test = reproTest();
test('QA-002 light Home deal and invoice titles have readable contrast', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/');
  await expect(browser.locator('[data-inbox-row] h3 a').first()).toBeVisible();
  await screen.getByRole('button', /account and settings/i).tap();
  const theme = browser.locator('[data-pref="theme"]');
  if (await theme.getAttribute('aria-pressed') === 'true') await theme.tap();
  await expect(browser.locator('[data-pref="theme"]')).toHaveAttribute('aria-pressed', 'false');
  await browser.keyboard.press('Escape');
  const deal = await textContrast(browser, '[data-inbox-row] h3 a');
  const invoice = await textContrast(browser, '#homeInvoices strong');
  expect.soft(deal.ratio, JSON.stringify(deal)).toBeGreaterThanOrEqual(4.5);
  expect.soft(invoice.ratio, JSON.stringify(invoice)).toBeGreaterThanOrEqual(4.5);
});
