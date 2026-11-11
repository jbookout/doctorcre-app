import test from 'node:test';
import assert from 'node:assert/strict';
import { componentDocument, chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import { marketTermsFixtures, marketTermsRecordings } from './fixtures/market-terms.mjs';
import { exerciseFilter } from '../scripts/prove-market-terms-fact-filter.mjs';

test('recorded market terms replay the pinned producer and reject impossible coverage or missing metadata', () => {
  const recording = marketTermsRecordings();
  const source = readFileSync(new URL('./fixtures/market-terms/producer.ts.txt', import.meta.url), 'utf8');
  assert.equal(recording.producer.revision, '3df973ff0c2f21e257e5467d41f5d69e62adfdfd');
  assert.equal(recording.producer.sha256, '94c8f087cd7cfed71439f76445a3905ff441b28488b2037982b2e80fda53a0c2');
  assert.equal(createHash('sha256').update(source).digest('hex'), recording.producer.sha256);
  // Execute the unchanged pure projection without its database/registration imports.
  const projection = source.slice(source.indexOf('export function rebuildMarketTerms('), source.indexOf('\nexport function marketTermsTools('));
  const producer = {exports:{}};
  new Function('module', transformSync(projection, {loader:'ts',format:'cjs'}).code)(producer);
  const verify = record => assert.deepEqual(producer.exports.rebuildMarketTerms(record.snapshot, record.query), record.response, 'equals pinned producer');
  for (const record of Object.values(recording.records)) verify(record);
  assert.equal(Object.keys(marketTermsFixtures()).length, 5);
  for (const mutate of [
    response => { response.coverage.comparable_deals = 99; },
    response => { delete response.rows[0].source_coverage; },
    response => { delete response.rows[0].context_source.reviewed_by_actor_id; },
  ]) {
    const record = structuredClone(recording.records.full);
    mutate(record.response);
    assert.throws(() => verify(record), /equals pinned producer/);
  }
});

test('fact selector filters locally, retains refresh selection, resets missing keys and recovers malformed receipts', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await componentDocument(page, server.origin, { dispose: page => page.evaluate(() => window.panel?.dispose()) });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.body.innerHTML = '<main id="comparison"></main>'; }, theme);
        const result = await exerciseFilter(page, server.origin);
        assert.equal(result.reads, 6);
        assert.equal(result.local_changes_without_reads, true);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.close(); }
});

test('stale refresh cannot replace selected results and parent disposal clears pending work', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await componentDocument(page, server.origin, { dispose: page => page.evaluate(() => window.panel?.dispose()) });
    await page.evaluate(async fixtures => {
      document.body.innerHTML = '<main id="comparison"></main>';
      const { mountMarketTerms } = await import('/js/ui-market.generated.js');
      window.pending = [];
      window.response = fixtures.single;
      window.emptyResponse = fixtures.empty;
      window.panel = mountMarketTerms(document.querySelector('#comparison'),{entityRef:'synthetic-a',client:{readMarketTerms:() => new Promise(resolve => window.pending.push(resolve))}});
      window.panel.refresh();
      window.pending[0](window.emptyResponse);
    }, marketTermsFixtures());
    assert.match(await page.locator('#comparison').textContent(), /Loading comparable terms/);
    await page.evaluate(() => window.pending[1](window.response));
    const term = page.getByLabel('Term',{exact:true});
    await term.selectOption('rent');
    await page.getByText('Firm-wide coverage (not filtered)',{exact:true}).click();
    await page.locator('summary').click();
    await page.evaluate(() => { window.panel.refresh(); window.panel.refresh(); window.pending[3](window.response); });
    await term.waitFor();
    assert.equal(await term.inputValue(),'rent');
    await page.evaluate(() => window.pending[2](window.emptyResponse));
    assert.equal(await term.inputValue(),'rent');
    await page.evaluate(() => window.panel.dispose());
    assert.equal(await page.locator('#comparison').textContent(),'');
    await page.evaluate(async () => {
      const { mountMarketTerms } = await import('/js/ui-market.generated.js');
      window.panel = mountMarketTerms(document.querySelector('#comparison'), {entityRef:'synthetic-a',client:{readMarketTerms:() => new Promise(resolve => window.pending.push(resolve))}});
      window.panel.dispose();
      window.pending[4](window.response);
    });
    assert.equal(await page.locator('#comparison').textContent(),'');
    await page.close();
  } finally { await browser.close(); await server.close(); }
});
