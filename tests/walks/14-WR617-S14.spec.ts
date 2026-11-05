import { test, expect } from '@playwright/test';
import './privacy';
import { card, complete, home, needs, undo } from './ui';

test("14 WR617.S14", async ({ page }) => {
  const row = await card(page, 14);
  const id = await complete(page, row);
  const check = await page.context().newPage();
  try {
    await home(check);
    const today = check.getByRole('region', { name: 'Done today', exact: true });
    expect(await today.locator(`[data-inbox-row=${JSON.stringify(id)}]`).count()).toBe(1);
    const stored = today.locator(`[data-inbox-row=${JSON.stringify(id)}] .inbox-detail`);
    expect(await stored.innerText().then(text => /[AP]M.*(?:CST|CDT)/.test(text))).toBe(true);
    const yesterday = check.getByRole('region', { name: 'Earlier and undated completions', exact: true }).locator('[data-inbox-row]').filter({ has: check.locator('h3 a').filter({ hasText: /^(?:test|qa) walk 14 yesterday/i }) });
    needs(!await yesterday.count(), 'TEST WALK 14 yesterday completion with newer activity');
    expect(await today.locator('[data-inbox-row]').filter({ hasText: /^(?:test|qa) walk 14 yesterday/i }).count()).toBe(0);
  } finally { await check.close(); await undo(page); }
});
