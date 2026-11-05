import { expect } from '@playwright/test';
import { test } from './privacy';
import { deal, needs, visible } from './ui';

test("20 WR39.S6", async ({ page }) => {
  await deal(page);
  const open = page.locator('[data-open-terms]');
  if (await open.isVisible()) await open.click();
  await visible(page.locator('[data-terms-list]'));
  const history = page.locator('[data-canonical-history]').filter({ has: page.locator('ol li').nth(1) }).first();
  needs(!await history.count(), 'test term with at least two canonical versions');
  await history.locator('summary').first().click();
  const versions = history.locator('ol > li');
  expect(await versions.count() >= 2).toBe(true);
  for (let n = 0; n < await versions.count(); n++) {
    expect(await versions.nth(n).locator('time[datetime]').count() > 0).toBe(true);
    expect(await versions.nth(n).innerText().then(text => /(?:Page|citation unavailable)/i.test(text))).toBe(true);
  }
  expect(await history.innerText().then(text => /Current/.test(text) && /Superseded/.test(text))).toBe(true);
});
