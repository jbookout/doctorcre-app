import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDealUpdateReviews } from '../js/ui-deal-reviews.generated.js';
const row = () => ({ assessment_id: 'review', deal_id: 'deal', deal_name: 'Synthetic deal', confirm_verb: 'review-deal-update', assessment: { review_required: true, action: { id: 'action', description: 'Send terms' }, update: 'Terms sent' } });
const auto = () => ({ assessment_id: 'closed', deal_id: 'deal', deal_name: 'Synthetic closed', action_title: 'Terms', quote: 'Sent', resolved_at: '2026-10-01', undo_possible: true });
const result = (proposals = [], automatic_resolutions = []) => ({ schema_version: 'deal-update-reviews.v1', proposals, automatic_resolutions });
function setup(t, client) {
  const dom = new JSDOM('<section></section>');
  const container = dom.window.document.querySelector('section');
  const view = mountDealUpdateReviews({ container, client, sourceTime: x => x, readWithDeadline: read => read(), uuidv4: () => 'synthetic-key' });
  t.after(() => { view.dispose(); dom.window.close(); });
  return { view, container, click: action => view.click({ target: container.querySelector('[data-update-action="' + action + '"]') }) };
}
for (const [name, value, visible] of [
  ['all rejected', result([null]), false], ['mixed', result([row(), null]), true],
  ['automatic rejected', result([], [null]), false], ['automatic mixed', result([], [auto(), null]), true],
  ['spoofed automatic', result([{ ...row(), automatic: true, action_title: {} }]), false],
  ['object name', result([{ ...row(), deal_name: {} }]), false],
  ['object identity', result([{ ...row(), deal_id: {} }]), false],
  ['object reason', result([{ ...row(), assessment: { ...row().assessment, reason: {} } }]), false],
  ['duplicate', result([row(), row()]), true],
]) test(name + ' reports incomplete coverage without claiming empty', async t => {
  const { view, container } = setup(t, { readDealUpdateReviews: async () => value });
  await view.refresh();
  assert.match(container.textContent, /Some overdue reviews are unavailable/);
  assert.doesNotMatch(container.textContent, /No overdue reviews/);
  assert.equal(!!container.querySelector('article'), visible);
  assert.ok(container.querySelector('[data-update-action="refresh"]'));
});
test('retry replaces unavailable coverage with a verified empty inbox', async t => {
  let value = result([null]);
  const { view, container, click } = setup(t, { readDealUpdateReviews: async () => value });
  await view.refresh(); value = result(); await click('refresh');
  assert.match(container.textContent, /No overdue reviews/); assert.doesNotMatch(container.textContent, /unavailable/);
});
test('recovery preserves original decision and exact receipt beside unavailable coverage', async t => {
  let value = result([row()]); const writes = [];
  const { view, container, click } = setup(t, { readDealUpdateReviews: async () => value, reviewDealUpdate: async request => {
    writes.push(structuredClone(request));
    return { ok: true, decision: request.decision, action_id: writes.length === 1 ? 'wrong' : 'action' };
  } });
  await view.refresh(); await click('resolve'); assert.match(container.textContent, /unconfirmed/);
  value = result([null]); await view.refresh(); assert.match(container.textContent, /unavailable/);
  await click('replay'); assert.deepEqual(writes[0], writes[1]); assert.match(container.textContent, /Task marked done/);
});
for (const stage of ['pending', 'ready', 'unavailable', 'recovery']) for (const end of ['retire', 'dispose']) test(stage + ' ' + end + ' ignores late results', async t => {
  let finish; let value = stage === 'unavailable' ? result([null]) : result([row()]);
  const { view, container, click } = setup(t, { readDealUpdateReviews: () => value, reviewDealUpdate: async () => { throw Error('offline'); } });
  await view.refresh(); if (stage === 'recovery') await click('resolve');
  if (stage === 'pending') value = new Promise(resolve => { finish = resolve; });
  const pending = stage === 'pending' ? view.refresh() : Promise.resolve();
  if (end === 'dispose') view.dispose();
  else container.ownerDocument.defaultView.dispatchEvent(new container.ownerDocument.defaultView.Event('doctorcre-session-invalidated'));
  finish?.(result([row()])); await pending; assert.doesNotMatch(container.textContent, /Synthetic/);
  if (end === 'retire') assert.match(container.textContent, /Sign in/);
});
test('source ordering and valid actions survive rejected automatic rows', async t => {
  const { view, container } = setup(t, { readDealUpdateReviews: async () => result([row()], [null, auto()]) });
  await view.refresh();
  assert.deepEqual([...container.querySelectorAll('article')].map(n => n.dataset.updateId), ['review', 'closed']);
  assert.equal(container.querySelector('[data-update-action="resolve"]').disabled, false);
});
test('unavailable valid row can enter recovery and retry restores coverage', async t => {
  let value = result([row(), null]);
  const { view, container, click } = setup(t, { readDealUpdateReviews: async () => value, reviewDealUpdate: async () => { throw Error('offline'); } });
  await view.refresh(); await click('resolve'); assert.match(container.textContent, /unconfirmed/);
  value = result([row()]); await view.refresh(); assert.doesNotMatch(container.textContent, /unavailable/);
  assert.match(container.textContent, /Check outcome/);
});
for (const status of [401, 403]) test('authorization read failure ' + status + ' retires coverage', async t => {
  const { view, container } = setup(t, { readDealUpdateReviews: async () => { throw Object.assign(Error('denied'), { status }); } });
  await view.refresh(); assert.match(container.textContent, /Sign in/);
  await view.refresh(); assert.match(container.textContent, /Sign in/);
});
for (const end of ['retire', 'dispose']) test(end + ' ignores late writes and teardown is idempotent', async t => {
  let finish; let changes = 0;
  const { view, container, click } = setup(t, { readDealUpdateReviews: async () => result([row()]), reviewDealUpdate: () => new Promise(resolve => { finish = resolve; changes++; }) });
  await view.refresh(); const pending = click('resolve');
  if (end === 'dispose') view.dispose();
  else container.ownerDocument.defaultView.dispatchEvent(new container.ownerDocument.defaultView.Event('doctorcre-session-invalidated'));
  finish({ ok: true, decision: 'resolve', action_id: 'action' }); await pending;
  assert.doesNotMatch(container.textContent, /Task marked done|Synthetic/); assert.equal(changes, 1);
  view.dispose(); view.dispose();
});
test('failed read disables retained rows then explicit retry recovers', async t => {
  let fail = false;
  const { view, container, click } = setup(t, { readDealUpdateReviews: async () => { if (fail) throw Error('offline'); return result([row()]); } });
  await view.refresh(); fail = true; await view.refresh();
  assert.match(container.textContent, /Could not load/); assert.equal(container.querySelector('article button').disabled, true);
  fail = false; await click('refresh'); assert.equal(container.querySelector('article button').disabled, false);
});
