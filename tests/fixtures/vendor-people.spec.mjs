import { test, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { directoryFixture } from '../../test/fixtures/vendor-directory.synthetic.mjs';

test.use({
  baseURL: async ({}, use) => {
    const server = await startFixtureServer();
    try { await use(server.url); } finally { await server.stop(); }
  },
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`Vendor contacts keep office evidence separate from territory at ${width}px ${theme}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const reads = [];
  await page.route('https://**', route => route.abort());
  await page.route('**/api/v1/business/**', route => {
    reads.push(new URL(route.request().url()));
    return route.fulfill({ json: directoryFixture(route.request().url()) });
  });
  await page.goto('/vendors');
  const first = page.locator('.record-row').first();
  await first.click();
  const contacts = page.getByRole('region', { name: 'Vendor contacts' });
  await expect(contacts).toBeVisible();
  await expect(contacts.getByText('Demo Contact Alpha', { exact: true })).toBeVisible();
  await expect(contacts.getByText('1 Demo Plaza', { exact: false })).toBeVisible();
  await expect(contacts.getByText('Recorded territory', { exact: true })).toBeVisible();
  await expect(contacts.getByText('Demo South', { exact: true })).toBeVisible();
  await expect(contacts.getByText('Office not recorded', { exact: true })).toHaveCount(2);
  await expect(contacts.getByText('Not researched', { exact: true })).toBeVisible();
  await expect(contacts.getByText('Needs review', { exact: true })).toBeVisible();
  await expect(contacts.getByText('Email not recorded', { exact: true })).toHaveCount(3);
  await expect(contacts.getByText('Phone not recorded', { exact: true })).toHaveCount(3);
  await expect(contacts.getByText('Synthetic office evidence', { exact: false })).toBeVisible();
  await expect(page.locator('#recordPanel')).not.toContainText(/Service coverage|Ready to meet|Enrichment queued/);
  expect(reads.find(url => /vendors\/[^/]+$/.test(url.pathname)).searchParams.get('contract')).toBe('vendor-directory.v2');
  expect(reads.find(url => url.pathname.endsWith('/vendors')).searchParams.get('contract')).toBe('vendor-directory.v1');
  await page.screenshot({ path: testInfo.outputPath(`vendor-contacts-${width}-${theme}.png`) });
  await page.keyboard.press('Escape');
  await expect(page.locator('#recordPanel')).toBeHidden();
  await expect(first).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
