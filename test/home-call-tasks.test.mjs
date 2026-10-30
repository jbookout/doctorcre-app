import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountHomeCallTasks, readHomeCallFollowups } from '../js/home-call-tasks.js';

const task = { kind: 'assigned_action', candidateId: 'demo-candidate', sessionId: 'demo-session', dealId: 'demo-deal', dealName: 'Demo deal',
  createdAt: '2026-10-01T14:00:00Z', owner: 'joe', description: 'Call the demo lender', dueOn: null, evidence: 'Joe will call the demo lender.' };
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

test('follow-up reads preserve tasks and pending email metadata', async () => {
  const email = { ...wire, id: 'demo-email', kind: 'email_draft', payload: { deal_id: task.dealId,
    recipient_party_id: 'demo-recipient', recipient_ref: 'DEMO-P-01', subject: 'Demo email', body_sha256: 'a'.repeat(64) } };
  assert.deepEqual(await readHomeCallFollowups({ getPostCallFollowups: async () => envelope([wire, email]) }), [task, { kind: 'email_draft', candidateId: 'demo-email', sessionId: task.sessionId, dealId: task.dealId, dealName: task.dealName, createdAt: wire.created_at, subject: 'Demo email', recipientRef: 'DEMO-P-01', evidence: task.evidence }]);
  for (const payload of [
    { ...envelope([wire]), schema_version: 'post-call-followups.v2' },
    { ...envelope([wire]), send: true }, envelope([wire, wire]),
    envelope([{ ...wire, payload: { ...wire.payload, deal_id: 'other-deal' } }]),
    envelope([{ ...wire, payload: { ...wire.payload, due_on: '2026-02-30' } }]),
    envelope([{ ...wire, payload: { ...wire.payload, assignee: 'unknown' } }]),
    envelope([{ ...wire, payload: { ...wire.payload, assignee: 'toString' } }]),
    envelope([{ ...email, payload: null }]),
  ]) await assert.rejects(readHomeCallFollowups({ getPostCallFollowups: async () => payload }), { code: 'malformed_response' });
});

test('an uncertain task decision keeps its key and blocks the opposite decision after a fresh pending read', async () => {
  const writes = [];
  const h = mount(async args => { writes.push(args); if (writes.length === 1) throw new TypeError('Synthetic response loss'); return receipt; });
  h.host.querySelector('[data-call-task-accept="true"]').click();
  await settle();
  h.controller.update({ ...ready, tasks: [] });
  assert.match(h.host.textContent, /Task outcome is unconfirmed/);
  assert.equal(h.host.querySelector('[data-call-task-accept="false"]').getAttribute('aria-disabled'), 'true');
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
  assert.equal(h.host.querySelector('button').getAttribute('aria-disabled'), 'true');
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

test('focus stays on the task button during a Home refresh', async () => {
  const h = mount();
  const key = h.host.querySelector('[data-call-task-accept="true"]').dataset.callTaskKey;
  h.host.querySelector('[data-call-task-accept="true"]').focus();
  h.controller.update({ ...ready, busy: true, read: { state: 'loading' } });
  const during = h.host.querySelector(`[data-call-task-key="${key}"]`);
  assert.equal(h.dom.window.document.activeElement, during);
  assert.equal(during.getAttribute('aria-disabled'), 'true');
  assert.equal(during.hasAttribute('disabled'), false);
  h.controller.update(ready);
  const after = h.host.querySelector(`[data-call-task-key="${key}"]`);
  assert.equal(h.dom.window.document.activeElement, after);
  assert.notEqual(after.getAttribute('aria-disabled'), 'true');
  h.close();
});

test('focus stays on the task button while a decision submits and after it resolves', async () => {
  let release;
  const writes = [];
  const h = mount(async args => { writes.push(args); await new Promise(resolve => { release = resolve; }); return receipt; });
  const doc = h.dom.window.document;
  h.host.querySelector('[data-call-task-accept="true"]').focus();
  h.host.querySelector('[data-call-task-accept="true"]').click();
  await settle();
  const submitting = h.host.querySelector('[data-call-task-accept="true"]');
  assert.equal(doc.activeElement, submitting);
  assert.equal(submitting.getAttribute('aria-disabled'), 'true');
  submitting.click();
  await settle();
  assert.equal(writes.length, 1);
  release();
  await settle();
  assert.equal(doc.activeElement, h.host.querySelector('[data-call-task-accept="true"]'));
  h.close();
});

test('the notice clears once the last proposal has resolved', async () => {
  const h = mount();
  h.host.querySelector('button').click();
  await settle();
  assert.match(h.host.textContent, /Task added/);
  h.controller.update({ ...ready, tasks: [] });
  assert.doesNotMatch(h.host.textContent, /Task added/);
  assert.equal(h.host.hidden, false);
  h.close();
});

test('the notice clears on the first completed read even while other proposals remain', async () => {
  const h = mount();
  const sibling = { ...task, candidateId: 'demo-sibling' };
  h.controller.update({ ...ready, tasks: [task, sibling] });
  h.host.querySelector('button').click();
  await settle();
  assert.match(h.host.textContent, /Task added/);
  h.controller.update({ ...ready, tasks: [sibling] });
  assert.doesNotMatch(h.host.textContent, /Task added/);
  assert.equal(h.host.querySelectorAll('[data-call-task]').length, 1);
  h.close();
});

test('repeated updates keep the unconfirmed alert and notice nodes stable', async () => {
  const h = mount(async () => { throw new TypeError('Synthetic response loss'); });
  h.host.querySelector('button').click();
  await settle();
  const alert = h.host.querySelector('[role="alert"]');
  assert.ok(alert);
  for (const next of [{ ...ready, busy: true, read: { state: 'loading' } }, { ...ready, busy: true, read: { state: 'loading' } }, ready, ready, { ...ready, tasks: [] }]) {
    h.controller.update(next);
    assert.equal(h.host.querySelector('[role="alert"]'), alert);
  }
  assert.equal(alert.isConnected, true);
  h.close();
});


test('Home offers the exact email call report without making a decision', async () => {
  const writes = [], opened = [];
  const dom = new JSDOM('<section id="tasks"></section>');
  const host = dom.window.document.getElementById('tasks');
  const controller = mountHomeCallTasks({ document: dom.window.document, host,
    client: { resolvePostCallCandidate: async args => { writes.push(args); } },
    openReport: async session => { opened.push(session); return true; }, onChanged: async () => {} });
  const draft = { kind: 'email_draft', candidateId: 'demo-email', sessionId: 'older-demo-call', dealId: task.dealId,
    dealName: task.dealName, subject: 'Demo <lender> follow-up', recipientRef: 'DEMO-P-01', evidence: 'Ask the demo lender.' };
  controller.update({ ...ready, tasks: [task, draft] });
  assert.match(host.textContent, /Demo <lender> follow-up.*DEMO-P-01.*Draft only/s);
  assert.equal(host.querySelector('lender'), null);
  host.querySelector('[data-call-draft-id]').click();
  await settle();
  assert.deepEqual(opened, ['older-demo-call']);
  assert.deepEqual(writes, []);
  controller.update({ ...ready, tasks: [task, draft], scope: 'mine' });
  assert.equal(host.querySelector('[data-call-draft-id]'), null);
  controller.update({ ...ready, tasks: [draft], busy: true });
  host.querySelector('[data-call-draft-id]').click();
  await settle();
  assert.equal(opened.length, 1);
  controller.update({ ...ready, tasks: [draft] });
  const stale = host.querySelector('[data-call-draft-id]');
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  stale.click();
  await settle();
  assert.equal(opened.length, 1);
  assert.equal(host.hidden, true);
  controller.dispose(); dom.window.close();
});

test('an unavailable draft report explains where to review it', async () => {
  const dom = new JSDOM('<section id="tasks"></section>');
  const host = dom.window.document.getElementById('tasks');
  const controller = mountHomeCallTasks({ document: dom.window.document, host, client: {},
    openReport: async () => false, onChanged: async () => {} });
  controller.update({ ...ready, tasks: [{ kind: 'email_draft', candidateId: 'demo-email', sessionId: 'demo-call',
    dealId: 'demo-deal', dealName: 'Demo deal', subject: 'Demo email', recipientRef: 'DEMO-P-01', evidence: '' }] });
  host.querySelector('[data-call-draft-id]').click();
  await settle();
  assert.match(host.textContent, /Open Call Mode on the Mac that recorded this call/);
  assert.equal(host.querySelector('[data-call-draft-id]').getAttribute('aria-disabled'), null);
  controller.dispose(); dom.window.close();
});


test('call follow-ups show recorded proposal time separately from task due date', async () => {
  const email = { ...wire, id: 'demo-source-email', kind: 'email_draft', payload: { deal_id: task.dealId,
    recipient_party_id: 'demo-recipient', recipient_ref: 'DEMO-P-01', subject: 'Demo email', body_sha256: 'a'.repeat(64) } };
  const tasks = await readHomeCallFollowups({ getPostCallFollowups: async () => envelope([
    { ...wire, payload: { ...wire.payload, due_on: '2026-10-05' } }, email,
  ]) });
  const h = mount();
  h.controller.update({ ...ready, tasks });
  for (const article of h.host.querySelectorAll('article')) {
    assert.match(article.textContent, /From your call with Demo deal, .* ago/);
    assert.equal(article.querySelector('.home-call-source time').dateTime, '2026-10-01T14:00:00Z');
  }
  assert.equal(h.host.querySelector('[data-call-task] .home-call-task-controls time').dateTime, '2026-10-05');
  h.close();
});

test('call review labels its source age, due date and empty/loading states', () => {
  const h = mount();
  h.controller.update({ ...ready, tasks: [{ ...task, dueOn: '2026-10-02' }] });
  assert.match(h.host.textContent, /From your call with Demo deal, .* ago/);
  assert.match(h.host.querySelector('.home-call-task-controls').textContent, /Due Oct 2/);
  h.controller.update({ ...ready, tasks: [] });
  assert.equal(h.host.hidden, false);
  assert.match(h.host.textContent, /No call follow-ups/);
  h.controller.update({ ...ready, tasks: [], busy: true });
  assert.ok(h.host.querySelector('.home-followup-skeleton'));
  h.close();
});
