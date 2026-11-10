import { expect } from '@playwright/test';
import { test } from './privacy';
import { deal, needs, tab, visible } from './ui';

test("24 unit:checklist-unavailable", async ({ page }) => {
  await deal(page, 24);
  const checklist = page.getByRole('region', { name: 'Deal checklist', exact: true });
  needs(!await checklist.count(), 'TEST WALK 24 deal with naturally unavailable checklist source');
  expect(await checklist.innerText().then(text => /unavailable/i.test(text))).toBe(true);
  expect(await checklist.getByRole('button', { name: 'Refresh deal', exact: true }).isVisible()).toBe(true);
  expect(await checklist.locator('[data-checklist-item]').count()).toBe(0);
  await tab(page, /^Documents$/);
  await visible(page.getByRole('heading', { name: 'Documents', exact: true }));
});
