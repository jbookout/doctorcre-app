import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { exerciseHome } from '../scripts/prove-home-fact-review-source-page-range.mjs';

test('Home renders original valid citations and refuses unsafe provenance before approval', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ baseURL: server.origin });
  await context.route('**/inbox?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.js"></script>' }));
  const page = await context.newPage();
  const assertions = await exerciseHome(page);
  assert.ok(assertions.every(result => result.passed));
  assert.ok(assertions.some(result => result.name === 'zero mutation RPC requests'));
});
