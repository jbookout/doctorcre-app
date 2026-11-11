import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Documents cap preserves validation, final pages and refresh', async t => {
  const artifact = await temporaryDirectory('documents-hard-cap-', t);
  await buildArtifact({ root, outDir: artifact, commit: '1'.repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const scenario of ['exactly 500', 'short final', 'cross final', 'duplicate discarded row', 'cursor cycle', 'expire at cap', 'dispose at cap', 'dispose unavailable']) {
    await t.test(scenario, async () => {
      const page = await browser.newPage(); t.after(() => page.close());
      await page.route('**/documents-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main></main></body></html>' }));
      await page.goto(`${server.url}/documents-harness`);
      await page.evaluate(async scenario => {
        const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
        let offset = 0, calls = 0;
        window.requests = [];
        window.panel = mountDealDocuments(document.querySelector('main'), {
          dealId: '11111111-1111-4111-8111-111111111111',
          client: { async listDealDocuments(args) {
            window.requests.push(args); calls++;
            if (scenario === 'dispose unavailable') throw Error('Synthetic unavailable documents');
            const count = scenario === 'exactly 500' ? 50 : scenario === 'short final' ? (calls === 1 ? 49 : 3) : 49;
            const documents = Array.from({ length: count }, () => ({
              id: `00000000-0000-4000-8000-${String(++offset).padStart(12, '0')}`, display_name: `Synthetic ${offset}`,
              document_type: null, page_count: null, content_hash: 'a'.repeat(64), stored_at: '2026-01-01T00:00:00Z',
            }));
            if (scenario === 'duplicate discarded row' && calls === 11) documents[48].id = '00000000-0000-4000-8000-000000000001';
            const final = scenario === 'short final' && calls === 2 || scenario === 'cross final' && calls === 11;
            return { ok: true, schema_version: 'deal-documents.v1', documents, has_more: !final,
              next_cursor: final ? null : scenario === 'cursor cycle' && calls === 11 ? '49' : String(offset) };
          } },
        });
      }, scenario);
      const panel = page.getByRole('region', { name: 'Deal documents', exact: true });
      if (scenario === 'dispose unavailable') {
        await panel.getByRole('button', { name: 'Retry documents' }).waitFor();
        await page.evaluate(() => window.panel.dispose());
        assert.equal(await page.locator('main').textContent(), '');
        assert.equal(await panel.count(), 0);
        assert.equal((await page.evaluate(() => window.requests)).length, 1);
        return;
      }
      const pages = scenario === 'short final' ? 2 : scenario === 'exactly 500' ? 10 : 11;
      for (let index = 1; index < pages; index++) {
        await page.waitForFunction(count => window.requests.length === count && !document.body.textContent.includes('Loading documents'), index);
        await panel.getByRole('button', { name: 'Load more documents', exact: true }).click();
      }
      await page.waitForFunction(count => window.requests.length === count && !document.body.textContent.includes('Loading documents'), pages);
      const rejected = ['duplicate discarded row', 'cursor cycle'].includes(scenario);
      assert.equal(await panel.locator('[data-document-id]').count(), rejected ? 490 : scenario === 'short final' ? 52 : 500);
      assert.equal(await panel.getByRole('button', { name: 'Load more documents', exact: true }).count(), 0);
      if (scenario === 'expire at cap' || scenario === 'dispose at cap') {
        await page.evaluate(scenario => {
          if (scenario === 'expire at cap') window.dispatchEvent(new Event('doctorcre-session-invalidated'));
          else window.panel.dispose();
        }, scenario);
        assert.equal(await page.locator('[data-document-id]').count(), 0);
        if (scenario === 'expire at cap') {
          await panel.getByText('Session expired. Sign in again to view documents.', { exact: true }).waitFor();
          await page.evaluate(() => window.panel.dispose());
        }
        return;
      }
      if (rejected) {
        await panel.getByRole('button', { name: 'Retry documents' }).click();
        await page.waitForFunction(() => window.requests.length === 12);
        const requests = await page.evaluate(() => window.requests);
        assert.equal(requests.at(-1).cursor, requests.at(-2).cursor);
      } else if (scenario !== 'short final') {
        await panel.getByText('Showing the first 500 documents. Refresh to start again.', { exact: true }).waitFor();
        await panel.getByRole('button', { name: 'Refresh documents' }).focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(count => window.requests.length === count && !document.body.textContent.includes('Loading documents'), pages + 1);
        assert.equal(await panel.locator('[data-document-id]').count(), scenario === 'exactly 500' ? 50 : 49);
        assert.equal((await page.evaluate(() => window.requests)).at(-1).cursor, undefined);
      }
      await page.evaluate(() => window.panel.dispose());
      assert.equal(await panel.count(), 0);
    });
  }
});
