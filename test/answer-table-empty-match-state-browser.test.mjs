import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { assertAnswerTables } from '../scripts/prove-answer-table-empty-match-state.mjs';
import { transform } from 'esbuild';
const recordings = JSON.parse(await readFile(new URL('./fixtures/answer-table-empty-match-state/recordings.json', import.meta.url)));
test('recorded answer empty states, controls, independent tables and retirement', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390,1280]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({viewport:{width,height:900}, colorScheme:theme});
    try {
      await page.route('**/__answer-table-test', route => route.fulfill({contentType:'text/html',body:'<!doctype html><link rel="stylesheet" href="/css/app.css"><body></body>'}));
      await page.goto(`${server.origin}/__answer-table-test`);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      let reads = 0;
      page.on('request', request => { if (!request.url().startsWith(server.origin + '/js/')) reads++; });
      const results = await page.evaluate(assertAnswerTables, recordings);
      assert.ok(results.length > 30 && results.every(result => result.passed));
      assert.equal(reads, 0, 'local operations issue no reads or asks');
    } finally { await page.close(); }
  });
});

test('fixtures replay the pinned actual producer and pass the production response parser', async () => {
  const root = new URL('./fixtures/answer-table-empty-match-state/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)));
  const source = await readFile(new URL('producer.txt', root), 'utf8');
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.producer_sha256);
  const { recordedCompsTable } = await import('data:text/javascript,' + encodeURIComponent(source.slice(source.indexOf('export async function recordedCompsTable'))));
  const { code } = await transform(await readFile('src/ui/answer-block-model.ts','utf8'), {loader:'ts',format:'esm'});
  const { parseAnswerBlocks } = await import('data:text/javascript,' + encodeURIComponent(code));
  for (const [name, comps] of [['populated',provenance.query_rows],['empty',provenance.empty_query_rows]]) {
    const table = await recordedCompsTable({query:async (sql, ids) => {
      assert.equal(sql,provenance.query); assert.deepEqual(ids,[provenance.deal_ids]);
      return {rows:[{missing:false,comps}]};
    }},provenance.deal_ids,Error);
    assert.deepEqual([table],recordings[name]);
    assert.equal(parseAnswerBlocks(recordings[name]).kind,'valid');
  }
});
