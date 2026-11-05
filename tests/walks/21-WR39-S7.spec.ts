import { test, expect } from '@playwright/test';
import './privacy';
import { deal, needs } from './ui';

test("21 WR39.S7", async ({ page }) => {
  await deal(page);
  const checklist = page.locator('details.deal-checklist');
  needs(!await checklist.count(), 'test deal with closing checklist');
  await checklist.locator(':scope > summary').click();
  const received = checklist.locator('[data-state="received"]');
  const completed = checklist.locator('[data-state="complete"]');
  needs(!await received.count() || !await completed.count(), 'test checklist with both received and complete document evidence');
  expect(await received.first().locator('strong').innerText() === 'Received').toBe(true);
  expect(await completed.first().locator('strong').innerText() === 'Recorded complete').toBe(true);
  for (const item of [received.first(), completed.first()]) {
    await item.locator('summary').click();
    expect(await item.locator('details p').innerText().then(text => /[0-9a-f]{8}-/i.test(text))).toBe(true);
  }
  needs(true, 'existing missing-document request with stored document IDs visible through app');
});
