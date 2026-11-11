import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { syntheticBoard, exerciseHomeDates } from '../scripts/prove-home-next-step-touch-date-integrity.mjs';
for (const width of [390, 1440]) for (const timezoneId of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
  test(`Home date dispositions, expansion, scope, focus and disposal at ${width} ${timezoneId}`, async t => {
    const fixture = await startFixtureServer(); t.after(() => fixture.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId });
    await page.goto(fixture.url);
    const results = await page.evaluate(exerciseHomeDates, await syntheticBoard());
    assert.ok(results.length >= 30); assert.ok(results.every(result => result.passed));
  });
}
