import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { profile, screens } from '../scripts/performance-scenarios.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

test('the phone Relationships performance scenario opens the visible connection detail', async t => {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: profile.viewport, isMobile: true, hasTouch: true });
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  const scripts = new Map(), reads = [];
  page.on('response', response => {
    if (response.request().resourceType() === 'script') reads.push((async () => {
      assert.equal(response.ok(), true, response.url());
      scripts.set(response.url(), (await response.body()).length);
    })());
  });
  const screen = screens.find(screen => screen.id === 'relationships');
  await page.goto(server.url + screen.route, { waitUntil: 'networkidle' });
  await page.locator(screen.ready).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator(screen.tap).first().tap();
  await page.waitForFunction(screen.complete);
  assert.match(await page.locator('.relationship-dialog').innerText(), /Demo Healthcare Lending/);
  assert.match(await page.locator('.relationship-dialog').innerText(), /Can introduce/);
  await Promise.all(reads);
  const budget = JSON.parse(await readFile(new URL('../contracts/performance-budget.v1.json', import.meta.url)));
  const bytes = [...scripts.values()].reduce((total, size) => total + size, 0);
  assert.ok(bytes <= budget.screens.relationships.jsBytes.limit,
    `Relationships loaded ${bytes} JS bytes, budget ${budget.screens.relationships.jsBytes.limit}`);
});
