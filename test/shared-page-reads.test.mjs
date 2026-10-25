import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';

const response = payload => new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }));
function transport() {
  const calls = [];
  const fetchImpl = (_path, init) => new Promise((resolve, reject) => {
    calls.push({ args: JSON.parse(init.body).params, signal: init.signal,
      finish: payload => resolve(response(payload)), fail: () => reject(new Error('Synthetic connection failure')) });
  });
  return { calls, fetchImpl };
}

test('same-page clients share concurrent board and brief reads without retaining settled data', async () => {
  const { calls, fetchImpl } = transport();
  const a = createLiveClient({ fetchImpl }), b = createLiveClient({ fetchImpl });
  const pending = [a.getBoard(), b.getBoard({ workspace: 'all' }), a.morningBrief(), b.morningBrief()];
  const initialRequests = calls.length;
  for (const call of calls) call.finish(call.args.name === 'deal-room-board'
    ? { actor: 'joe', deals: [{ id: 'demo-deal', name: 'Demo Deal', phase: 'legal' }] }
    : { sponsor: 'joe', sections: {} });
  const [boardA, boardB, briefA, briefB] = await Promise.all(pending);
  assert.equal(initialRequests, 2, 'one HTTP request for each shared fact');
  assert.equal(boardA.deals[0].name, 'Demo Deal');
  boardA.deals[0].name = 'Local display change';
  briefA.sections.local = true;
  assert.equal(boardB.deals[0].name, 'Demo Deal');
  assert.deepEqual(briefB.sections, {});
  const fresh = a.morningBrief();
  assert.equal(calls.length, 3, 'settlement requires a fresh authorized read next time');
  calls[2].finish({ sponsor: 'joe', sections: { updated: true } });
  assert.deepEqual((await fresh).sections, { updated: true });
});

test('one cancelled consumer does not cancel another, and the last cancellation releases the transport', async () => {
  const { calls, fetchImpl } = transport();
  const a = createLiveClient({ fetchImpl }), b = createLiveClient({ fetchImpl });
  const controller = new AbortController();
  const cancelledRead = a.morningBrief({ signal: controller.signal });
  const kept = b.morningBrief();
  const rejected = assert.rejects(cancelledRead, { code: 'read_timeout' });
  controller.abort();
  await rejected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  calls[0].finish({ sponsor: 'joe' });
  assert.equal((await kept).sponsor, 'joe');
  const last = new AbortController();
  const pending = a.morningBrief({ signal: last.signal });
  const lastRejected = assert.rejects(pending, { code: 'read_timeout' });
  last.abort();
  await lastRejected;
  assert.equal(calls[1].signal.aborted, true);
  const next = b.morningBrief();
  assert.equal(calls.length, 3);
  calls[1].finish({ sponsor: 'obsolete' });
  calls[2].finish({ sponsor: 'joe' });
  assert.equal((await next).sponsor, 'joe');
});

test('failed shared reads are retried, and distinct actor and board scopes never share', async () => {
  const { calls, fetchImpl } = transport();
  const a = createLiveClient({ fetchImpl, selfActor: 'joe' }), b = createLiveClient({ fetchImpl, selfActor: 'joe' });
  const failures = [assert.rejects(a.morningBrief(), /Synthetic connection failure/), assert.rejects(b.morningBrief(), /Synthetic connection failure/)];
  assert.equal(calls.length, 1);
  calls[0].fail();
  await Promise.all(failures);
  const retry = a.morningBrief();
  calls[1].finish({ sponsor: 'joe' });
  assert.equal((await retry).sponsor, 'joe');
  const other = createLiveClient({ fetchImpl, selfActor: 'dell' });
  const reads = [a.getBoard(), b.getBoard({ workspace: 'mine' }), other.getBoard(), a.getBoard({ account_client_id: 'demo-account' })];
  assert.equal(calls.length, 6);
  for (const call of calls.slice(2)) call.finish({ actor: 'joe', deals: [] });
  await Promise.all(reads);
});

for (const eventName of ['visibilitychange', 'pagehide', 'pageshow', 'offline', 'doctorcre-session-invalidated']) {
  test(`${eventName} prevents a resumed consumer from joining an obsolete read`, async () => {
    const savedDocument = globalThis.document, savedWindow = globalThis.window;
    const document = new EventTarget(), window = new EventTarget();
    document.visibilityState = 'visible';
    globalThis.document = document; globalThis.window = window;
    try {
      const { calls, fetchImpl } = transport();
      const a = createLiveClient({ fetchImpl }), b = createLiveClient({ fetchImpl });
      const old = assert.rejects(a.morningBrief(), { code: 'read_timeout' });
      const event = new Event(eventName);
      if (eventName === 'pageshow') event.persisted = true;
      if (eventName === 'visibilitychange') { document.visibilityState = 'hidden'; document.dispatchEvent(event); document.visibilityState = 'visible'; }
      else window.dispatchEvent(event);
      await old;
      assert.equal(calls[0].signal.aborted, true);
      const fresh = b.morningBrief();
      assert.equal(calls.length, 2);
      calls[0].finish({ sponsor: 'obsolete' });
      calls[1].finish({ sponsor: 'joe' });
      assert.equal((await fresh).sponsor, 'joe');
    } finally { globalThis.document = savedDocument; globalThis.window = savedWindow; }
  });
}

test('reads after a local mutation cannot join snapshots started before or during that mutation', async () => {
  const calls = [];
  const fetchImpl = async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    return new Promise(resolve => calls.push({ args: JSON.parse(init.body).params, finish: payload => resolve(response(payload)) }));
  };
  const reader = createLiveClient({ fetchImpl, selfActor: 'joe', docContext: false });
  const writer = createLiveClient({ fetchImpl, selfActor: 'joe', docContext: false });
  const before = [reader.getBoard(), reader.morningBrief()];
  const mutation = writer.setNextStep({ deal: 'demo-deal', text: 'Demo next step', expected_actor: 'joe', idempotency_key: '11111111-1111-4111-8111-111111111111' });
  await new Promise(resolve => setImmediate(resolve));
  const during = [reader.getBoard(), reader.morningBrief()];
  calls.find(call => call.args.name === 'set-next-step').finish({ ok: true, event_id: 'demo-event' });
  assert.equal((await mutation).ok, true);
  const after = [reader.getBoard(), reader.morningBrief()];
  const requests = calls.length;
  for (const call of calls.filter(call => call.args.name !== 'set-next-step')) call.finish(call.args.name === 'deal-room-board'
    ? { actor: 'joe', deals: [], observed_at: '2026-10-25T12:00:00Z' }
    : { sponsor: 'joe', observed_at: '2026-10-25T12:00:00Z' });
  await Promise.all([...before, ...during, ...after]);
  assert.equal(requests, 7, 'before, during and after each require their own board and brief reads');
});
