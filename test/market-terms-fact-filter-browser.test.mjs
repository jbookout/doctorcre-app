import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { exerciseFilter } from '../scripts/prove-market-terms-fact-filter.mjs';

test('fact selector filters locally, retains refresh selection, resets missing keys and recovers malformed receipts', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.goto(server.origin);
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
    await page.goto(server.origin);
    await page.evaluate(async () => {
      document.body.innerHTML = '<main id="comparison"></main>';
      const { mountMarketTerms } = await import('/js/ui-market.js');
      window.pending = [];
      window.response = {ok:true,schema_version:'market-terms.v1',rows:[{entity_ref:'d1',fact_key:'rent',value:'35',term_kind:'executed',term_date:'2025-01-01',effective_from:'2025-01-01'}],coverage:{comparable_deals:1,canonical_receipts:1,recorded_documents:1,unsupported_receipts:0,unclassified_receipts:0}};
      window.panel = mountMarketTerms(document.querySelector('#comparison'),{entityRef:'d1',client:{readMarketTerms:() => new Promise(resolve => window.pending.push(resolve))}});
      window.panel.refresh();
      window.pending[0]({...window.response,rows:[]});
    });
    assert.match(await page.locator('#comparison').textContent(), /Loading comparable terms/);
    await page.evaluate(() => window.pending[1](window.response));
    const term = page.getByLabel('Term',{exact:true});
    await term.selectOption('rent');
    await page.getByText('Firm-wide coverage (not filtered)',{exact:true}).click();
    await page.locator('summary').click();
    await page.evaluate(() => { window.panel.refresh(); window.panel.refresh(); window.pending[3](window.response); });
    await term.waitFor();
    assert.equal(await term.inputValue(),'rent');
    await page.evaluate(() => window.pending[2]({...window.response,rows:[]}));
    assert.equal(await term.inputValue(),'rent');
    await page.evaluate(() => { window.panel.refresh(); window.panel.dispose(); window.pending[4](window.response); });
    assert.equal(await page.locator('#comparison').textContent(),'');
    await page.close();
  } finally { await browser.close(); await server.close(); }
});
