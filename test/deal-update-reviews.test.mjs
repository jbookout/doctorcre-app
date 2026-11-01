import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDealUpdateReviews as mount } from '../js/ui.generated.js';
import { sourceTime } from '../js/email-source-line.js';
import { readWithDeadline } from '../js/current-read.mjs';
import { uuidv4 } from '../js/uuid.js';
const mountDealUpdateReviews = options => mount({ ...options, sourceTime, readWithDeadline, uuidv4 });

const proposal = () => ({ assessment_id: 'demo-assessment', deal_id: 'demo-deal', deal_name: 'Demo Harbor expansion',
  confirm_verb: 'review-deal-update', assessment: { action: { id: 'demo-action', description: 'Request revised terms', due_on: '2026-10-01' },
    update: 'The landlord sent the revised terms today.', quote: 'The landlord sent the revised terms today.', review_required: true } });
const response = proposals => ({ schema_version: 'deal-update-reviews.v1', proposals });
function setup(t, client, options = {}) {
  const dom = new JSDOM('<section></section>');
  const container = dom.window.document.querySelector('section');
  const view = mountDealUpdateReviews({ container, client, ...options });
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
  assert.doesNotMatch(container.textContent, /Date unavailable|Update ·/);
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

for (const [code, message] of [
  ['assessment_already_reviewed', /already reviewed by the other partner/i],
  ['partner_required', /partner.*required/i],
  ['assessment_not_found', /This update is no longer waiting for review/i],
  ['not_action_owner', /only the task owner/i],
  ['unexpected', /Review was refused/i],
]) test(`review refusal ${code} explains the outcome`, async t => {
  const { view, action, container } = setup(t, { readDealUpdateReviews: async () => response([proposal()]), reviewDealUpdate: async () => { throw Object.assign(Error('refused'), { payload: { error: code } }); } });
  await view.refresh(); await action('Confirm');
  assert.match(container.textContent, message);
  if (code === 'not_action_owner') assert.equal(container.querySelectorAll('article button').length, 0);
});
for (const reason of ['awaiting_assessment', 'assessment_in_progress', 'interrupted']) test(`${reason} assessments stay visible without decisions`, async t => {
  const pending = { ...proposal(), assessment_id: 'pending', assessment: { ...proposal().assessment, reason, quote: undefined } };
  const { view, container } = setup(t, { readDealUpdateReviews: async () => response([null, pending]) });
  await view.refresh();
  assert.match(container.textContent, /still assessing/i);
  assert.equal(container.querySelectorAll('article button').length, 0);
});

const automatic = (id = 'auto') => ({ assessment_id: id, deal_id: 'demo-deal', deal_name: 'Demo Harbor', action_title: 'Request terms', quote: 'Terms arrived.', resolved_at: '2026-10-01T12:00:00Z', undo_possible: true });
test('a closed task that cannot be undone has no Undo button', async t => {
  const { view, container } = setup(t, { readDealUpdateReviews: async () => ({ ...response([]), automatic_resolutions: [{ ...automatic(), undo_possible: false }] }) });
  await view.refresh();
  assert.equal(container.querySelector('[data-update-action="undo"]'), null);
});
test('empty reviews are named before automatic closes', async t => {
  const { view, container } = setup(t, { readDealUpdateReviews: async () => ({ ...response([]), automatic_resolutions: [automatic()] }) });
  await view.refresh();
  assert.match(container.textContent, /No overdue reviews\..*Closed automatically/s);
});
test('automatically closed task can be undone', async t => {
  const writes = [];
  const { view, action, container } = setup(t, { readDealUpdateReviews: async () => ({ ...response([]), automatic_resolutions: [automatic()] }), reviewDealUpdate: async args => { writes.push(args); return { ok: true, decision: 'undo', action_id: 'demo-action' }; } });
  await view.refresh();
  assert.match(container.textContent, /Closed automatically.*Demo Harbor.*Request terms.*Terms arrived/s);
  assert.equal(container.querySelector('a').getAttribute('href'), '/deals?deal=demo-deal');
  await action('Undo');
  assert.equal(writes[0].decision, 'undo'); assert.equal(writes[0].assessment_id, 'auto');
  assert.ok(writes[0].reason && writes[0].idempotency_key);
  assert.match(container.textContent, /Task reopened/);
});
test('undo explains a newer change and other refusals', async t => {
  let code = 'newer_change_exists';
  const { view, action, container } = setup(t, { readDealUpdateReviews: async () => ({ ...response([]), automatic_resolutions: [automatic()] }), reviewDealUpdate: async () => { throw Object.assign(Error('refused'), { payload: { error: code } }); } });
  await view.refresh(); await action('Undo');
  assert.match(container.textContent, /A newer change was made to this task, so this can't be undone here\./);
  code = 'other'; await view.refresh(); await action('Undo');
  assert.match(container.textContent, /Review was refused/);
});
test('automatic closes share the panel cap and empty groups stay hidden', async t => {
  let closed = [automatic('one'), automatic('two'), automatic('three')];
  const { view, action, container } = setup(t, { readDealUpdateReviews: async () => ({ ...response([]), automatic_resolutions: closed }) });
  await view.refresh(); assert.equal(container.querySelectorAll('article').length, 2);
  await action('Show 1 more'); assert.equal(container.querySelectorAll('article').length, 3);
  closed = []; await view.refresh(); assert.doesNotMatch(container.textContent, /Closed automatically/);
});
test('session loss clears automatically closed tasks', async t => {
  const { view, container } = setup(t, { readDealUpdateReviews: async () => ({ ...response([]), automatic_resolutions: [automatic()] }) });
  await view.refresh(); container.ownerDocument.defaultView.dispatchEvent(new container.ownerDocument.defaultView.Event('doctorcre-session-invalidated'));
  assert.doesNotMatch(container.textContent, /Demo Harbor|Terms arrived/);
});

for (const [label, receipt] of [
  ['verified', { ok: true, decision: 'undo', action_id: 'demo-action' }],
  ['wrong decision', { ok: true, decision: 'resolve', action_id: 'demo-action' }],
  ['ok false', { ok: false, decision: 'undo', action_id: 'demo-action' }],
  ['missing action_id', { ok: true, decision: 'undo' }],
  ['lost response', null],
]) test(`undo ${label} refreshes the agenda only after a verified receipt`, async t => {
  let changes = 0;
  let complete;
  const writes = [];
  const { view, action, container } = setup(t, {
    readDealUpdateReviews: async () => ({ ...response([]), automatic_resolutions: [automatic()] }),
    reviewDealUpdate: request => {
      writes.push(structuredClone(request));
      return new Promise((resolve, reject) => { complete = () => receipt ? resolve(receipt) : reject(Error('lost response')); });
    },
  }, { onChange: () => { changes += 1; } });
  await view.refresh();
  const pending = action('Undo');
  assert.equal(changes, 0);
  complete(); await pending;
  if (label === 'verified') {
    assert.equal(changes, 1);
    assert.match(container.textContent, /Task reopened/);
  } else {
    assert.equal(changes, 0);
    assert.match(container.textContent, /Review outcome unconfirmed/);
    assert.doesNotMatch(container.textContent, /Task reopened/);
    const replay = action('Check outcome');
    assert.deepEqual(writes[1], writes[0]);
    complete(); await replay;
    assert.equal(changes, 0);
    assert.match(container.textContent, /Review outcome unconfirmed/);
  }
});
