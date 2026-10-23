import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath("route.png"), fullPage: true });
});

async function assets(page) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['http://localhost', 'https://app.doctorcre.com'].includes(url.origin)) return route.abort();
    if (url.pathname === '/auth/session') return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-fixture'}});
    if (url.pathname === '/mcp') {
      const name = route.request().postDataJSON().params.name;
      const data = name === 'deal-room-board' ? { actor: 'joe', deals: [{ id: 'synthetic-deal', name: 'Synthetic dental office' }] }
        : name === 'get-deal-room' ? { deal_id: 'synthetic-deal', critical_dates: [{ id: 'synthetic-date', note: 'Option window', kind: 'option_window', due_on: '2026-10-20', status: 'open' }] } : {};
      return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(data) }] } } });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { data: { tours: [], clients: [] }, actor: { slug: 'joe' }, csrf_token: 'synthetic-fixture', items: [], counts: {} } });
    const file = url.pathname === '/calendar' ? 'calendar.html' : url.pathname === '/tours' ? 'tours/index.html' : url.pathname.slice(1);
    try {
      const body = await readFile(new URL('../../' + file, import.meta.url));
      return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Calendar event names read in full at ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.clock.install({ time: new Date('2026-10-18T12:00:00Z') });
  await assets(page);
  await page.goto('https://app.doctorcre.com/calendar?view=month&d=2026-10-18');
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  const label = page.locator('.cal-chip-label').filter({ hasText: 'Option window' });
  await expect(label).toBeVisible();
  expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth && getComputedStyle(node).whiteSpace !== 'nowrap')).toBe(true);
  await page.locator('.cal-chip').filter({ hasText: 'Option window' }).click();
  await expect(page.locator('#dayPanelBody')).toContainText('Option window');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Tours opens planning with readable territory choices at ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await assets(page);
  await page.goto('http://localhost/tours');
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  await expect(page.locator('body')).toHaveClass(/has-app-layout/);
  const choices = page.locator('.market-buttons button');
  await expect(choices).toHaveCount(5);
  for (const choice of await choices.all()) await expect(choice).toBeVisible();
  if (width === 390) {
    await expect(page.locator('.territory-map')).toBeHidden();
    expect((await page.locator('#plan-title').boundingBox()).y).toBeLessThan(450);
  } else {
    const font = await page.locator('.map-market text').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) * node.getScreenCTM().a);
    expect(font).toBeGreaterThanOrEqual(13);
  }
  await choices.filter({ hasText: 'Pensacola' }).click();
  await expect(page.locator('#space-area')).toHaveValue('Pensacola, FL');
});
