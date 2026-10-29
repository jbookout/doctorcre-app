import { test, expect } from '@playwright/test';
import { navigationItems } from '../../js/routes.js';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';

test.use({ viewport: { width: 390, height: 844 } });

let server;
test.beforeAll(async () => { server = await startFixtureServer(); });
test.afterAll(async () => { await server?.stop(); });

for (const { label, href } of navigationItems) for (const theme of ['light', 'dark']) {
  test(`${label} fits a phone in ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.goto(`${server.url}${href}`);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('#appShell')).toBeAttached();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('body').evaluate(() => document.fonts.ready);
    const result = await page.evaluate(() => {
      const selectors = '[data-layout-slot="tabs"], [role="tablist"], [role="toolbar"], .app-section-tabs, .board-toolbar, .cal-toolbar, .cr-boards-toolbar, .queue-toolbar';
      const controls = [...document.querySelectorAll(selectors)].flatMap(group => [...group.querySelectorAll('button, a, [role="tab"]')]);
      const failures = [...new Set(controls)].flatMap(control => {
        const rect = control.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(control).visibility !== 'visible') return [];
        const lines = [];
        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const line of range.getClientRects()) if (line.width && line.height) lines.push(line);
        }
        const rows = [];
        for (const line of lines) {
          const row = rows.find(row => line.top < row.bottom && line.bottom > row.top);
          if (row) { row.top = Math.max(row.top, line.top); row.bottom = Math.min(row.bottom, line.bottom); }
          else rows.push({ top: line.top, bottom: line.bottom });
        }
        let clipped = rect.left < -0.5 || rect.right > innerWidth + 0.5 || lines.some(line => line.left < rect.left - 0.5 || line.right > rect.right + 0.5);
        for (let parent = control.parentElement; parent; parent = parent.parentElement) {
          if (!['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) continue;
          const bounds = parent.getBoundingClientRect();
          if (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5) clipped = true;
        }
        return clipped || rows.length > 1 ? [{ label: control.innerText, left: rect.left, right: rect.right, lines: rows.length }] : [];
      });
      return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, failures };
    });
    expect.soft(result.scrollWidth, 'document fits the viewport').toBeLessThanOrEqual(result.viewport);
    expect(result.failures, 'toolbar controls fit and labels stay on one line').toEqual([]);
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`Local Deals layout at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.goto(`${server.url}/deals`);
    await expect(page.locator('#boardView')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('body').evaluate(() => document.fonts.ready);
    await page.screenshot({ path: testInfo.outputPath(`local-deals-${width}-${theme}.png`), animations: 'disabled' });
    await page.locator('#listView').click();
    await expect(page.locator('#listView')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#boardView').click();
    await expect(page.locator('#boardView')).toHaveAttribute('aria-pressed', 'true');
  });
}
