import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { exerciseTerritoryEvidence } from '../scripts/prove-territory-evidence-calendar-integrity.mjs';

for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
  test(`calendar integrity transitions at ${width}px ${colorScheme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme });
    await page.goto(server.url);
    const results = await page.evaluate(exerciseTerritoryEvidence);
    assert.ok(results.length > 30);
    assert.ok(results.every(result => result.passed));
  });
}
