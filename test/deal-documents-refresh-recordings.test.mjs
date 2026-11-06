import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
