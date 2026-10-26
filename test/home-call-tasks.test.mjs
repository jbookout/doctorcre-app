import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountHomeCallTasks, readHomeCallTasks } from '../js/home-call-tasks.js';

const task = { candidateId: 'demo-candidate', sessionId: 'demo-session', dealId: 'demo-deal', dealName: 'Demo deal',
  owner: 'joe', description: 'Call the demo lender', dueOn: null, evidence: 'Joe will call the demo lender.' };
const wire = { id: task.candidateId, session_id: task.sessionId, kind: 'assigned_action', deal_id: task.dealId,
  deal_name: task.dealName, payload: { deal_id: task.dealId, assignee: task.owner, action: task.description, due_on: null },
  evidence_quote: task.evidence, created_at: '2026-10-01T14:00:00Z' };
const envelope = candidates => ({ schema_version: 'post-call-followups.v1', send: false, candidates });
const ready = { read: { state: 'read' }, tasks: [task], actor: 'joe', scope: 'team', signedOut: false, busy: false };
const receipt = { ok: true, candidate_id: task.candidateId, status: 'confirmed', ref: 'demo-action', assignee: 'joe' };
const settle = () => new Promise(resolve => setImmediate(resolve));

function mount(resolvePostCallCandidate = async () => receipt) {
  const dom = new JSDOM('<a id="homePrimaryAction" href="/deals">Deals</a><section id="tasks"></section>');
  const host = dom.window.document.getElementById('tasks');
  let changed = 0;
  const controller = mountHomeCallTasks({ document: dom.window.document, host,
    client: { resolvePostCallCandidate }, onChanged: async () => { changed++; } });
  controller.update(ready);
  return { dom, host, controller, get changed() { return changed; }, close() { controller.dispose(); dom.window.close(); } };
}

test('a changed Home actor retires the previous task review lifetime', async () => {
  const writes = [], h = mount(async args => { writes.push(args); return receipt; });
  const stale = h.host.querySelector('button');
  h.controller.update({ ...ready, actor: 'dell', tasks: [{ ...task, owner: 'dell' }] });
  stale.click();
  h.host.querySelector('button')?.click();
  await settle();
  assert.equal(h.host.hidden, true);
  assert.deepEqual(writes, []);
  h.close();
});

test('task reads preserve explicit facts and leave local email proposals untouched', async () => {
  const email = { ...wire, id: 'demo-email', kind: 'email_draft', payload: { deal_id: task.dealId,
    recipient_party_id: 'demo-recipient', recipient_ref: 'DEMO-P-01', subject: 'Demo email', body_sha256: 'a'.repeat(64) } };
  assert.deepEqual(await readHomeCallTasks({ getPostCallFollowups: async () => envelope([wire, email]) }), [task]);
  for (const payload of [
    { ...envelope([wire]), schema_version: 'post-call-followups.v2' },
    { ...envelope([wire]), send: true }, envelope([wire, wire]),
    envelope([{ ...wire, payload: { ...wire.payload, deal_id: 'other-deal' } }]),
    envelope([{ ...wire, payload: { ...wire.payload, due_on: '2026-02-30' } }]),
    envelope([{ ...wire, payload: { ...wire.payload, assignee: 'unknown' } }]),
    envelope([{ ...wire, payload: { ...wire.payload, assignee: 'toString' } }]),
    envelope([{ ...email, payload: null }]),
  ]) await assert.rejects(readHomeCallTasks({ getPostCallFollowups: async () => payload }), { code: 'malformed_response' });
});

test('an uncertain task decision keeps its key and blocks the opposite decision after a fresh pending read', async () => {
  const writes = [];
  const h = mount(async args => { writes.push(args); if (writes.length === 1) throw new TypeError('Synthetic response loss'); return receipt; });
  h.host.querySelector('[data-call-task-accept="true"]').click();
  await settle();
  h.controller.update({ ...ready, tasks: [] });
  assert.match(h.host.textContent, /Task outcome is unconfirmed/);
  assert.equal(h.host.querySelector('[data-call-task-accept="false"]').disabled, true);
  h.host.querySelector('[data-call-task-accept="true"]').click();
  await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(writes[1].accept, true);
  assert.match(h.host.textContent, /Task added/);
  h.close();
});

test('already resolved proposals refresh without claiming a task was added', async () => {
  const h = mount(async () => ({ ok: true, candidate_id: task.candidateId, already: 'confirmed', ref: 'demo-action' }));
  h.host.querySelector('button').click();
  await settle();
  assert.match(h.host.textContent, /already resolved/);
  assert.doesNotMatch(h.host.textContent, /Task added/);
  assert.equal(h.changed, 1);
  h.close();
});

test('malformed receipts retain an unconfirmed decision instead of a success claim', async t => {
  for (const result of [{ ...receipt, ok: false }, { ...receipt, candidate_id: 'other' }, { ...receipt, status: 'skipped' },
    { ...receipt, ref: null }, { ...receipt, assignee: 'dell' }, { ok: true, candidate_id: task.candidateId, already: true }]) {
    await t.test(JSON.stringify(result), async () => {
      const h = mount(async () => result);
      h.host.querySelector('button').click();
      await settle();
      assert.match(h.host.textContent, /Task outcome is unconfirmed/);
      assert.doesNotMatch(h.host.textContent, /Task added/);
      assert.equal(h.changed, 1);
      h.close();
    });
  }
});

test('loading and session invalidation disable stale Home task controls', async () => {
  const writes = [], h = mount(async args => { writes.push(args); return receipt; });
  h.controller.update({ ...ready, busy: true, read: { state: 'loading' } });
  assert.equal(h.host.querySelector('button').disabled, true);
  h.host.querySelector('button').click();
  h.controller.update(ready);
  const stale = h.host.querySelector('button');
  h.dom.window.dispatchEvent(new h.dom.window.Event('doctorcre-session-invalidated'));
  stale.click();
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(h.host.hidden, true);
  h.close();
});
