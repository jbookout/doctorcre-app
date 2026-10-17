import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Ideas opens its shell and board while external fonts never respond', async ({ page }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return;
    if (url.origin !== 'https://ideas.fixture.test') return route.abort();
    const path = url.pathname === '/ideas-events' ? '/ideas.html' : url.pathname;
    if (!/^\/(?:ideas\.html|manifest\.webmanifest|(?:css|js|public-shell|tours|data|contracts)\/[^?]*)$/.test(path) || path.includes('..')) return route.abort();
    const contentType = path.endsWith('.js') || path.endsWith('.mjs') ? 'text/javascript'
      : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2'
        : path.endsWith('.json') ? 'application/json' : 'text/html';
    try {
      await route.fulfill({ contentType, body: await readFile(new URL('../..' + path, import.meta.url)) });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  await page.goto('https://ideas.fixture.test/ideas-events', { timeout: 3000 });
  await expect(page.getByRole('button', { name: 'Joe: account and settings', exact: true })).toBeVisible();
  await expect(page.locator('#ideaStatusLabel')).toHaveText('Current');
  await page.locator('#ideaSearch').fill('Synthetic search');
  await expect(page.locator('#ideaSearch')).toHaveValue('Synthetic search');
  expect(await page.evaluate(async () => {
    const fonts = ['500 16px "Barlow Condensed"', '600 16px "Barlow Condensed"', '700 16px "Barlow Condensed"',
      '400 16px "DM Sans"', '500 16px "DM Sans"', '600 16px "DM Sans"', '700 16px "DM Sans"'];
    return Promise.all(fonts.map(async font => {
      const loaded = await document.fonts.load(font, 'Synthetic ŽĐệ');
      return loaded.length > 0 && loaded.every(face => face.status === 'loaded');
    }));
  })).toEqual([true, true, true, true, true, true, true]);
});
