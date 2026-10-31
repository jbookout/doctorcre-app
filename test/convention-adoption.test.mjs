import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountBoard } from '../js/progress-board.js';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { validGovernanceQueuePayload } from '../js/operations-model.js';

const html = await readFile(new URL('../control-room.html', import.meta.url), 'utf8');
const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
const fixture = () => createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}`, docContext: false });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function mount(t, overrides = {}) {
  const client = Object.assign(await fixture(), overrides);
  const dom = new JSDOM(html, { url: 'https://example.test/control-room?tab=approvals' });
  const board = mountBoard({ client, window: dom.window, document: dom.window.document, storage: null,
    setInterval: () => 0, setTimeout: () => 0 });
  t.after(() => { board.dispose(); dom.window.close(); });
  board.setGovernance(await client.governanceQueue());
  return { client, board, doc: dom.window.document, window: dom.window,
    submit: async form => { form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle(); await settle(); } };
}

test('Approvals lists two fixture conventions with statement, slug, packs and time', async t => {
  const page = await mount(t);
  const queue = await page.client.governanceQueue();
  assert.equal(validGovernanceQueuePayload(queue), true);
  assert.equal(queue.pending_convention_proposals.length, 2);
  const cards = page.doc.querySelectorAll('[data-convention]');
  assert.equal(cards.length, 2);
  for (const [index, row] of queue.pending_convention_proposals.entries()) {
    assert.equal(cards[index].querySelector('h3').textContent, row.section_key.split('/').at(-1));
    assert.equal(cards[index].querySelector('.convention-body').textContent, row.statement);
    assert.match(cards[index].textContent, /demo/);
    assert.equal(cards[index].querySelector('time').dateTime, row.updated_at);
  }
});

test('Adopt requires Why, sends the reviewed version and a fresh key, then removes only that proposal', async t => {
  const writes = [];
  const client = await fixture();
  const page = await mount(t, { adoptRule: async args => { writes.push(args); return client.adoptRule(args); } });
  const row = (await page.client.governanceQueue()).pending_convention_proposals[0];
  const form = page.doc.querySelector('[data-convention] form');
  assert.ok(form, 'an adoption form is available');
  assert.equal(form.querySelector('textarea').required, true);
  await page.submit(form);
  assert.equal(writes.length, 0);
  form.querySelector('textarea').value = 'Reviewed the demo convention.';
  await page.submit(form);
  assert.equal(writes.length, 1);
  assert.match(writes[0].idempotency_key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(writes[0], { idempotency_key: writes[0].idempotency_key, section_id: row.approve_with.section_id,
    base_version: row.approve_with.base_version, reason: 'Reviewed the demo convention.' });
  assert.equal(page.doc.querySelectorAll('[data-convention]').length, 1);
  assert.equal(page.doc.querySelector('#conventionStatus').textContent, 'Adopted');
  assert.equal((await client.governanceQueue()).pending_convention_proposals.length, 1);
  assert.equal((await client.adoptRule(writes[0])).retired_section_id, row.section_id, 'same-key replay succeeds');
});

test('version conflict rereads the proposal and requires another review with a fresh key', async t => {
  const source = await fixture();
  let queue = await source.governanceQueue();
  const writes = [];
  const page = await mount(t, { governanceQueue: async () => structuredClone(queue), adoptRule: async args => {
    writes.push(args);
    if (writes.length === 1) {
      queue.pending_convention_proposals[0].base_version = 9;
      queue.pending_convention_proposals[0].approve_with.base_version = 9;
      queue.pending_convention_proposals[0].statement = 'Demo changed text.';
      throw Object.assign(new Error('conflict'), { payload: { error: 'version_conflict' } });
    }
    return { ok: true, rule_id: 'demo-rule', retired_section_id: args.section_id };
  } });
  let form = page.doc.querySelector('[data-convention] form');
  form.querySelector('textarea').value = 'Demo reviewed.';
  await page.submit(form);
  assert.match(page.doc.querySelector('#conventionStatus').textContent, /changed.*look again/i);
  const changed = page.doc.querySelector(`[data-convention="${writes[0].section_id}"]`);
  assert.match(changed.querySelector('.convention-body').textContent, /changed text/);
  assert.equal(writes.length, 1);
  form = changed.querySelector('form');
  form.querySelector('textarea').value = 'Demo reviewed the changed text.';
  await page.submit(form);
  assert.equal(writes[1].base_version, 9);
  assert.notEqual(writes[1].idempotency_key, writes[0].idempotency_key);
});

test('unknown outcome retains the full request and visible proposal even if a poll omits it', async t => {
  const writes = [];
  const page = await mount(t, { adoptRule: async args => {
    writes.push(structuredClone(args));
    if (writes.length === 1) throw new Error('Demo lost response');
    return { ok: true, rule_id: 'demo-rule', retired_section_id: args.section_id };
  } });
  const form = page.doc.querySelector('[data-convention] form');
  const reason = form.querySelector('textarea');
  reason.value = 'Demo reviewed this exact version.';
  await page.submit(form);
  assert.equal(form.querySelector('button').textContent, 'Check outcome');
  assert.equal(reason.disabled, true);
  assert.doesNotMatch(page.doc.querySelector('#conventionStatus').textContent, /Adopted/);
  const empty = await page.client.governanceQueue();
  empty.pending_convention_proposals = [];
  empty.counts.total -= empty.counts.pending_convention_proposals;
  empty.counts.pending_convention_proposals = 0;
  page.board.setGovernance(empty);
  assert.equal(page.doc.querySelectorAll('[data-convention]').length, 1, 'unknown request survives queue omission');
  reason.value = 'Attempt to change the original reason';
  await page.submit(form);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(page.doc.querySelector('#conventionStatus').textContent, 'Adopted');
});

test('proposal content is literal and non-adoptable proposals explain why', async t => {
  const queue = await (await fixture()).governanceQueue();
  Object.assign(queue.pending_convention_proposals[0], { statement: '<script>bad()</script><b>Demo text</b>' });
  Object.assign(queue.pending_convention_proposals[1], { adoptable: false, problem: 'Missing Packs', statement: undefined, packs: undefined, approve_with: undefined });
  const page = await mount(t, { governanceQueue: async () => queue });
  const cards = page.doc.querySelectorAll('[data-convention]');
  assert.equal(cards[0].querySelector('.convention-body').textContent, '<script>bad()</script><b>Demo text</b>');
  assert.equal(cards[0].querySelectorAll('script,b').length, 0);
  assert.equal(cards[1].querySelector('button').disabled, true);
  assert.match(cards[1].textContent, /Missing Packs/);
});

test('live adoption sends exact args under the partner session and CSRF, retaining an unknown receipt', async () => {
  const writes = [];
  let actor = 'joe';
  const args = { idempotency_key: crypto.randomUUID(), section_id: 'demo-section', base_version: 7, reason: 'Demo review.' };
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: actor }, csrf_token: `synthetic-${actor}` });
    const call = JSON.parse(init.body).params;
    writes.push({ call, headers: init.headers });
    const result = writes.length === 1 ? { ok: true } : { ok: true, rule_id: 'demo-rule', retired_section_id: args.section_id };
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  await assert.rejects(client.adoptRule(args), { code: 'unknown_outcome' });
  actor = 'dell';
  await assert.rejects(client.adoptRule(args), { code: 'session_changed' });
  assert.equal(writes.length, 1);
  actor = 'joe';
  assert.equal((await client.adoptRule(args)).retired_section_id, args.section_id);
  assert.deepEqual(writes.map(row => row.call), [1, 2].map(() => ({ name: 'adopt-rule', arguments: args })));
  for (const write of writes) assert.equal(new Headers(write.headers).get('x-carr-csrf'), 'synthetic-joe');
});

test('a conflict with failed reread offers Reload proposal without resending the obsolete version', async t => {
  const source = await fixture();
  const queue = await source.governanceQueue();
  let failRead = false;
  let writes = 0;
  const page = await mount(t, { governanceQueue: async () => {
    if (failRead) throw new Error('Demo read offline');
    return queue;
  }, adoptRule: async () => {
    writes++; failRead = true;
    throw Object.assign(new Error('conflict'), { payload: { error: 'version_conflict' } });
  } });
  const form = page.doc.querySelector('[data-convention] form');
  form.querySelector('textarea').value = 'Demo reviewed.';
  await page.submit(form);
  assert.equal(form.querySelector('button').textContent, 'Reload proposal');
  assert.equal(form.querySelector('textarea').disabled, true);
  assert.match(form.textContent, /Could not reload/);
  await page.submit(form);
  assert.equal(writes, 1);
  failRead = false;
  await page.submit(form);
  assert.equal(writes, 1);
  assert.equal(page.doc.querySelector('[data-convention] button').textContent, 'Adopt');
});

test('approval read failure disables fresh adoption and sign-out clears proposal text', async t => {
  const page = await mount(t);
  page.board.setGovernance(null, { reason: 'Updates unavailable' });
  assert.equal(page.doc.querySelector('[data-convention] button').disabled, true);
  page.board.setGovernance(null, { reason: 'Sign in required' });
  assert.equal(page.doc.querySelectorAll('[data-convention]').length, 0);
});

test('unpublished progress snapshot does not hide independently loaded approvals', async t => {
  const page = await mount(t, { readProgressBoard: async () => ({ snapshot: null }) });
  await page.board.refresh(true);
  assert.equal(page.doc.querySelectorAll('[data-convention]').length, 2);
});
