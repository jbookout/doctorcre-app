import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { routeContract } from '../../js/routes.js';
import { censusResponse } from '../../scripts/work-inventory-fixture.mjs';

test('Inbox keeps at least 720px above the phone shell in both themes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/api/v1/work-inventory') return route.fulfill({ json: censusResponse(url) });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    const file = routeContract.routes[url.pathname] || url.pathname.slice(1);
    try {
      return route.fulfill({ body: await readFile(new URL(`../../${file}`, import.meta.url)),
        contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/control-room?tab=inbox');
  await expect(page.locator('#panelInbox')).toBeVisible();
  await expect(page.locator('#callModeAvailability')).toHaveText('Call recording runs on the Mac with Quill');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await testInfo.attach(`inbox-390-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    const contentBottom = await page.locator('.app-layout-status, #appShell').evaluateAll(bars => Math.min(...bars.filter(bar => bar.getClientRects().length).map(bar => bar.getBoundingClientRect().top)));
    expect(contentBottom, `${theme} Inbox space above the persistent shell`).toBeGreaterThanOrEqual(720);
  }
  await page.route('http://127.0.0.1:4682/**', route => route.fulfill({
    json: { state: 'recording', started_at: new Date().toISOString() },
  }));
  await page.locator('#selfAvatar').click();
  await page.getByRole('button', { name: 'Recheck Quill' }).click();
  await expect(page.locator('#callModeButton')).toHaveClass(/recording/);
  await page.keyboard.press('Escape');
  expect(await page.locator('#selfAvatar').evaluate(avatar => getComputedStyle(avatar, '::after').width)).toBe('8px');
});
