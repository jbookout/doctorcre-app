import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const fixture = new URL('./fixtures/deal-documents-loaded-search/', import.meta.url);
const recordings = JSON.parse(await readFile(new URL('recordings.json', fixture)));

test('loaded search recordings replay the registered producer', async () => {
  const source = await readFile(new URL('producer.txt', fixture), 'utf8');
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture)));
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.producer_sha256);
  const producer = vm.runInNewContext(`({${source}})`, { organizationTenantForActor: () => 'carr-internal', ToolError: Error })['list-deal-documents'];
  for (const { rows, request, response } of Object.values(recordings)) {
    assert.ok(rows.every(row => row.page_count === null));
    const actual = await producer.handler({ async query(sql, [tenant, deal, after, limit]) {
      assert.equal(tenant, 'carr-internal'); assert.equal(deal, request.deal_id);
      assert.match(sql, /public.v_deal_documents/);
      return { rows: rows.filter(row => after === null || row.id > after).slice(0, limit) };
    } }, {}, request);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), response);
  }
});

test('loaded search behavior and retirement', async t => {
  const artifact = temporaryDirectory('loaded-search-browser-', t);
  await buildArtifact({ root: process.cwd(), outDir: artifact, commit: '1'.repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await t.test(`local predicates, pagination, refresh and clear ${width} ${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      try {
        await page.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"></head><body><main></main></body></html>` }));
        await page.goto(`${server.url}/harness`);
        await page.evaluate(async recordings => {
          const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
          window.requests = []; window.pending = [];
          window.panel = mountDealDocuments(document.querySelector('main'), { dealId: recordings.initial.request.deal_id, client: {
            listDealDocuments(args, { signal }) { window.requests.push(args); return new Promise((resolve, reject) => window.pending.push({ resolve, reject, signal })); },
          } });
          window.pending.shift().resolve(recordings.initial.response);
        }, recordings);
        const search = page.getByRole('searchbox', { name: 'Search loaded documents', exact: true });
        const type = page.getByRole('combobox', { name: 'Document type', exact: true });
        const rows = page.locator('[data-document-id]');
        const ids = () => rows.evaluateAll(rows => rows.map(row => row.dataset.documentId));
        const expected = (name, mime = undefined, docs = recordings.initial.response.documents) => docs.filter(doc => doc.display_name.toLowerCase().includes(name.trim().toLowerCase()) && (mime === undefined || doc.document_type === mime)).map(doc => doc.id);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        await search.fill('lEaSe'); assert.deepEqual(await ids(), expected('lease'));
        await search.fill('   '); assert.equal(await rows.count(), 50);
        for (const mime of ['application/pdf', 'text/plain', null, 'Unrecorded']) {
          const option = await type.locator('option').evaluateAll((options, mime) => options.find(option => option.textContent === (mime === null ? 'Unrecorded (unrecorded)' : mime))?.value, mime);
          assert.notEqual(option, undefined); await type.selectOption(option);
          assert.deepEqual(await ids(), expected('', mime));
        }
        await page.getByRole('button', { name: 'Clear', exact: true }).click();
        assert.equal(await search.evaluate(el => el === document.activeElement), true);
        assert.deepEqual(await ids(), expected(''));
        await page.getByText('50 matching of 50 loaded documents.', { exact: true }).waitFor();
        assert.equal(await rows.first().locator('time').getAttribute('datetime'), recordings.initial.response.documents[0].stored_at);
        await rows.first().locator('summary').click();
        assert.ok((await rows.first().textContent()).includes(recordings.initial.response.documents[0].content_hash));
        await type.selectOption({ label: 'text/plain' });
        await search.fill('later'); assert.equal(await rows.count(), 0);
        await page.getByText(/No matching loaded documents/).waitFor();
        await page.getByRole('button', { name: 'Load more documents', exact: true }).focus();
        assert.equal(await page.evaluate(() => window.requests.length), 1);
        await page.keyboard.press('Enter');
        await page.evaluate(response => window.pending.shift().resolve(response), recordings.second.response);
        assert.deepEqual(await ids(), expected('later', 'text/plain', recordings.second.response.documents));
        assert.equal(await type.inputValue(), 'type:text/plain');
        await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
        await page.evaluate(response => window.pending.shift().resolve(response), recordings.initial.response);
        assert.equal(await type.inputValue(), 'type:text/plain');
        await search.fill('');
        assert.deepEqual(await ids(), expected('', 'text/plain'));
        await page.getByRole('button', { name: 'Load more documents', exact: true }).click();
        await page.evaluate(response => window.pending.shift().resolve(response), recordings.second.response);
        await page.getByRole('button', { name: 'Clear', exact: true }).click();
        await type.selectOption({ label: 'application/pdf' });
        await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
        await page.evaluate(() => window.pending.shift().reject(Error('Synthetic refusal')));
        await page.getByText(/Last successful read/).waitFor();
        assert.deepEqual(await ids(), expected('', 'application/pdf', [...recordings.initial.response.documents, ...recordings.second.response.documents]));
        assert.equal(await type.inputValue(), 'type:application/pdf');
        await search.fill('no match'); assert.equal(await rows.count(), 0);
        await page.getByRole('button', { name: 'Retry documents', exact: true }).click();
        await page.evaluate(response => window.pending.shift().resolve(response), recordings.replacement.response);
        assert.equal(await type.inputValue(), 'all');
        await page.getByRole('button', { name: 'Clear', exact: true }).click();
        assert.deepEqual(await ids(), expected('', undefined, recordings.replacement.response.documents));
        await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
        await page.evaluate(response => window.pending.shift().resolve(response), recordings.empty.response);
        await page.getByText('No documents filed for this deal.', { exact: true }).waitFor();
        assert.equal(await rows.count(), 0);
        assert.ok((await page.evaluate(() => window.requests)).every(args => args.limit === 50));
        await page.evaluate(() => window.panel.dispose());
      } finally { await page.close(); }
    });
    await t.test(`initial empty response ${width} ${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      try {
        await page.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"></head><body><main></main></body></html>` }));
        await page.goto(`${server.url}/harness`);
        await page.evaluate(async recording => {
          const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
          window.panel = mountDealDocuments(document.querySelector('main'), { dealId: recording.request.deal_id, client: { async listDealDocuments() { return recording.response; } } });
        }, recordings.empty);
        await page.getByText('No documents filed for this deal.', { exact: true }).waitFor();
        await page.getByText('0 matching of 0 loaded documents.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Load more documents', exact: true }).count(), 0);
        await page.evaluate(() => window.panel.dispose());
      } finally { await page.close(); }
    });
    for (const retirement of ['invalidate', 'dispose']) {
      await t.test(`filtered ready ${retirement} retires directly ${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
        try {
          await page.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${theme}"><main></main></html>` }));
          await page.goto(`${server.url}/harness`);
          await page.evaluate(async recording => {
            const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
            window.requests = [];
            window.panel = mountDealDocuments(document.querySelector('main'), {
              dealId: recording.request.deal_id,
              client: { async listDealDocuments(args) { window.requests.push(args); return recording.response; } },
            });
          }, recordings.initial);
          const search = page.getByRole('searchbox', { name: 'Search loaded documents', exact: true });
          const type = page.getByRole('combobox', { name: 'Document type', exact: true });
          await type.selectOption('type:application/pdf');
          await search.fill('Document');
          const expected = recordings.initial.response.documents.filter(doc => doc.document_type === 'application/pdf' && /document/i.test(doc.display_name)).map(doc => doc.id);
          assert.ok(expected.length > 0 && expected.length < 50);
          assert.deepEqual(await page.locator('[data-document-id]').evaluateAll(rows => rows.map(row => row.dataset.documentId)), expected);
          assert.equal(await type.inputValue(), 'type:application/pdf');
          assert.equal(await page.getByRole('button', { name: 'Refresh documents', exact: true }).isEnabled(), true);
          await page.evaluate(retirement => {
            if (retirement === 'dispose') window.panel.dispose();
            else window.dispatchEvent(new Event('doctorcre-session-invalidated'));
          }, retirement);
          if (retirement === 'invalidate') assert.match(await page.locator('main').innerText(), /Session expired/);
          else assert.equal(await page.locator('main').innerHTML(), '');
          assert.equal(await page.locator('main input,main select,[data-document-id]').count(), 0);
          await page.evaluate(async () => { await window.panel.refresh(); });
          assert.equal(await page.evaluate(() => window.requests.length), 1, 'retired ready panel must not fetch again');
          assert.equal(await page.locator('main input,main select,[data-document-id]').count(), 0);
          await page.evaluate(() => window.panel.dispose());
        } finally { await page.close(); }
      });
    }
    for (const retirement of ['invalidate', '401', '403', 'dispose']) for (const phase of ['initial', 'filtered', 'refused']) {
      await t.test(`${phase} ${retirement} ignores late completion ${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
        try {
          await page.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"></head><body><main></main></body></html>` }));
          await page.goto(`${server.url}/harness`);
          await page.evaluate(async ({ recordings, phase, retirement }) => {
            const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
            const pending = [], requests = [], target = document.querySelector('main');
            const panel = mountDealDocuments(target, { dealId: recordings.initial.request.deal_id, client: { listDealDocuments(args, { signal }) { requests.push(args); return new Promise((resolve, reject) => pending.push({ resolve, reject, signal })); } } });
            const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (phase !== 'initial') {
              pending.shift().resolve(recordings.initial.response); await settle();
              target.querySelector('select').value = 'type:application/pdf'; target.querySelector('select').dispatchEvent(new Event('change', { bubbles: true }));
              panel.refresh();
              if (phase === 'refused') { pending.shift().reject(Error('refusal')); await settle(); panel.refresh(); }
            }
            const late = pending.shift();
            if (retirement === 'dispose') panel.dispose();
            else if (retirement === 'invalidate') window.dispatchEvent(new Event('doctorcre-session-invalidated'));
            else { late.reject({ status: Number(retirement) }); await settle(); }
            if (!late.signal.aborted) throw Error('retirement aborts pending read');
            late.resolve(recordings.initial.response); await settle();
            await panel.refresh();
            if (target.querySelector('input,select,[data-document-id]')) throw Error('private state survives retirement');
            if (retirement === 'dispose' && target.innerHTML) throw Error('disposed mount restored');
            if (retirement !== 'dispose' && !target.textContent.includes('Session expired')) throw Error('missing expired status');
            panel.dispose();
          }, { recordings, phase, retirement });
        } finally { await page.close(); }
      });
    }
  }
});


test('null type remains distinct through a chain of literal Unrecorded labels', async t => {
  const source = await readFile(new URL('producer.txt', fixture), 'utf8');
  const producer = vm.runInNewContext(`({${source}})`, { organizationTenantForActor: () => 'carr-internal', ToolError: Error })['list-deal-documents'];
  const types = [null, 'Unrecorded', 'Unrecorded (unrecorded)', 'Unrecorded (unrecorded) (unrecorded)'];
  const rows = recordings.initial.rows.slice(0, types.length).map((row, index) => ({ ...row, document_type: types[index] }));
  const response = JSON.parse(JSON.stringify(await producer.handler({ async query() { return { rows }; } }, {}, recordings.initial.request)));
  const artifact = temporaryDirectory('loaded-search-collision-', t);
  await buildArtifact({ root: process.cwd(), outDir: artifact, commit: '1'.repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); t.after(() => page.close());
  await page.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' }));
  await page.goto(`${server.url}/harness`);
  await page.evaluate(async ({ response, dealId }) => {
    const { mountDealDocuments } = await import('/js/ui-deal-documents.generated.js');
    window.panel = mountDealDocuments(document.querySelector('main'), { dealId, client: { async listDealDocuments() { return response; } } });
  }, { response, dealId: recordings.initial.request.deal_id });
  const type = page.getByRole('combobox', { name: 'Document type', exact: true });
  await page.getByText('4 matching of 4 loaded documents.', { exact: true }).waitFor();
  const labels = await type.locator('option').allTextContents();
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.includes('Unrecorded (unrecorded) (unrecorded) (unrecorded)'));
  for (const value of types) {
    await type.selectOption(value === null ? 'null' : `type:${value}`);
    assert.deepEqual(await page.locator('[data-document-id]').evaluateAll(rows => rows.map(row => row.dataset.documentId)),
      response.documents.filter(doc => doc.document_type === value).map(doc => doc.id));
  }
  await page.evaluate(() => window.panel.dispose());
});
