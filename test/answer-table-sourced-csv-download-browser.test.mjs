import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { assertSourcedCsv } from '../scripts/prove-answer-table-sourced-csv-download.mjs';
const recordings = JSON.parse(await readFile(new URL('./fixtures/answer-table-sourced-csv-download/recordings.json', import.meta.url)));
test('sourced CSV selection, lifecycle, escaping and zero business calls', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390,1280]) for (const theme of ['light','dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({viewport:{width,height:1000}});
    try {
      await page.route('**/__csv-component', r => r.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
      await page.goto(server.origin + '/__csv-component');
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.evaluate(() => import('/js/ui-answers.generated.js').then(() => {}));
      const requests = [];
      page.on('request', request => requests.push(request.url()));
      const result = await page.evaluate(assertSourcedCsv, recordings);
      assert.deepEqual(requests, [], 'CSV actions add zero network requests');
      assert.ok(result.length > 20);
    } finally { await page.close(); }
  });
});

test('keyboard saves a real local CSV without changing the visible table', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({acceptDownloads:true}); t.after(() => page.close());
  await page.route('**/__csv-component', r => r.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
  await page.goto(server.origin + '/__csv-component');
  await page.evaluate(async blocks => {
    const api = await import('/js/ui-answers.generated.js');
    api.mountAnswerBlocks(document.body,blocks,'keyboard');
  }, recordings.populated);
  await page.getByRole('button',{name:'Proposed rent ($/SF/year)',exact:true}).click();
  await page.getByRole('searchbox').fill('Beta');
  const action = page.getByRole('button',{name:'Download visible rows'});
  await action.focus();
  const pending = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const download = await pending;
  assert.equal(download.suggestedFilename(),'answer-comps.csv');
  const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(),/Synthetic Beta/);
  assert.equal(await page.getByRole('searchbox').inputValue(),'Beta');
  assert.equal(await page.locator('tbody tr').count(),1);
  assert.equal(await action.evaluate(node => node === document.activeElement),true);
  assert.match(await page.locator('.answer-table').textContent(),/Exported 1 row/);
});

test('fixture reproduces pinned real recordedCompsTable producer and query provenance', async () => {
  const root = new URL('./fixtures/answer-table-sourced-csv-download/',import.meta.url);
  const source = await readFile(new URL('producer.txt',root),'utf8');
  const provenance = JSON.parse(await readFile(new URL('provenance.json',root)));
  assert.equal(createHash('sha256').update(source).digest('hex'),provenance.producer_sha256);
  const producer = await import('data:text/javascript;base64,' + Buffer.from(source.slice(source.indexOf('export async function recordedCompsTable'))).toString('base64'));
  for (const [name,rows] of [['populated',provenance.query_rows],['empty',provenance.empty_query_rows]]) {
    let calls = 0;
    const client = {async query(query,inputs) {
      calls++; assert.equal(query,provenance.query); assert.deepEqual(inputs,[provenance.deal_ids]);
      return {rows:[{missing:false,comps:rows}]};
    }};
    const table = await producer.recordedCompsTable(client,provenance.deal_ids,Error);
    assert.deepEqual([table],recordings[name]); assert.equal(calls,1);
  }
});
