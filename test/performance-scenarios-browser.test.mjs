import test from 'node:test';
import assert from 'node:assert/strict';
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
  const screen = screens.find(screen => screen.id === 'relationships');
  await page.goto(server.url + screen.route, { waitUntil: 'networkidle' });
  await page.locator(screen.ready).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator(screen.tap).first().tap();
  await page.waitForFunction(screen.complete);
  assert.match(await page.locator('.relationship-dialog').innerText(), /Demo Healthcare Lending/);
  assert.match(await page.locator('.relationship-dialog').innerText(), /Can introduce/);
});
