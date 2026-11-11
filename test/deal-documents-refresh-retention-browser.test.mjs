import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { componentDocument, chromium } from './browser-harness.mjs';
import { readFile } from 'node:fs/promises';
import { observeRefreshRetention } from './deal-documents-refresh-observer.mjs';

const refreshRecordings = JSON.parse(await readFile(new URL('./fixtures/deal-documents-refresh-retention/recordings.json', import.meta.url), 'utf8'));

test('refresh retains last successful metadata and replaces scans', async t => {
  const artifact = await temporaryDirectory('documents-retention-', t);
  await buildArtifact({ root: process.cwd(), outDir: artifact, commit: '1'.repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } }); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    for (const recording of ['initial', 'replacement']) {
      await t.test(`observer rejects an altered ${recording} request ${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
        try {
          await componentDocument(page, server.url, {owner:'documents refresh', html: '<!doctype html><body></body>'});
          const recordings = structuredClone(refreshRecordings);
          recordings[recording].request.limit = 49;
          await assert.rejects(
            page.evaluate(observeRefreshRetention, { assetUrl: '/js/ui-deal-documents.generated.js', recordings }),
            new RegExp(`recorded ${recording} request matches production call`),
          );
        } finally { await page.close(); }
      });
    }
    for (const transition of ['Loading -> Disposed', 'Stale -> Expired', 'Stale -> Disposed']) {
      await t.test(`${transition} ${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
        try {
          await componentDocument(page, server.url, {owner:'documents refresh', html: '<!doctype html><body><main></main></body>'});
          await page.evaluate(async ({ transition, response }) => {
            const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
            const target = document.querySelector('main'), pending = [], requests = [];
            const panel = mountDealDocuments(target, { dealId: '11111111-1111-4111-8111-111111111111', client: {
              listDealDocuments(args, { signal }) {
                requests.push(args);
                return new Promise((resolve, reject) => pending.push({ resolve, reject, signal }));
              },
            } });
            const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const check = (condition, message) => { if (!condition) throw Error(message); };
            const rows = () => target.querySelectorAll('[data-document-id]').length;
            try {
              const initial = pending.shift();
              check(requests.length === 1 && target.textContent.includes('Loading documents'), 'initial read is pending');
              if (transition === 'Loading -> Disposed') {
                panel.dispose();
                check(initial.signal.aborted, 'initial loading disposal aborts the request');
                check(target.innerHTML === '', 'initial loading disposal empties the mount');
                initial.resolve(response);
              } else {
                initial.resolve(response); await settle();
                check(rows() === 1 && target.querySelector('[data-content-hash]').dataset.contentHash === 'a'.repeat(64), 'production parser renders validated metadata');
                const refreshing = panel.refresh();
                pending.shift().reject(Error('Synthetic refresh outage'));
                await refreshing; await settle();
                check(rows() === 1 && target.textContent.includes('Last successful read') && target.textContent.includes('Retry documents'), 'failed refresh is stale before any retry');
                check(requests.length === 2, 'no retry starts before terminal transition');
                if (transition === 'Stale -> Expired') {
                  window.dispatchEvent(new Event('doctorcre-session-invalidated'));
                  check(rows() === 0 && target.textContent.includes('Session expired'), 'stale invalidation clears metadata and shows expiry');
                  check(target.querySelectorAll('button').length === 0, 'expired mount has no retry or refresh controls');
                } else {
                  panel.dispose();
                  check(target.innerHTML === '', 'stale disposal empties the mount');
                }
              }
              const count = requests.length;
              await panel.refresh();
              window.dispatchEvent(new Event('doctorcre-session-invalidated'));
              await settle();
              check(requests.length === count && rows() === 0, 'terminal mount cannot request or restore metadata');
              if (transition !== 'Stale -> Expired') check(target.innerHTML === '', 'disposed mount stays empty after late completion and invalidation');
              else check(target.textContent.includes('Session expired'), 'expired mount stays expired');
            } finally { panel.dispose(); }
          }, { transition, response: refreshRecordings.single.response });
        } finally { await page.close(); }
      });
    }
    for (const failure of ['network', '503', 'malformed', '401', '403']) {
      for (const replacement of (['401', '403'].includes(failure) ? ['nonempty'] : ['nonempty', 'empty', 'dispose', 'invalidate'])) {
        await t.test(`${failure} ${replacement} ${width} ${theme}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
          try {
            await componentDocument(page, server.url, {owner:'documents refresh', html: '<!doctype html><body></body>'});
            const result = await page.evaluate(observeRefreshRetention, { assetUrl: '/js/ui-deal-documents.generated.js', recordings: refreshRecordings, failure, replacement });
            assert.ok(result.retained || result.authorizationCleared);
          } finally { await page.close(); }
        });
      }
    }
  }
});
