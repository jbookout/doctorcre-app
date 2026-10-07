import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-027 Reload retains the selected Local Deals owner', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/deals?mode=live&view=list');
  await expect(browser.locator('#kanban .deal-row')).toHaveCount(16);
  await screen.getByRole('button', 'Dismiss morning brief', { exact: true }).tap();
  await screen.getByRole('button', 'Dell', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Dell', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(browser.locator('#kanban .deal-row')).toHaveCount(8);
  await app.screenshot('qa-027-dell-list-before-reload');
  const address = await browser.evaluate(() => location.pathname + location.search);
  await app.open(address);
  await expect(browser.locator('#kanban .deal-row').nth(0)).toBeVisible();
  const restored = await browser.evaluate(() => ({
    urlOwner: new URL(location.href).searchParams.get('owner'),
    dellSelected: document.querySelector('[data-filter="dell"]').getAttribute('aria-pressed') === 'true',
    visibleRows: document.querySelectorAll('#kanban .deal-row').length,
  }));
  await app.screenshot('qa-027-list-after-reload');
  expect(restored).toEqual({ urlOwner: 'dell', dellSelected: true, visibleRows: 8 });
});
