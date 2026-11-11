import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import { exerciseStage, recordings, observeNaturalStage } from '../scripts/prove-market-terms-recorded-stage-filter.mjs';

const records = recordings();
test('synthetic snapshots replay the exact producer bytes and pinned queries', () => {
  const dir = new URL('./fixtures/market-terms-recorded-stage-filter/', import.meta.url);
  const source = readFileSync(new URL('producer.txt', dir), 'utf8');
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', dir), 'utf8'));
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.producer.sha256);
  assert.equal(createHash('sha256').update(readFileSync(new URL('recordings.json', dir))).digest('hex'), provenance.recordings_sha256);
  const producer = { exports: {} };
  new Function('module', transformSync(source.slice(source.indexOf('export function rebuildMarketTerms('), source.indexOf('\nexport function marketTermsTools(')), { loader: 'ts', format: 'cjs' }).code)(producer);
  for (const record of Object.values(records)) assert.deepEqual(producer.exports.rebuildMarketTerms(record.snapshot, record.query), record.response);
});

test('stage selector combines exact predicates without reads, counts deals, clears, and retains or resets on refresh', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.goto(server.origin);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.body.innerHTML = '<main id="comparison"></main>'; }, theme);
        assert.equal((await exerciseStage(page, server.origin)).reads, 4);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.close(); }
});

test('dated refresh, malformed refusal, stale completions and selected terminal disposal', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(server.origin);
      await page.evaluate(async records => {
        document.body.innerHTML = '<main id="comparison"></main>';
        const { mountMarketTerms } = await import('/js/ui-market.generated.js');
        window.records = records; window.pending = [];
        window.mount = () => { window.panel = mountMarketTerms(document.querySelector('#comparison'), { entityRef: 'synthetic-a', client: { readMarketTerms: args => new Promise((resolve, reject) => window.pending.push({ resolve, reject, args })) } }); };
        window.mount(); window.panel.refresh(); window.pending[0].resolve(records.empty.response);
      }, records);
      const root = page.locator('#comparison'), stage = root.getByLabel('Recorded stage', { exact: true });
      assert.match(await root.textContent(), /Loading comparable terms/);
      await page.evaluate(() => window.pending[1].resolve(window.records.full.response));
      await stage.selectOption('executed');
      await root.locator('[name=submarket]').fill('North');
      await root.locator('[name=use_type]').fill('Medical');
      await root.locator('[name=as_of]').fill('2025-12-31');
      await root.getByRole('button', { name: 'Compare', exact: true }).click();
      await page.evaluate(() => { if (window.pending[2].args.as_of !== '2025-12-31') throw Error('query'); window.pending[2].resolve(window.records.before.response); });
      await stage.waitFor(); assert.equal(await stage.inputValue(), 'executed');
      assert.equal(await root.locator('.superseded').count(), 0);
      assert.match(await root.locator('tbody').textContent(), /2025-01-01 to 2026-01-01/);
      await root.locator('[name=as_of]').fill('2026-01-01');
      await root.getByRole('button', { name: 'Compare', exact: true }).click();
      await page.evaluate(() => window.pending[3].resolve(window.records.boundary.response));
      await stage.waitFor(); assert.equal(await root.locator('.superseded').count(), 0);
      assert.match(await root.locator('tbody').textContent(), /2026-01-01 to present/);
      await page.evaluate(() => { window.panel.refresh(); window.panel.refresh(); window.pending[5].resolve(window.records.full.response); });
      await stage.waitFor();
      await page.evaluate(() => window.pending[4].resolve(window.records.empty.response));
      assert.equal(await stage.inputValue(), 'executed');
      await page.evaluate(() => { window.panel.refresh(); window.panel.refresh(); window.pending[7].resolve({ ...window.records.full.response, rows: [null] }); });
      await root.getByText('Could not load comparable terms. Try again.').waitFor();
      await page.evaluate(() => window.pending[6].resolve(window.records.full.response));
      assert.equal(await stage.count(), 0);
      await page.evaluate(() => { window.panel.refresh(); window.pending[8].resolve(window.records.full.response); });
      await stage.waitFor(); assert.equal(await stage.inputValue(), 'executed');
      await page.evaluate(() => window.panel.dispose());
      assert.equal(await root.textContent(), '');
      for (const phase of ['loading', 'all', 'selected', 'empty', 'refused']) {
        await page.evaluate(({ phase, records }) => {
          window.pending = []; window.mount();
          if (phase !== 'loading') window.pending[0].resolve(phase === 'refused' ? null : records.full.response);
        }, { phase, records });
        if (phase !== 'loading' && phase !== 'refused') {
          await stage.waitFor();
          if (phase === 'selected' || phase === 'empty') await stage.selectOption('counter');
          if (phase === 'empty') await root.getByLabel('Term', { exact: true }).selectOption('TI');
        } else if (phase === 'refused') await root.getByText('Could not load comparable terms. Try again.').waitFor();
        if (phase === 'empty') {
          await page.evaluate(() => { window.panel.refresh(); window.pending[1].resolve(window.records.full.response); });
          await stage.waitFor();
        }
        await page.evaluate(() => { window.panel.dispose(); window.pending[0].resolve(window.records.full.response); });
        assert.equal(await root.textContent(), '', phase);
      }
    } finally { await page.close(); }
  } finally { await browser.close(); await server.close(); }
});

test('auth retirement directly clears ready selected, all and loading states and ignores late completion', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(server.origin);
      for (const phase of ['loading', 'all', 'selected']) {
        await page.evaluate(async ({ phase, records }) => {
          document.body.innerHTML = '<main id="comparison"></main>';
          const { mountMarketTerms } = await import('/js/ui-market.generated.js');
          const { createSessionBoundary } = await import('/js/private-session.js');
          window.panel = mountMarketTerms(document.querySelector('#comparison'), { entityRef: 'synthetic-a', client: { readMarketTerms: () => new Promise(resolve => { window.finish = resolve; }) } });
          window.boundary = createSessionBoundary({ fetchImpl: async () => new Response('', { status: 401 }), invalidate: () => window.panel.dispose() });
          if (phase !== 'loading') window.finish(records.full.response);
        }, { phase, records });
        if (phase !== 'loading') {
          const stage = page.getByLabel('Recorded stage', { exact: true });
          await stage.waitFor();
          if (phase === 'selected') await stage.selectOption('counter');
        }
        await page.evaluate(async records => { await window.boundary.verify().catch(() => {}); window.finish(records.full.response); }, records);
        assert.equal(await page.locator('#comparison').textContent(), '', phase);
      }
    } finally { await page.close(); }
  } finally { await browser.close(); await server.close(); }
});


test('natural observer counts the existing client read and restores fact-key subset', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    try {
      await page.route('**/mcp', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(records.full.response) }] } }) }));
      await page.goto(server.origin);
      await page.evaluate(async () => {
        document.body.innerHTML = '<main id="workspace-market-terms"></main>';
        const { mountMarketTerms } = await import('/js/ui-market.generated.js');
        const { createMcpRequests } = await import('/js/mcp-requests.mjs');
        const request = createMcpRequests({ fetchImpl: window.fetch.bind(window) });
        window.naturalPanel = mountMarketTerms(document.querySelector('main'), { entityRef: 'synthetic-a', client: { readMarketTerms: async args => (await request('read-market-terms', args)).payload } });
      });
      await page.getByLabel('Term', { exact: true }).selectOption('rent');
      const result = await observeNaturalStage(page);
      assert.equal(result.natural_rows, 6);
      assert.equal(result.selected_rows, 1);
      assert.equal(result.distinct_deals, 1);
      assert.equal(result.stage_diversity, 3);
      await page.evaluate(() => window.naturalPanel.dispose());
    } finally { await page.close(); }
  } finally { await browser.close(); await server.close(); }
});
