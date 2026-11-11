import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { assertAnswerSourceVersions } from '../scripts/prove-answer-source-safe-version.mjs';

test('mountAnswerBlocks refuses unsafe sources at phone and desktop widths in both themes', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [390,1280]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({viewport:{width,height:900},colorScheme:theme});
    try {
      await page.goto(`${server.origin}/doc-chats`);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const results = await page.evaluate(assertAnswerSourceVersions);
      assert.ok(results.length > 20);
      assert.ok(results.every(result => result.passed));
    } finally { await page.close(); }
  });
});
