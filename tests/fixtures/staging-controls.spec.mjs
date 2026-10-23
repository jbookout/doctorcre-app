import { test } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { directoryFixture } from '../../test/fixtures/vendor-directory.synthetic.mjs';

test.use({
  baseURL: async ({}, use) => {
    const server = await startFixtureServer();
    try { await use(server.url); } finally { await server.stop(); }
  },
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/business/**', route => route.fulfill({
    json: directoryFixture(route.request().url()),
  }));
  await page.route('**/api/system-work/session', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ actor: { slug: 'joe', display_name: 'Joe' } }),
  }));
  await page.addInitScript(() => localStorage.setItem('doctorcre:today:/deals', 'closed'));
});

import '../staging/clients.spec.ts';
import '../staging/invoices.spec.ts';
import { parkedDeals } from '../staging/journey-flows.mjs';

test('Local Deals shows parked records and recent changes read-only', async ({ page }) => {
  await parkedDeals(page);
});
