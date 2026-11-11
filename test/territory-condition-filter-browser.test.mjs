import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { exerciseConditionFilter, territoryResponse } from '../scripts/prove-territory-condition-filter.mjs';

const assets = await uiAssets(path => readFile(path, 'utf8'));
for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
  test(`condition lifecycle at ${width} ${colorScheme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme });
    await page.route('https://**', route => route.abort());
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), colorScheme);
    await page.route('**/js/**', route => {
      const bytes = assets.get(new URL(route.request().url()).pathname.slice(1));
      return bytes ? route.fulfill({contentType:'text/javascript', body:bytes}) : route.abort();
    });
    await page.goto(server.url);
    const results = await page.evaluate(exerciseConditionFilter, territoryResponse);
    assert.ok(results.length > 30);
    assert.ok(results.every(result => result.passed));
  });
}
