import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import { chromium, fixtureServer } from './browser-harness.mjs';
const dir = new URL('./fixtures/terms-expense-basis/', import.meta.url);
const records = JSON.parse(readFileSync(new URL('recordings.json', dir))).records;
const key = value => value?.trim() ? JSON.stringify(value) : 'missing';

test('pinned registered producer and production parser accept all synthetic snapshots', () => {
  const source = readFileSync(new URL('producer.txt', dir), 'utf8');
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', dir)));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(source), provenance.producer.sha256);
  assert.equal(hash(readFileSync(new URL('recordings.json', dir))), provenance.recordings_sha256);
  const producer = { exports: {} };
  new Function('module', transformSync(source.slice(source.indexOf('export function rebuildMarketTerms('), source.indexOf('\nexport function marketTermsTools(')), { loader: 'ts', format: 'cjs' }).code)(producer);
  const ui = readFileSync(new URL('../src/ui/market-terms.tsx', import.meta.url), 'utf8');
  const parser = 'function isRecord' + ui.split('function isRecord')[1].split('\nfunction Comparison')[0].split('\nfunction basisKey')[0];
  assert.equal(parser.slice('function isRecord'.length), provenance.parser.bytes);
  const accepts = new Function(transformSync(parser, { loader: 'ts' }).code + '\nreturn isResponse;')();
  for (const record of Object.values(records)) {
    assert.deepEqual(producer.exports.rebuildMarketTerms(record.snapshot, record.query), record.response);
    assert.equal(accepts(record.response), true);
  }
});

test('basis keyboard selection intersects loaded term and stage in both themes and widths', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.goto(server.origin);
        await page.evaluate(async ({ records, theme }) => {
          document.documentElement.dataset.theme = theme;
          document.body.innerHTML = '<main id="comparison"></main>';
          const { mountMarketTerms } = await import('/js/ui-market.generated.js');
          window.reads = 0;
          window.panel = mountMarketTerms(document.querySelector('main'), { entityRef: 'synthetic-a', client: { readMarketTerms: async () => { window.reads++; return records.full.response; } } });
        }, { records, theme });
        const basis = page.getByLabel('Expense basis', { exact: true });
        await basis.waitFor({ timeout: 1500 });
        assert.deepEqual(await basis.locator('option').allTextContents(), ['All expense bases', ...[...new Set(records.full.response.rows.filter(r => r.expense_basis?.trim()).map(r => r.expense_basis))].sort(), 'Not recorded']);
        await basis.focus(); await basis.press('ArrowDown'); await basis.press('Enter');
        assert.equal(await basis.evaluate(node => node === document.activeElement), true);
        const coverage = await page.locator('details').textContent();
        for (const term of ['', 'rent', 'TI']) for (const stage of ['', 'counter', 'executed']) for (const value of ['', ...new Set(records.full.response.rows.map(r => key(r.expense_basis)))]) {
          await page.getByLabel('Term', { exact: true }).selectOption(term);
          await page.getByLabel('Recorded stage', { exact: true }).selectOption(stage);
          await basis.selectOption(value);
          const expected = records.full.response.rows.filter(r => (!term || r.fact_key === term) && (!stage || r.term_kind === stage) && (!value || key(r.expense_basis) === value));
          assert.equal(await page.locator('tbody tr').count(), expected.length);
          assert.match(await page.locator('[data-market-results]').textContent(), new RegExp(`${expected.length} matching loaded terms? across ${new Set(expected.map(r => r.entity_ref)).size} deals?`));
          if (!expected.length) assert.match(await page.locator('main').textContent(), /No comparable terms/);
          assert.equal(await page.locator('details').textContent(), coverage);
          const superseded = expected.filter(row => row.effective_to && records.full.response.rows.some(next => next.entity_ref === row.entity_ref && next.fact_key === row.fact_key && next.term_kind === row.term_kind && next.effective_from === row.effective_to));
          assert.equal(await page.locator('.superseded').count(), superseded.length);
          assert.deepEqual(await page.locator('td[data-label="Expense basis"]').allTextContents(), expected.map(r => r.expense_basis?.trim() ? r.expense_basis : 'Not recorded'));
          const quarantined = expected.filter(r => r.sources.some(s => s.quarantined)).length;
          assert.equal(await page.locator('tbody tr').filter({ hasText: 'Quarantined: not supporting evidence' }).count(), quarantined);
        }
        assert.equal(await page.evaluate(() => window.reads), 1);
        await page.evaluate(() => window.panel.dispose());
        assert.equal(await page.locator('main').textContent(), '');
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.close(); }
});

test('refresh retains or resets basis, refuses malformed and failed reads, ignores stale completion and disposes', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(server.origin);
      await page.evaluate(async records => {
        document.body.innerHTML = '<main id="comparison"></main>';
        const { mountMarketTerms } = await import('/js/ui-market.generated.js');
        window.records = records; window.pending = [];
        window.panel = mountMarketTerms(document.querySelector('main'), { entityRef: 'synthetic-a', client: { readMarketTerms: args => new Promise((resolve, reject) => window.pending.push({ args, resolve, reject })) } });
        window.panel.refresh(); window.pending[0].resolve(records.empty.response);
      }, records);
      assert.match(await page.locator('main').textContent(), /Loading/);
      await page.evaluate(() => window.pending[1].resolve(window.records.full.response));
      const basis = page.getByLabel('Expense basis', { exact: true });
      await basis.waitFor({ timeout: 1500 });
      await basis.selectOption(key('NNN'));
      for (const [name, date] of [['before', '2025-12-31'], ['boundary', '2026-01-01'], ['full', '']]) {
        await page.locator('[name=as_of]').fill(date);
        await page.locator('[name=submarket]').fill('North');
        await page.locator('[name=use_type]').fill('Medical');
        await page.getByRole('button', { name: 'Compare', exact: true }).click();
        await page.evaluate(({ name, date }) => { const p = window.pending.at(-1); if ((p.args.as_of || '') !== date || p.args.submarket !== 'North' || p.args.use_type !== 'Medical') throw Error('query mismatch'); p.resolve(window.records[name].response); }, { name, date });
        await basis.waitFor();
        const exists = records[name].response.rows.some(r => r.expense_basis === 'NNN');
        assert.equal(await basis.inputValue(), exists ? key('NNN') : '');
        if (!exists) await basis.selectOption('');
      }
      await basis.selectOption(key('NNN'));
      for (const failure of ['transient', 'malformed', 'denied']) {
        await page.evaluate(failure => { window.panel.refresh(); const p = window.pending.at(-1); if (failure === 'malformed') p.resolve({ ...window.records.full.response, rows: [null] }); else p.reject(Object.assign(Error(failure), { status: failure === 'denied' ? 403 : 503 })); }, failure);
        await page.getByText('Could not load comparable terms. Try again.', { exact: true }).waitFor();
        assert.equal(await basis.count(), 0);
        await page.evaluate(() => { window.panel.refresh(); window.pending.at(-1).resolve(window.records.full.response); });
        await basis.waitFor(); assert.equal(await basis.inputValue(), key('NNN'));
      }
      await page.evaluate(() => { window.panel.refresh(); window.panel.refresh(); window.pending.at(-1).resolve(window.records.full.response); });
      await basis.waitFor();
      await page.evaluate(() => window.pending.at(-2).resolve(window.records.empty.response));
      assert.equal(await basis.inputValue(), key('NNN'));
      await page.evaluate(() => { window.panel.refresh(); window.panel.refresh(); window.pending.at(-1).resolve(null); });
      await page.getByText('Could not load comparable terms. Try again.', { exact: true }).waitFor();
      await page.evaluate(() => window.pending.at(-2).resolve(window.records.full.response));
      assert.equal(await basis.count(), 0);
      await page.evaluate(() => { window.panel.refresh(); window.pending.at(-1).resolve(window.records.full.response); });
      await basis.waitFor();
      await page.evaluate(() => { window.panel.refresh(); window.pending.at(-1).resolve(window.records.vanished.response); });
      await page.getByText('The previously selected expense basis is no longer in the loaded results. Showing all expense bases.', { exact: true }).waitFor();
      assert.equal(await basis.inputValue(), '');
      await page.evaluate(() => { window.panel.refresh(); window.pending.at(-1).resolve(window.records.empty.response); });
      await basis.waitFor();
      assert.deepEqual(await basis.locator('option').allTextContents(), ['All expense bases']);
      await page.evaluate(() => { window.panel.refresh(); window.panel.dispose(); window.pending.at(-1).resolve(window.records.full.response); });
      assert.equal(await page.locator('main').textContent(), '');
    } finally { await page.close(); }
  } finally { await browser.close(); await server.close(); }
});

test('auth retirement clears loading and selected basis and ignores late completion', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(server.origin);
      for (const phase of ['loading', 'ready', 'failed']) {
        await page.evaluate(async ({ phase, records }) => {
          document.body.innerHTML = '<main></main>';
          const { mountMarketTerms } = await import('/js/ui-market.generated.js');
          const { createSessionBoundary } = await import('/js/private-session.js');
          window.panel = mountMarketTerms(document.querySelector('main'), { entityRef: 'synthetic-a', client: { readMarketTerms: () => new Promise(resolve => { window.finish = resolve; }) } });
          window.boundary = createSessionBoundary({ fetchImpl: async () => new Response('', { status: 401 }), invalidate: () => window.panel.dispose() });
          if (phase !== 'loading') window.finish(phase === 'failed' ? null : records.full.response);
        }, { phase, records });
        if (phase === 'ready') await page.getByLabel('Expense basis', { exact: true }).selectOption(key('NNN'));
        if (phase === 'failed') await page.getByText('Could not load comparable terms. Try again.', { exact: true }).waitFor();
        await page.evaluate(async records => { await window.boundary.verify().catch(() => {}); window.finish(records.full.response); }, records);
        assert.equal(await page.locator('main').textContent(), '');
      }
    } finally { await page.close(); }
  } finally { await browser.close(); await server.close(); }
});
