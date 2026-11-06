import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from 'playwright';
import { prove } from '../scripts/prove-deal-documents-refresh-retention.mjs';

const exec = promisify(execFile);
test('refresh proof CLI passes current-tree assets and rejects broken fixtures', async t => {
  const artifact = await temporaryDirectory('refresh-proof-', t);
  await buildArtifact({ root: process.cwd(), outDir: artifact, commit: '1'.repeat(40) });
  const root = resolve(artifact, 'site');
  let mode = 'success';
  const server = createServer(async (req, res) => {
    if (req.url === '/app-release') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
    }
    try {
      if (!/^\/js\/[\w.-]+\.js$/.test(req.url)) throw Error('Invalid path');
      const file = resolve(root, `.${req.url}`);
      if (!file.startsWith(root + sep)) throw Error('Outside fixture');
      let body = await readFile(file);
      if (mode === 'broken' && req.url === '/js/ui-deal-documents.js') body = 'export function mountDealDocuments(){throw Error("Broken fixture")}';
      res.setHeader('content-type', 'text/javascript'); res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const scenario of ['success', 'broken']) await t.test(scenario, async () => {
    mode = scenario;
    let result;
    try { result = { ...await exec(process.execPath, ['scripts/prove-deal-documents-refresh-retention.mjs', '--origin', origin, '--timeout-ms', '30000'], { timeout: 40000 }), code: 0 }; }
    catch (error) { result = error; }
    assert.equal(result.code, scenario === 'success' ? 0 : 1, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.production_acceptance, false);
    if (scenario === 'success') {
      assert.equal(receipt.deployed_asset_fixture.retained, true);
      assert.equal(receipt.natural_authenticated_observation, 'insufficient_evidence');
      assert.deepEqual(receipt.release, receipt.after);
      assert.ok(receipt.assets.length > 1);
    }
  });
  for (const scenario of ['real late launch', 'real stalled evaluation']) await t.test(scenario, async () => {
    let acquired;
    let launchSettled;
    const settled = new Promise(resolve => { launchSettled = resolve; });
    const engine = { async launch(options) {
      acquired = await chromium.launch(options);
      launchSettled();
      if (scenario === 'real late launch') await new Promise(resolve => setTimeout(resolve, 3000));
      else {
        const newContext = acquired.newContext.bind(acquired);
        acquired.newContext = async (...args) => {
          const context = await newContext(...args);
          const newPage = context.newPage.bind(context);
          context.newPage = async (...args) => {
            const page = await newPage(...args);
            page.evaluate = () => new Promise(() => {});
            return page;
          };
          return context;
        };
      }
      return acquired;
    } };
    await assert.rejects(prove({ origin, timeoutMs: 2000, engine }), error => error.exitCode === 78);
    await settled;
    if (acquired.isConnected()) await new Promise(resolve => acquired.once('disconnected', resolve));
    assert.equal(acquired.isConnected(), false, 'owned Chromium closed after deadline, including late acquisition');
  });
  for (const scenario of ['late launch', 'stalled evaluation']) await t.test(scenario, async () => {
    let owned = 0, closed = 0;
    const acquired = {
      async close() { if (owned) { owned--; closed++; } },
      async newContext() { return { async route() {}, async newPage() { return {
        async goto() {}, evaluate() { return new Promise(() => {}); },
      }; } }; },
    };
    const engine = { async launch() {
      if (scenario === 'late launch') await new Promise(resolve => setTimeout(resolve, 180));
      owned++; return acquired;
    } };
    await assert.rejects(prove({ origin, timeoutMs: 100, engine }), error => error.exitCode === 78);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(owned, 0, 'zero acquired browser handles survive');
    assert.equal(closed, 1);
  });
});

const fixtureRoot = new URL('./fixtures/deal-documents-refresh-retention/', import.meta.url);
async function producerReplay() {
  const source = await readFile(new URL('registered-read.txt', fixtureRoot), 'utf8');
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureRoot), 'utf8'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(source), provenance.registered_read_sha256);
  const view = await readFile(new URL('view.sql', fixtureRoot), 'utf8');
  assert.equal(hash(view), provenance.view_sha256);
  assert.match(view, /null::integer as page_count/);
  const tools = vm.runInNewContext(`({${source}})`, {
    organizationTenantForActor: () => 'carr-internal',
    ToolError: class extends Error { constructor(payload) { super(payload.error); } },
  });
  return async ({ request, rows, response }) => {
    for (const row of rows) assert.equal(row.page_count, null, 'view emits null page_count');
    const actual = await tools['list-deal-documents'].handler({ async query(sql, [tenant, deal, after, limit]) {
      assert.equal(tenant, 'carr-internal'); assert.equal(deal, request.deal_id);
      assert.match(sql, /public.v_deal_documents/);
      return { rows: rows.filter(row => after === null || row.id > after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit) };
    } }, {}, request);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), response);
  };
}

test('every successful refresh fixture equals the pinned registered producer response', async () => {
  const replay = await producerReplay();
  const recordings = JSON.parse(await readFile(new URL('recordings.json', fixtureRoot), 'utf8'));
  for (const recording of Object.values(recordings)) await replay(recording);
  assert.equal(recordings.second.request.cursor, recordings.initial.response.next_cursor);
  assert.equal(recordings.next.request.cursor, recordings.replacement.response.next_cursor);
});

test('producer replay rejects invented successful cursors, short more-pages and page counts', async () => {
  const replay = await producerReplay();
  const recordings = JSON.parse(await readFile(new URL('recordings.json', fixtureRoot), 'utf8'));
  for (const cursor of ['old-next', 'old-third',
    JSON.stringify({ version: 1, tenant: 'other', deal: recordings.second.request.deal_id, after: recordings.initial.response.documents.at(-1).id }),
    JSON.stringify({ version: 1, tenant: 'carr-internal', deal: '22222222-2222-4222-8222-222222222222', after: recordings.initial.response.documents.at(-1).id }),
  ]) {
    const invalid = structuredClone(recordings.second); invalid.request.cursor = cursor;
    await assert.rejects(replay(invalid), /invalid_cursor/);
  }
  const wrongCursor = structuredClone(recordings.initial); wrongCursor.response.next_cursor = 'old-next';
  await assert.rejects(replay(wrongCursor), /Expected values/);
  const shortPage = structuredClone(recordings.initial); shortPage.response.documents.splice(1);
  await assert.rejects(replay(shortPage), /Expected values/);
  const wrongCount = structuredClone(recordings.single); wrongCount.rows[0].page_count = 2;
  wrongCount.response.documents[0].page_count = 2;
  await assert.rejects(replay(wrongCount), /view emits null page_count/);
});
