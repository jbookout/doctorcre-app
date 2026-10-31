import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

const plan = JSON.parse(await readFile(new URL('./fixtures/terms-comparison/prepare.json', import.meta.url)));
const evidence = new URL('../.github/pr-evidence/WR39.S4.J6/', import.meta.url);

test('deal Terms prepares the HTTP fill plan across phone, desktop and both themes', async t => {
  const server = await startFixtureServer(); t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] }); t.after(() => browser.close());
  await mkdir(evidence, { recursive: true });
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 1200 : 1000 } });
    try {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
      let response = { status: 200, body: plan };
      const requests = [];
      await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-session' } }));
      await page.route('**/api/v1/fact-review/comparison', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ status: response.status, json: response.body });
      });
      await page.goto(`${server.url}/deals?deal=d14`);
      await page.getByRole('region', { name: 'Terms', exact: true }).scrollIntoViewIfNeeded();
      await page.locator('[data-prepare-comparison]').waitFor();
      await page.evaluate(async () => {
        const { state } = await import('/js/pipeline.js');
        const { createLiveClient } = await import('/js/live-client.js');
        const client = state.client;
        const initial = (await client.listFactReview({ entity_ref: 'd14' })).items[0];
        await client.resolveFactReview({ entity_ref: 'd14', fact_key: initial.fact_key, base_version: initial.canonical_version, review_version: initial.review_version,
          decision: 'approve', observation_id: initial.observations[0].id, reason: 'Demo confirmed prior version.', idempotency_key: crypto.randomUUID() });
        const current = (await client.listFactReview({ entity_ref: 'd14', include_resolved: true })).items[0];
        await client.resolveFactReview({ entity_ref: 'd14', fact_key: current.fact_key, base_version: current.canonical_version, review_version: current.review_version,
          decision: 'correct', correction: { fact_key: current.fact_key, value: '27.5', unit: 'USD/SF/year', expense_basis: 'nnn',
            source: { document_ref: initial.observations[0].source.document_ref, page_start: 1, page_end: 1, cited_text: 'Demo confirmed rent is $27.50 per square foot.' } },
          reason: 'Demo confirmed current version.', idempotency_key: crypto.randomUUID() });
        const live = createLiveClient({ selfActor: 'joe', docContext: false, fetchImpl: (path, init) => fetch(path, init) });
        client.prepareTermsComparison = live.prepareTermsComparison;
      });
      await page.getByRole('button', { name: 'Refresh terms', exact: true }).click();
      await page.getByRole('button', { name: 'Prepare terms comparison', exact: true }).click();
      const draft = page.locator('[data-comparison-draft]');
      await draft.waitFor();
      assert.match(await draft.innerText(), /Confirmed deal fact/);
      assert.match(await draft.innerText(), /Prior: v1.*Current: v2/);
      assert.match(await draft.innerText(), /Rent schedule/);
      assert.deepEqual(requests[0].fields, [{ fact_key: 'base_rent_per_sf', prior_version: 1, current_version: 2 }]);
      assert.doesNotMatch(await draft.innerText(), /00000000|Templates\//);
      await page.evaluate(() => {
        const terms = document.querySelector('[data-terms-comparison]');
        const header = document.querySelector('.workspace-header');
        const offset = getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().height : 0;
        const topbar = document.querySelector('.app-layout-tabbar').getBoundingClientRect().height;
        scrollTo({ top: scrollY + terms.getBoundingClientRect().top - offset - topbar - 16, behavior: 'instant' });
      });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: new URL(`draft-${width}-${theme}.png`, evidence).pathname, animations: 'disabled' });
      if (width === 390 && theme === 'light') {
        for (const reason of ['missing', 'unresolved', 'stale_snapshot']) {
          response = { status: 400, body: { error: 'comparison_fact_blocked', field: 'base_rent_per_sf', reason } };
          await page.getByRole('button', { name: 'Prepare again', exact: true }).click();
          const result = page.locator('[data-comparison-result]');
          if (reason === 'stale_snapshot') await page.getByText('A fact changed since', { exact: false }).waitFor();
          else {
            await result.getByText(reason === 'missing' ? 'Missing confirmed fact.' : 'Unresolved fact.', { exact: false }).waitFor();
            const link = result.getByRole('link', { name: 'Base rent', exact: true });
            await link.click();
            assert.equal(await page.locator('#term-base_rent_per_sf').evaluate(node => node === document.activeElement), true);
          }
          assert.equal(await draft.count(), 0);
        }
        response = { status: 404, body: { error: 'not_found' } };
        await page.getByRole('button', { name: 'Prepare again', exact: true }).click();
        await page.getByText('Terms comparison unavailable.', { exact: false }).waitFor();
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
