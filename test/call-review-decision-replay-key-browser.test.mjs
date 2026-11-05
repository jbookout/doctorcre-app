import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { exercise } from '../scripts/prove-call-review-decision-replay-key.mjs';
for (const width of [390, 1440]) test(`explicit decision recovery through public mount at ${width}px`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.goto(server.origin);
    assert.equal((await page.evaluate(exercise, server.origin + '/js/ui-call.js')).length, 4);
  } finally { await page.close(); await browser.close(); await server.close(); }
});
