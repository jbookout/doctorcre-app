import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { chromium, fixtureServer } from './browser-harness.mjs';

const base = JSON.parse(readFileSync(new URL('./fixtures/market-terms/recordings.json', import.meta.url)));
const source = readFileSync(new URL('./fixtures/market-terms/producer.ts.txt', import.meta.url), 'utf8');
const producer = { exports: {} };
new Function('module', transformSync(source.slice(source.indexOf('export function rebuildMarketTerms('), source.indexOf('\nexport function marketTermsTools(')), { loader: 'ts', format: 'cjs' }).code)(producer);
const snapshot = structuredClone(base.records.full.snapshot);
const receipt = snapshot.receipts[0];
snapshot.receipts.push({ ...receipt, canonical_fact_id: 'successor', effective_from: '2026-01-01', expense_basis: 'Gross', value: '40' });
for (const [entity_ref, fact_key, term_kind] of [['other', 'rent', 'executed'], ['synthetic-a', 'other', 'executed'], ['synthetic-a', 'rent', 'counter']]) snapshot.receipts.push({ ...receipt, canonical_fact_id: JSON.stringify([entity_ref, fact_key, term_kind]), entity_ref, fact_key, term_kind, sources: receipt.sources.map(source => ({ ...source, quarantined: term_kind === 'counter' })), effective_to: '2026-01-01' });
const data = producer.exports.rebuildMarketTerms(snapshot, {});
const superseded = (r, date) => Boolean(r.effective_to && (!date || r.effective_to <= date) && data.rows.some(n => n.entity_ref === r.entity_ref && n.fact_key === r.fact_key && n.term_kind === r.term_kind && n.effective_from === r.effective_to));
const basisKey = v => v?.trim() ? JSON.stringify(v) : 'missing';

test('focus intersects every local filter, preserves exact evidence, counts and coverage without reads', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(server.origin);
        await page.evaluate(async data => {
          document.body.innerHTML = '<main></main>';
          const { mountMarketTerms } = await import('/js/ui-market.js');
          window.reads = 0;
          window.panel = mountMarketTerms(document.querySelector('main'), { entityRef: 'synthetic-a', client: { readMarketTerms: async () => { window.reads++; return data; } } });
        }, data);
        const toggle = page.getByRole('checkbox', { name: 'Hide superseded terms', exact: true });
        await toggle.waitFor({ timeout: 1000 });
        assert.equal(await toggle.isChecked(), false);
        const coverage = await page.locator('details').textContent();
        const identities = () => page.locator('tbody tr').evaluateAll(rows => rows.map(row => ({ cells: [...row.cells].map(c => c.textContent), href: row.querySelector('a').getAttribute('href') })));
        const all = await identities();
        assert.equal(all.length, data.rows.length);
        await toggle.focus(); await toggle.press('Space');
        assert.equal(await toggle.isChecked(), true);
        assert.equal(await toggle.evaluate(e => e === document.activeElement), true);
        for (const date of ['', '2025-12-31', '2026-01-01']) {
          await page.locator('[name=as_of]').fill(date);
          await page.getByRole('button', { name: 'Compare', exact: true }).click();
          await toggle.waitFor(); assert.equal(await toggle.isChecked(), true);
          for (const term of ['', 'rent']) for (const stage of ['', 'executed', 'counter']) for (const basis of ['', JSON.stringify('NNN'), JSON.stringify('Gross')]) {
            await page.getByLabel('Term', { exact: true }).selectOption(term);
            await page.getByLabel('Recorded stage', { exact: true }).selectOption(stage);
            await page.getByLabel('Expense basis', { exact: true }).selectOption(basis);
            const indices = data.rows.flatMap((r, i) => (!superseded(r, date) && (!term || r.fact_key === term) && (!stage || r.term_kind === stage) && (!basis || basisKey(r.expense_basis) === basis)) ? [i] : []);
            const expected = indices.map(i => ({ ...all[i], cells: [...all[i].cells] }));
            if (date && date < '2026-01-01') for (const row of expected) row.cells[6] = row.cells[6].replace(' · superseded', '');
            assert.deepEqual(await identities(), expected);
            const deals = new Set(indices.map(i => data.rows[i].entity_ref)).size;
            await page.getByText(`${indices.length} matching loaded ${indices.length === 1 ? 'term' : 'terms'} across ${deals} ${deals === 1 ? 'deal' : 'deals'}.`, { exact: true }).waitFor();
            assert.equal(await page.locator('details').textContent(), coverage);
          }
          for (const name of ['Term', 'Recorded stage', 'Expense basis']) await page.getByLabel(name, { exact: true }).selectOption('');
          await toggle.uncheck();
          const restored = all.map(row => ({ ...row, cells: [...row.cells] }));
          if (date && date < '2026-01-01') for (const row of restored) row.cells[6] = row.cells[6].replace(' · superseded', '');
          assert.deepEqual(await identities(), restored, 'clearing focus restores exact full history');
          await toggle.check();
        }
        assert.equal(await page.evaluate(() => window.reads), 4);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.close(); }
});

test('Compare retains focus through empty and malformed recovery; dispose and remount reset it', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(server.origin);
      await page.evaluate(async data => {
        document.body.innerHTML = '<main></main>';
        const { mountMarketTerms } = await import('/js/ui-market.js');
        window.response = data; window.data = data;
        window.mount = () => window.panel = mountMarketTerms(document.querySelector('main'), { entityRef: 'synthetic-a', client: { readMarketTerms: async () => window.response } });
        window.mount();
      }, data);
      const toggle = page.getByRole('checkbox', { name: 'Hide superseded terms' });
      await toggle.check();
      for (const state of ['empty', 'malformed', 'full']) {
        await page.evaluate(state => { window.response = state === 'empty' ? { ...window.data, rows: [] } : state === 'malformed' ? null : window.data; window.panel.refresh(); }, state);
        if (state === 'malformed') await page.getByText('Could not load comparable terms. Try again.', { exact: true }).waitFor();
        else { await toggle.waitFor(); assert.equal(await toggle.isChecked(), true); }
      }
      await page.evaluate(() => { window.panel.dispose(); window.mount(); });
      await toggle.waitFor(); assert.equal(await toggle.isChecked(), false);
    } finally { await page.close(); }
  } finally { await browser.close(); await server.close(); }
});
