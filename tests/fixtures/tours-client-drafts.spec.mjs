import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const clientId = '11111111-1111-4111-8111-111111111111';
const client = { id: clientId, name: 'Synthetic Practice', city: 'Synthetic City', state: 'FL', vertical: 'Synthetic specialty', notes: 'Synthetic client notes' };

for (const width of [390, 820, 1440]) for (const theme of ['light', 'dark']) {
  test(`Tour client drafts and Research work at ${width} ${theme}`, async ({ page }, testInfo) => {
    let failDetail = false;
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://localhost') return route.abort();
      if (url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-fixture' } });
      if (url.pathname === `/api/v1/business/clients/${clientId}` && failDetail) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      if (url.pathname.startsWith('/api/')) {
        const data = url.pathname === '/api/tours/library' ? { tours: [] }
          : url.pathname === `/api/v1/business/clients/${clientId}` ? { record: client }
          : url.pathname === '/api/v1/business/clients' ? { rows: [client], page: 1, page_count: 1 } : {};
        return route.fulfill({ json: { data, csrf_token: 'synthetic-fixture', actor: { slug: 'joe' }, items: [], counts: {} } });
      }
      const file = url.pathname === '/tours' ? 'tours/index.html' : url.pathname.slice(1);
      try {
        const body = await readFile(new URL('../../' + file, import.meta.url));
        return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://localhost/tours');
    await expect(page.locator('#planner-updated')).toContainText('Updated');
    await page.locator('#space-client').selectOption(clientId);
    await expect(page.locator('#space-area')).toHaveValue('Synthetic City, FL');
    await page.locator('#space-area').fill('Synthetic saved region');
    await page.locator('#space-minSize').fill('2100');
    await page.locator('#space-use').fill('');
    await page.locator('#space-client').selectOption('');
    await page.locator('#space-client').selectOption(clientId);
    await expect(page.locator('#space-minSize')).toHaveValue('2100');
    await expect(page.locator('#space-use')).toHaveValue('');
    failDetail = true;
    await page.locator('#plan-client').selectOption(clientId);
    await expect(page.locator('#plan-client-retry')).toBeVisible();
    await page.locator('#plan-name').fill('Synthetic retained tour');
    await page.locator('#review-packet').click();
    await expect(page.locator('#tour-dialog')).not.toBeVisible();
    await expect(page.locator('#plan-message')).toContainText('Client details temporarily unavailable.');
    failDetail = false;
    await page.locator('#plan-client-retry').click();
    await expect(page.locator('#plan-client-retry')).toBeHidden();
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic retained tour');
    await expect(page.locator('#plan-area')).toHaveValue('Synthetic saved region');
    await page.locator('#plan-purpose').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('client-draft.png'), fullPage: true });
    await page.locator('#plan-purpose').selectOption('research');
    await expect(page.locator('#plan-client-picker')).toBeHidden();
    await page.locator('#plan-name').fill('Synthetic Research');
    await page.locator('#review-packet').click();
    await expect(page.locator('#tour-dialog')).toBeVisible();
    await expect(page.locator('#detail-content')).toContainText('Research');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('#plan-purpose')).toHaveValue('research');
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Research');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#plan-purpose').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('research-draft.png'), fullPage: true });
  });
}
