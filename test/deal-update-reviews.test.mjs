import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDealUpdateReviews } from '../js/deal-update-reviews.js';

const proposal = () => ({ assessment_id: 'demo-assessment', deal_id: 'demo-deal', deal_name: 'Demo Harbor expansion',
  confirm_verb: 'review-deal-update', assessment: { action: { id: 'demo-action', description: 'Request revised terms', due_on: '2026-10-01' },
    update: 'The landlord sent the revised terms today.', quote: 'The landlord sent the revised terms today.', review_required: true } });
const response = proposals => ({ schema_version: 'deal-update-reviews.v1', proposals });
function setup(t, client) {
  const dom = new JSDOM('<section></section>');
  const container = dom.window.document.querySelector('section');
  const view = mountDealUpdateReviews({ container, client });
  t.after(() => { view.dispose(); dom.window.close(); });
  return { container, view, action: name => view.click({ target: [...container.querySelectorAll('button')].find(b => b.textContent === name) }) };
}
test('Home overdue review names the deal, overdue task, evidence and exact proposed change', async t => {
  const { container, view } = setup(t, { readDealUpdateReviews: async () => response([proposal()]) });
  await view.refresh();
  assert.ok(container.querySelector('article.work-card'));
  assert.equal(container.querySelector('a').getAttribute('href'), '/deals?deal=demo-deal');
  assert.match(container.textContent, /Demo Harbor expansion/);
  assert.match(container.textContent, /Request revised terms/);
  assert.equal(container.querySelector('q').textContent, proposal().assessment.quote);
  assert.match(container.textContent, /Mark this overdue task as done/);
});
for (const [label, decision] of [['Confirm', 'resolve'], ['Dismiss', 'dismiss']]) test(`${label} reviews only the displayed assessment with a reason`, async t => {
  const writes = [];
  const { container, view, action } = setup(t, { readDealUpdateReviews: async () => response([proposal()]),
    reviewDealUpdate: async request => { writes.push(request); return { ok: true, decision: request.decision, action_id: 'demo-action' }; } });
  await view.refresh(); await action(label);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].assessment_id, 'demo-assessment');
  assert.equal(writes[0].decision, decision);
  assert.ok(writes[0].reason.trim()); assert.ok(writes[0].idempotency_key);
  assert.match(container.textContent, decision === 'resolve' ? /Task marked done/ : /Dismissed. Task remains open/);
  assert.equal(container.querySelectorAll('button').length, 0);
});
test('uncertain review locks the other decision and retries the exact original request after refresh', async t => {
  const writes = [];
  let rows = [proposal()];
  const { view, action, container } = setup(t, { readDealUpdateReviews: async () => response(rows), reviewDealUpdate: async request => {
    writes.push(structuredClone(request)); if (writes.length === 1) throw Error('lost response');
    return { ok: true, decision: 'resolve', action_id: 'demo-action' };
  } });
  await view.refresh(); await action('Confirm'); rows = []; await view.refresh();
  assert.equal(container.querySelectorAll('button').length, 1);
  await action('Check outcome');
  assert.deepEqual(writes[1], writes[0]); assert.match(container.textContent, /Task marked done/);
});
test('stale action refusal requires a fresh read instead of offering an uncertain retry', async t => {
  const { view, action, container } = setup(t, { readDealUpdateReviews: async () => response([proposal()]), reviewDealUpdate: async () => {
    throw Object.assign(Error('changed'), { payload: { error: 'overdue_action_changed' } });
  } });
  await view.refresh(); await action('Confirm');
  assert.match(container.textContent, /The task changed. Refresh overdue reviews before deciding again/);
  assert.doesNotMatch(container.textContent, /Check outcome/);
});
test('read failure and malformed schema never claim empty and disable retained cards', async t => {
  let result = response([proposal()]);
  const { view, container } = setup(t, { readDealUpdateReviews: async () => { if (result instanceof Error) throw result; return result; } });
  await view.refresh(); result = Error('offline'); await view.refresh();
  assert.match(container.textContent, /Could not load/); assert.match(container.textContent, /Request revised terms/);
  assert.ok([...container.querySelectorAll('[data-update-id] button')].every(b => b.disabled));
  result = { proposals: [] }; await view.refresh(); assert.doesNotMatch(container.textContent, /No overdue reviews/);
  result = response([]); await view.refresh(); assert.match(container.textContent, /No overdue reviews/);
});
test('session loss clears evidence and rejects a late read', async t => {
  let resolve;
  const { view, container } = setup(t, { readDealUpdateReviews: () => new Promise(done => { resolve = done; }) });
  const pending = view.refresh();
  container.ownerDocument.defaultView.dispatchEvent(new container.ownerDocument.defaultView.Event('doctorcre-session-invalidated'));
  resolve(response([proposal()])); await pending;
  assert.match(container.textContent, /Sign in/); assert.doesNotMatch(container.textContent, /Demo Harbor/);
});
