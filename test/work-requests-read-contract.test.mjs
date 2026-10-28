import { installPollFixtureClock } from './poll-fixture-clock.mjs';
// WR-000548: a malformed successful read is unavailable, never empty or actionable.
// WR-000549: the app's Work Request reference matches CARR's read route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { autoRefreshScript } from './auto-refresh-script.mjs';
import { createRetainedCommands } from '../js/retained-commands.mjs';
import { createSystemWorkClient } from '../js/system-work-client.js';
import { validateHumanRef } from '../js/system-work-view.js';

// Producer contract, copied verbatim from DoctorCRE/carr-system
// 7ba18aa8ef9582efa0eed365d58747242c018802 mcp-server/src/program6-routine-controller.js:
//   { method: "GET", pattern: /^\/api\/system-work\/(WR-[0-9]{1,12})$/, tool: "work-request-card", ... }
const CARR_CARD_ROUTE = /^\/api\/system-work\/(WR-[0-9]{1,12})$/;

const card = { human_ref: 'WR-000123', version: 1, state: 'captured', title: 'Synthetic concern',
  desired_outcome: 'Safe observation', acceptance_criteria: [{ id: 'criterion-1', text: 'Synthetic evidence' }],
  source: { label: 'Synthetic doctrine', freshness: 'current' } };
const item = { human_ref: 'WR-000123', title: 'Synthetic concern', state: 'captured', next_human_action: 'Review' };
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

function client(reply) {
  const paths = [];
  return { paths, client: createSystemWorkClient({ fetchImpl: async path => { paths.push(path); return reply(path); } }) };
}

const malformed = [
  ['malformed JSON', '{"ok":true,"data":'],
  ['a missing ok flag', { data: { items: [] } }],
  ['a missing data object', { ok: true }],
  ['an empty body', ''],
];
const badCollections = [
  ['an explicitly refused collection', { ok: true, data: { ok: false, items: [] } }],
  ['items that are not a list', { ok: true, data: { items: 'none' } }],
  ['a row with an invalid reference', { ok: true, data: { items: [{ ...item, human_ref: 'WR-' }] } }],
  ['a row without a title', { ok: true, data: { items: [{ ...item, title: null }] } }],
];
const badCards = [
  ['an explicitly refused card', { ok: true, data: { ...card, ok: false } }],
  ['a card for another reference', { ok: true, data: { ...card, human_ref: 'WR-000124' } }],
  ['a card without a version', { ok: true, data: { ...card, version: undefined } }],
  ['a card without a state', { ok: true, data: { ...card, state: 7 } }],
];

// WR-000549 acceptance 1 and 2: every reference the producer route serves is accepted and reaches it.
for (const ref of ['WR-1', 'WR-42', 'WR-000548', 'WR-000549', 'WR-123456789012']) {
  test(`WR-000549: ${ref} reaches the CARR read route unchanged`, async () => {
    assert.equal(validateHumanRef(ref), ref);
    const h = client(() => json({ ok: true, data: { ...card, human_ref: ref } }));
    assert.equal((await h.client.read(ref)).human_ref, ref);
    assert.equal(CARR_CARD_ROUTE.exec(h.paths[0])?.[1], ref);
  });
}

test('WR-000549: typed lowercase or padded input normalizes to the route form', async () => {
  assert.equal(validateHumanRef(' wr-1 '), 'WR-1');
  const h = client(() => json({ ok: true, data: { ...card, human_ref: 'WR-000548' } }));
  await h.client.read('wr-000548');
  assert.match(h.paths[0], CARR_CARD_ROUTE);
});

// WR-000549 acceptance 2 and 3: the producer refuses these, and the app explains why before any request.
for (const ref of ['', 'WR-', 'WR-1234567890123', 'WR-12a', 'XR-1', 'WR--1', 'WR 1', 'WR-1/triage']) {
  test(`WR-000549: ${JSON.stringify(ref)} is refused with clear validation and never requested`, async () => {
    assert.equal(CARR_CARD_ROUTE.test(`/api/system-work/${ref.trim().toUpperCase()}`), false, 'producer refuses it too');
    assert.throws(() => validateHumanRef(ref), /Enter a valid Work Request reference such as WR-000123\./);
    const h = client(() => json({ ok: true, data: card }));
    await assert.rejects(h.client.read(ref), /valid Work Request reference/);
    assert.deepEqual(h.paths, []);
  });
}

// WR-000548 acceptance 1, client level: malformed 200s reject as unavailable reads.
for (const [label, body] of [...malformed, ...badCollections]) {
  test(`WR-000548: current read rejects ${label} received with HTTP 200`, async () => {
    const error = await client(() => json(body)).client.current().catch(e => e);
    assert.equal(error?.code, 'malformed_response');
    assert.equal(error.status, undefined, 'never mistaken for a not-found or denied read');
  });
}
for (const [label, body] of [...malformed, ...badCards]) {
  test(`WR-000548: card read rejects ${label} received with HTTP 200`, async () => {
    const error = await client(() => json(body)).client.read('WR-000123').catch(e => e);
    assert.equal(error?.code, 'malformed_response');
  });
}

test('WR-000548: a validated empty collection and a valid card still read', async () => {
  assert.deepEqual(await client(() => json({ ok: true, data: { ok: true, items: [] } })).client.current(), { ok: true, items: [] });
  assert.equal((await client(() => json({ ok: true, data: card })).client.read('WR-000123')).title, card.title);
});

async function page(t, { url = '/work-requests', reply }) {
  const dom = new JSDOM(readFileSync(new URL('../system-work.html', import.meta.url), 'utf8'),
    { url: 'http://localhost' + url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  const clock=installPollFixtureClock(w);
  w.structuredClone = structuredClone;
  w.createRetainedCommands = createRetainedCommands;
  w.fetch = async path => path.endsWith('/session')
    ? json({ actor: { display: 'Synthetic partner' }, csrf_token: 'synthetic' }) : reply(path);
  const files = ['doc-context-model.js', 'doc-context.js', 'uuid.js', 'system-work-view.js', 'system-work-client.js', 'system-work-app.js'];
  w.eval(autoRefreshScript + '\n' + files.map(name => {
    const raw = readFileSync(new URL('../js/' + name, import.meta.url), 'utf8');
    const names = [...raw.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(m => m[1]);
    return '(function(){' + raw.replace(/^import [^\n]*\n/gm, '').replace(/^export /gm, '') + ';Object.assign(window,{' + names.join(',') + '});})();';
  }).join('\n'));
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  await settle();
  const stage = () => d.querySelector('#systemWorkStage');
  return { d, stage, retry: async () => { clock.advance(60_001);stage().querySelector('[data-system-retry]').click(); await settle(); },
    poll: async () => { clock.advance(5_001);w.dispatchEvent(new w.Event('online')); await settle(); } };
}

// WR-000548 acceptance 1 and 3, page level: the real client and page render unavailable with retry.
for (const [label, body] of [...malformed, ...badCollections]) {
  test(`WR-000548 page: ${label} on the queue renders unavailable with retry, not empty`, async t => {
    let next = body;
    const h = await page(t, { reply: () => json(next) });
    assert.match(h.stage().textContent, /Work Requests unavailable/);
    assert.ok(h.stage().querySelector('[data-system-retry]'));
    assert.doesNotMatch(h.stage().textContent, /No eligible Work Requests/);
    assert.equal(h.d.querySelector('#systemWorkAlert').hidden, false);
    next = { ok: true, data: { ok: true, items: [] } };
    await h.retry();
    assert.match(h.stage().textContent, /No eligible Work Requests right now/);
    assert.equal(h.stage().querySelector('[data-system-retry]'), null);
  });
}
for (const [label, body] of [...malformed, ...badCards]) {
  test(`WR-000548 page: ${label} on a card renders unavailable with retry, never an actionable card`, async t => {
    let next = body;
    const h = await page(t, { url: '/work-requests?work_request=WR-000123', reply: () => json(next) });
    assert.match(h.stage().textContent, /Work Requests unavailable/);
    assert.equal(h.stage().querySelector('[data-system-action]'), null);
    assert.equal(h.stage().querySelector('.system-work-card'), null);
    next = { ok: true, data: card };
    await h.retry();
    assert.ok(h.stage().querySelector('[data-system-action="triage"]'));
  });
}
test('WR-000548 page: a malformed refresh demotes a shown card so it is no longer actionable', async t => {
  let next = { ok: true, data: card };
  const h = await page(t, { url: '/work-requests?work_request=WR-000123', reply: () => json(next) });
  assert.ok(h.stage().querySelector('[data-system-action]'));
  next = '<html>gateway</html>';
  await h.poll();
  assert.equal(h.stage().querySelector('[data-system-action]'), null);
  assert.match(h.stage().textContent, /Work Requests unavailable/);
});

// WR-000548 acceptance 2: valid empty, populated, denied and unavailable reads keep their own states.
test('WR-000548 page: valid empty, populated, denied and unavailable reads stay distinct', async t => {
  const empty = await page(t, { reply: () => json({ ok: true, data: { ok: true, items: [] } }) });
  assert.match(empty.stage().textContent, /No eligible Work Requests right now/);
  assert.equal(empty.d.querySelector('#systemWorkAlert').hidden, true);

  const populated = await page(t, { reply: () => json({ ok: true, data: { ok: true, items: [item, { ...item, human_ref: 'WR-1' }] } }) });
  assert.deepEqual([...populated.stage().querySelectorAll('[data-open-work-request]')].map(b => b.dataset.openWorkRequest), ['WR-000123', 'WR-1']);

  const denied = await page(t, { reply: () => json({ error: 'forbidden' }, 403) });
  assert.match(denied.d.querySelector('#systemWorkAlert').textContent, /Sign in again/);
  assert.doesNotMatch(denied.stage().textContent, /No eligible Work Requests/);

  const unavailable = await page(t, { reply: () => json({ error: 'system_work_read_failed' }, 500) });
  assert.match(unavailable.d.querySelector('#systemWorkAlert').textContent, /updates unavailable/);
  assert.ok(unavailable.stage().querySelector('[data-system-retry]'));
});
