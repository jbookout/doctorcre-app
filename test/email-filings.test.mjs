import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountEmailFilings } from '../js/email-filings.js';
import { createLiveClient } from '../js/live-client.js';
import { carrInterface } from "./carr-contract.mjs";

const filing = (n, extra = {}) => ({ event_id: `40000000-0000-4000-8000-00000000000${n}`, deal: '20000000-0000-4000-8000-000000000001',
  activity_id: `30000000-0000-4000-8000-00000000000${n}`, recorded_at: '2026-10-27T15:00:00Z', summary: `Private body text ${n}`,
  subject: `Demo lease terms ${n}`, sender_name: `Demo Sender ${n}`, occurred_at: '2026-10-27T14:00:00Z', activity_version: 4, ...extra });
function setup(client) {
  const dom = new JSDOM('<section id="filings"></section>');
  const container = dom.window.document.querySelector('section');
  const view = mountEmailFilings({ container, client });
  return { container, view, undo: n => view.click({ target: container.querySelectorAll('button')[n] }) };
}

test('each automatic filing shows its subject and sender name with Undo, never the body or addresses', async () => {
  const { container, view } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1), filing(2, { summary: 'a@example.test' })] }) });
  await view.refresh();
  assert.match(container.textContent, /Demo lease terms 1/);
  assert.match(container.textContent, /Demo Sender 2/);
  assert.equal(container.querySelectorAll('button').length, 2);
  assert.doesNotMatch(container.innerHTML, /Private body|example\.test|30000000-0000/);
});

test('legacy filings with a null activity_version and missing source fields still show and undo', async () => {
  const calls = [];
  const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1, { activity_version: null, subject: null, sender_name: null })] }),
    undoEmailThreadFiling: async args => { calls.push(args); return { ok: true, activity_id: filing(1).activity_id }; } });
  await view.refresh();
  assert.match(container.textContent, /Subject unavailable/);
  assert.match(container.textContent, /Sender unavailable/);
  await undo(0);
  assert.equal(calls.length, 1);
});

test('Undo sends only the event id and a fresh UUID key, then says what changed in place', async () => {
  const calls = [];
  const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1), filing(2)] }),
    undoEmailThreadFiling: async args => { calls.push(args); return { ok: true, activity_id: filing(1).activity_id }; } });
  await view.refresh();
  await undo(0);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['event_id', 'idempotency_key']);
  assert.equal(calls[0].event_id, filing(1).event_id);
  assert.match(calls[0].idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const items = container.querySelectorAll('[data-filing-id]');
  assert.equal(items.length, 2, 'the item keeps its place');
  assert.match(items[0].textContent, /Undone\. The email is no longer filed to this deal and will not be filed automatically again\./);
  assert.equal(items[0].querySelector('button'), null);
  assert.ok(items[1].querySelector('button'));
});

test('a refused Undo leaves the filing in place with the reason', async () => {
  const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1)] }),
    undoEmailThreadFiling: async () => { throw Object.assign(Error('refused'), { payload: { error: 'email_thread_filing_changed' } }); } });
  await view.refresh();
  await undo(0);
  assert.match(container.textContent, /changed since it was filed/);
  assert.equal(container.querySelectorAll('button').length, 1);
});

test('live client forwards the exact read and undo arguments, and the contract pins the producer fields', async () => {
  const calls = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const rpc = JSON.parse(init.body); calls.push(rpc.params);
    return Response.json({ result: { content: [{ text: JSON.stringify({ filings: [], ok: true }) }] } });
  } });
  await live.listEmailThreadFilings();
  await live.undoEmailThreadFiling({ event_id: filing(1).event_id, idempotency_key: 'k' });
  assert.deepEqual(calls, [{ name: 'list-email-thread-filings', arguments: {} }, { name: 'undo-email-thread-filing', arguments: { event_id: filing(1).event_id, idempotency_key: 'k' } }]);
  const contract = carrInterface;
  assert.ok(contract.mcp_operations.includes('list-email-thread-filings') && contract.mcp_operations.includes('undo-email-thread-filing'));
  assert.deepEqual(Object.keys(contract.email_thread_filings.read_fields), ['event_id', 'deal', 'activity_id', 'recorded_at', 'summary', 'subject', 'sender_name', 'occurred_at', 'activity_version']);
});


test('a background filing read failure preserves focus outside its panel', async () => {
  let reject;
  const response = new Promise((_, fail) => { reject = fail; });
  const { container, view } = setup({ listEmailThreadFilings: () => response });
  const document = container.ownerDocument;
  const trigger = document.createElement('button');
  trigger.textContent = 'Suggested introduction';
  document.body.append(trigger);
  trigger.focus();
  const refresh = view.refresh();
  reject(Error('Synthetic read unavailable'));
  await refresh;
  assert.match(container.textContent, /Could not load filed emails/);
  assert.equal(document.activeElement, trigger);
});

test('a failed retry returns focus to the new Retry button', async () => {
  const { container, view } = setup({ listEmailThreadFilings: async () => { throw Error('Synthetic read unavailable'); } });
  await view.refresh();
  const retry = container.querySelector('[data-filing-retry]');
  retry.focus();
  await view.click({ target: retry });
  assert.equal(container.ownerDocument.activeElement, container.querySelector('[data-filing-retry]'));
});

test('a failed retry does not reclaim focus moved elsewhere while pending', async () => {
  let reject;
  let calls = 0;
  const { container, view } = setup({ listEmailThreadFilings: () => {
    if (++calls === 1) return Promise.reject(Error('Synthetic read unavailable'));
    return new Promise((_, fail) => { reject = fail; });
  } });
  await view.refresh();
  const retry = container.querySelector('[data-filing-retry]');
  retry.focus();
  const pending = view.click({ target: retry });
  const outside = container.ownerDocument.createElement('button');
  container.ownerDocument.body.append(outside);
  outside.focus();
  reject(Error('Synthetic read unavailable'));
  await pending;
  assert.equal(container.ownerDocument.activeElement, outside);
});

test('a failed refresh preserves focus on a filing control within its panel', async () => {
  let fail = false;
  const { container, view } = setup({ listEmailThreadFilings: async () => {
    if (fail) throw Error('Synthetic read unavailable');
    return { filings: [filing(1)] };
  } });
  await view.refresh();
  container.querySelector('[data-filing-undo]').focus();
  fail = true;
  await view.refresh();
  assert.equal(container.ownerDocument.activeElement, container.querySelector('[data-filing-undo]'));
});
