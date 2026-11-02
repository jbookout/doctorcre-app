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

test('filed receipts link to their own exact deals without exposing ids or private content', async () => {
  const { container, view } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1), filing(2, { deal: '20000000-0000-4000-8000-000000000002' })] }) });
  await view.refresh();
  assert.deepEqual([...container.querySelectorAll('a')].map(link => [link.getAttribute('href'), link.textContent]), [
    ['/deals?deal=20000000-0000-4000-8000-000000000001', 'Open filed deal'],
    ['/deals?deal=20000000-0000-4000-8000-000000000002', 'Open filed deal'],
  ]);
  assert.doesNotMatch(container.textContent, /20000000|Private body/);
});

test('missing, null and unsafe deal identities never navigate and still allow Undo', async () => {
  for (const deal of [undefined, null, '', 'javascript:alert(1)', '../deal', 'uuid" onclick="alert(1)', {}, '20000000-0000-4000-8000-000000000001?x=y']) {
    const { container, view } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1, { deal })] }) });
    await view.refresh();
    assert.equal(container.querySelector('a'), null);
    assert.match(container.textContent, /Filed deal destination unavailable/);
    assert.ok(container.querySelector('[data-filing-undo]'));
  }
});

test('confirmed Undo removes the current-filing link, retains the receipt and focuses its outcome', async () => {
  const { container, view } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1, { activity_version: null })] }), undoEmailThreadFiling: async () => ({ ok: true }) });
  await view.refresh();
  const button = container.querySelector('button'); button.focus();
  await view.click({ target: button });
  assert.equal(container.querySelector('a'), null);
  assert.equal(container.ownerDocument.activeElement, container.querySelector('[role="status"]'));
  await view.refresh();
  assert.equal(container.querySelector('a'), null, 'a late read cannot restore an undone link');
});

test('refusal retains the exact destination and refresh preserves focused navigation', async () => {
  const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1)] }), undoEmailThreadFiling: async () => { throw Object.assign(Error('refused'), { payload: { error: 'email_thread_filing_changed' } }); } });
  await view.refresh();
  container.querySelector('a').focus();
  await view.refresh();
  assert.equal(container.ownerDocument.activeElement, container.querySelector('a'));
  await undo(0);
  assert.equal(container.querySelector('a').getAttribute('href'), '/deals?deal=20000000-0000-4000-8000-000000000001');
  assert.match(container.textContent, /left as is/);
});

test('session invalidation discards filings and ignores a late read', async () => {
  let resolve;
  const { container, view } = setup({ listEmailThreadFilings: () => new Promise(done => { resolve = done; }) });
  const pending = view.refresh();
  container.ownerDocument.defaultView.dispatchEvent(new container.ownerDocument.defaultView.Event('doctorcre-session-invalidated'));
  resolve({ filings: [filing(1)] }); await pending;
  assert.equal(container.querySelector('a'), null);
  assert.match(container.textContent, /Sign in/);
});

test('lost Undo receipt stays uncertain and replays the original request after a refresh', async () => {
  const calls = [];
  let committed = false;
  const { container, view, undo } = setup({
    listEmailThreadFilings: async () => ({ filings: committed ? [] : [filing(1, { activity_version: null })] }),
    undoEmailThreadFiling: async args => {
      calls.push(structuredClone(args));
      if (!committed) { committed = true; throw Error('Synthetic lost response after commit'); }
      return { ok: true, replayed: true };
    },
  });
  await view.refresh();
  await undo(0);
  assert.match(container.textContent, /could not confirm/i);
  assert.doesNotMatch(container.textContent, /left as is|Undone\./);
  assert.equal(container.querySelector('button').textContent, 'Check outcome');
  await view.refresh();
  assert.match(container.textContent, /could not confirm/i);
  await undo(0);
  assert.deepEqual(calls[1], calls[0]);
  assert.match(container.textContent, /Undone\./);
  assert.equal(container.querySelector('a'), null);
});

for (const failure of [Error('Network failed before commit'), { payload: { error: 'unknown_server_failure' } }, { ok: false }]) {
  test(`unsettled Undo retains its request for ${JSON.stringify(failure)}`, async () => {
    const calls = [];
    const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1), filing(2)] }),
      undoEmailThreadFiling: async args => {
        calls.push(structuredClone(args));
        if (calls.length === 1) { if ('ok' in failure) return failure; throw failure; }
        return { ok: true };
      } });
    await view.refresh();
    await undo(0);
    assert.match(container.textContent, /could not confirm/);
    await undo(0);
    assert.deepEqual(calls[0], calls[1]);
    await undo(0);
    assert.notEqual(calls[2].idempotency_key, calls[0].idempotency_key);
    assert.equal(calls[2].event_id, filing(2).event_id);
  });
}

for (const error of ['email_thread_filing_changed', 'email_thread_filing_not_found']) {
  test(`explicit ${error} settles the request`, async () => {
    const calls = [];
    const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1)] }),
      undoEmailThreadFiling: async args => { calls.push(args); throw { payload: { error } }; } });
    await view.refresh(); await undo(0);
    assert.match(container.textContent, error.endsWith('changed') ? /changed since it was filed/ : /no longer available/);
    assert.doesNotMatch(container.textContent, /could not confirm/);
    await undo(0);
    assert.notEqual(calls[1].idempotency_key, calls[0].idempotency_key);
  });
}

test('pending Undo blocks duplicate clicks and leaves outside focus alone on completion', async () => {
  let finish, calls = 0;
  const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1)] }),
    undoEmailThreadFiling: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  await view.refresh();
  container.querySelector('button').focus();
  const pending = undo(0);
  assert.equal(container.querySelector('button').disabled, true);
  await undo(0);
  assert.equal(calls, 1);
  const outside = container.ownerDocument.createElement('button');
  container.ownerDocument.body.append(outside); outside.focus();
  finish({ ok: true }); await pending;
  assert.equal(container.ownerDocument.activeElement, outside);
});

for (const retire of ['sign-out', 'dispose']) for (const late of ['success', 'failure']) {
  test(`${retire} ignores late Undo ${late}`, async () => {
    let finish, fail;
    const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1)] }),
      undoEmailThreadFiling: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }) });
    await view.refresh();
    const pending = undo(0);
    if (retire === 'dispose') { view.dispose(); container.replaceChildren(); }
    else container.ownerDocument.defaultView.dispatchEvent(new container.ownerDocument.defaultView.Event('doctorcre-session-invalidated'));
    const retired = container.innerHTML;
    if (late === 'success') finish({ ok: true }); else fail(Error('Synthetic late failure'));
    await pending;
    assert.equal(container.innerHTML, retired);
    assert.doesNotMatch(container.textContent, /Demo Sender|Undone/);
    await view.click({ target: container });
  });
}

test('an unanswered Undo becomes uncertain and ignores a receipt arriving after its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const calls = [];
  const { container, view, undo } = setup({ listEmailThreadFilings: async () => ({ filings: [filing(1)] }),
    undoEmailThreadFiling: args => {
      calls.push(structuredClone(args));
      return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true });
    } });
  await view.refresh();
  const pending = undo(0);
  t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(container.textContent, /could not confirm/);
  await pending;
  finish({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(container.textContent, /Undone\./);
  await undo(0);
  assert.deepEqual(calls[1], calls[0]);
  assert.match(container.textContent, /Undone\./);
});
