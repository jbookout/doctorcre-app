import { expect } from '@playwright/test';
import { test } from './privacy';
import { card, needs } from './ui';

test("08 WR617.S10", async ({ page }) => {
  const row = await card(page);
  await row.locator('h3 a').click();
  const source = row.getByRole('link', { name: /Open source record/ });
  needs(!await source.count(), 'completed test Doc answer with table and chart');
  const href = await source.getAttribute('href');
  needs(!href?.startsWith('/doc-chats'), 'completed test Doc answer with table and chart');
  await source.click();
  needs(!await page.locator('.answer-table').count() || !await page.locator('.answer-chart').count(), 'test answer containing both table and chart');
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    const themeButton = page.getByRole('button', { name: 'Dark mode', exact: true });
    if (await page.locator('html').getAttribute('data-theme') !== theme) await themeButton.click();
    const heading = page.locator('.answer-table th').first();
    await heading.getByRole('button').focus();
    await page.keyboard.press('Enter');
    expect(['ascending', 'descending'].includes(await heading.getAttribute('aria-sort') || '')).toBe(true);
    const point = page.locator('.answer-chart [tabindex="0"]').first();
    await point.focus();
    expect(await point.evaluate(node => document.activeElement === node)).toBe(true);
    expect(await page.locator('.answer-table table').isVisible()).toBe(true);
    expect(await page.locator('.answer-source').count() > 0).toBe(true);
  }
});
