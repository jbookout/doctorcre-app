import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const fonts of ['held', 'available']) test(`Ideas opens its shell and board with ${fonts} optional font CSS`, async ({ page }) => {
  let fontRequests = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.googleapis.com') {
      fontRequests++;
      if (fonts === 'available') return route.fulfill({ contentType: 'text/css', body: ':root { --ideas-font-stylesheet-loaded: yes; }' });
      return;
    }
    if (url.hostname === 'fonts.gstatic.com') return route.abort();
    if (url.origin !== 'https://ideas.fixture.test') return route.abort();
    const path = url.pathname === '/ideas-events' ? '/ideas.html' : url.pathname;
    if (!/^\/(?:ideas\.html|manifest\.webmanifest|(?:css|js|public-shell|tours|data|contracts)\/[^?]*)$/.test(path) || path.includes('..')) return route.abort();
    const contentType = path.endsWith('.js') || path.endsWith('.mjs') ? 'text/javascript'
      : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html';
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
  await expect(page.locator('link[data-font-stylesheet]')).toHaveAttribute('rel', 'stylesheet');
  expect(fontRequests).toBeGreaterThan(0);
  if (fonts === 'available') await expect(page.locator('html')).toHaveCSS('--ideas-font-stylesheet-loaded', 'yes');
});
