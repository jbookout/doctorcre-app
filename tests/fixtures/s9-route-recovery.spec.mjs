import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { routeLeads } from '../../test/leads-browser-fixture.mjs';
import { workspace, id } from '../../test/leads-workspace-fixture.mjs';
import { detail, tourId } from '../../test/fixtures/tour-day.synthetic.mjs';

test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({ path: testInfo.outputPath("route.png"), fullPage: true });
});

async function tourPage(page, { accepted = false, failedLibrary = false } = {}) {
  const tour = structuredClone(detail);
  tour.name = `Synthetic ${tourId} draft tour`;
  tour.routes[0].accepted = accepted;
  if (!accepted) tour.routes[0].stops.forEach(stop => { stop.stop_state = 'excluded'; stop.route_sequence = null; stop.route_label = null; });
  tour.route_version_id = tour.routes[0].id;
  tour.route_version_state = accepted ? 'accepted' : 'draft';
  tour.accepted_route_version = accepted ? 1 : 0;
  tour.routes[0].acceptance_digest = 'sha256:' + 'a'.repeat(64);
  tour.stops.forEach(stop => { stop.locked_appointment = false; });
  let fail = failedLibrary;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/api/tours/library' && fail) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    if (url.pathname.startsWith('/api/')) {
      const data = url.pathname === '/api/tours/library' ? { tours: [{ id: tourId, name: tour.name, status: 'draft' }] }
        : url.pathname === '/api/tours/detail' ? tour
        : url.pathname === '/api/tours/property-evidence' ? { schema: 'tour-property-evidence.v1', facts: {} } : {};
      return route.fulfill({ json: { data, csrf_token: 'synthetic-fixture', actor: { slug: 'joe' }, items: [], counts: {} } });
    }
    if (url.pathname === '/mcp') return route.fulfill({ json: { result: { content: [{ type: 'text', text: '{"ok":true,"deals":[]}' }] } } });
    const file = url.pathname.slice(1);
    try {
      const body = await readFile(new URL('../../' + file, import.meta.url));
      return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { recover() { fail = false; } };
}

for (const theme of ['light', 'dark']) test(`Leads mobile keeps stage context and switches past 43 New cards in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), theme);
  await routeLeads(page, { getBoard() {
    const board = workspace(), source = board.leads.find(lead => lead.stage === 'new');
    board.leads = [...Array.from({ length: 43 }, (_, i) => ({ ...source, id: id(1000 + i), company: `Synthetic New ${i}`, owner: 'joe' })), ...board.leads.filter(lead => lead.stage !== 'new')];
    return board;
  } });
  await page.goto('http://localhost/leads?mode=live');
  const stage = page.getByRole('combobox', { name: 'Board stage' });
  await expect(stage).toBeVisible();
  await expect(page.locator('.stage-column:visible')).toHaveCount(1);
  await expect(page.locator('.stage-column:visible')).toHaveAttribute('data-stage', 'new');
  await expect(page.locator('body')).toHaveClass(/has-app-layout/);
  await page.locator('#leadBoard .lead-card').nth(30).evaluate(node => node.scrollIntoView());
  await expect(stage).toBeInViewport();
  await stage.selectOption('qualified');
  await expect(page.locator('.stage-column:visible')).toHaveAttribute('data-stage', 'qualified');
  await expect(stage).toBeInViewport();
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Itinerary draft prioritizes editing and folds excluded stops at ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), theme);
  await tourPage(page);
  await page.goto(`http://localhost/tours/route-editor.html?tour=${tourId}`);
  await expect(page.locator('#tour-panel')).toBeVisible();
  await expect(page.locator('#save-composer')).toBeVisible();
  for (const name of ['reconcile', 'retry', 'reload']) await expect(page.locator(`#${name}-composer`)).toBeHidden();
  const stop = page.locator('.composer-stop').first();
  await expect(stop.locator('[data-field="stop_state"]')).toBeVisible();
  await expect(stop.locator('[data-field="dwell_minutes"]')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('excluded-collapsed.png'), fullPage: true });
  await stop.locator('.stop-edit-details > summary').click();
  await expect(stop.locator('[data-field="dwell_minutes"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Itinerary failed library retries next to its message', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await tourPage(page, { failedLibrary: true });
  await page.goto('http://localhost/tours/route-editor.html');
  const retry = page.getByRole('button', { name: 'Retry tour library', exact: true });
  await expect(retry).toBeVisible();
  fixture.recover(); await retry.click();
  await expect(page.locator('#empty-tours button')).toHaveCount(1);
  await expect(retry).toBeHidden();
});

for (const accepted of [false, true]) for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Tour day ${accepted ? 'accepted route' : 'draft recovery'} at ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), theme);
  await tourPage(page, { accepted });
  await page.goto(`http://localhost/tours/day.html?tour=${tourId}`);
  await expect(page.locator('#day-title')).toHaveText('Synthetic draft tour');
  if (accepted) {
    await expect(page.locator('.day-stop')).toHaveCount(2);
    await expect(page.locator('#day-current')).toContainText('Demo waterfront office');
    await page.locator('.day-stop').last().click();
    await expect(page.locator('#day-current')).toContainText('Demo garden suites');
    await expect(page.locator('#day-map a.day-empty-link')).toHaveCount(0);
  } else {
    const recovery = page.getByRole('link', { name: 'Review route in Itinerary' });
    await expect(recovery).toHaveAttribute('href', `/tours/route-editor.html?tour=${tourId}`);
    await expect(recovery).toBeVisible();
    await expect(page.locator('#day-record')).toBeDisabled();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
