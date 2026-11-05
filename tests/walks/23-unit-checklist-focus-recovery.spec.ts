import { expect } from '@playwright/test';
import { test } from './privacy';
import { deal, needs } from './ui';

test("23 unit:checklist-focus-recovery", async ({ page }) => {
  await deal(page);
  const summary = page.locator('details.deal-checklist > summary');
  needs(!await summary.count(), 'test deal with checklist');
  await summary.focus();
  await summary.press('Enter');
  const evidence = page.locator('[data-checklist-item] summary').first();
  needs(!await evidence.count(), 'test checklist item with evidence');
  await evidence.focus();
  await evidence.press('Enter');
  const refresh = page.locator('[data-refresh-detail]').first();
  await refresh.click();
  await expect.poll(() => refresh.isEnabled()).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.matches('[data-detail-focus]'))).toBe(true);
  const states = await page.locator('[data-checklist-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-state')));
  needs(!states.includes('received') || !states.includes('complete'), 'test checklist containing received and complete items');
  expect(states.includes('received') && states.includes('complete')).toBe(true);
});
