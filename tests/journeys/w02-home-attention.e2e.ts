import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('Home inbox filters unseen cards and opens the exact card route', async ({ app, browser, screen }) => {
  await app.open('/home');
  const cards = browser.locator('section[aria-label="Inbox"] [data-inbox-row]');
  await expect(cards).toHaveCount(3);
  await screen.getByRole('button', 'Unseen', { exact: true }).tap();
  await expect(cards).toHaveCount(1);
  await browser.locator('[data-inbox-row="demo-complete"] h3 a').tap();
  await browser.waitForURL(/\/home\/card\/demo-complete$/);
  await expect(screen.getByRole('heading', 'Current card', { exact: true })).toBeVisible();
  await expect(browser.locator('[data-inbox-row="demo-complete"]')).toBeVisible();
});
