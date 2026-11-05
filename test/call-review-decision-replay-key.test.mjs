import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
const bundled = await build({ entryPoints: ['src/ui/call-review.tsx'], bundle: true, write: false, platform: 'node', format: 'esm', external: ['react', 'react-dom', 'react-dom/client'], jsx: 'automatic' });
const path = new URL('../.call-review-replay-test.mjs', import.meta.url);
await writeFile(path, bundled.outputFiles[0].text);
const { mountCallReview } = await import(path.href);
await unlink(path);
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
async function setup(t, resolve, resolver = 'resolve-post-call-candidate', failInitialRead = false) {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const node = document.querySelector('main'), writes = [];
  const rows = [{ session_id: 's', call_date: '2026-10-01', applied: [], open_cards: [{ candidate_id: 'c', resolver, kind: 'assigned_action', payload: { action: 'Synthetic task' } }] }];
  const client = { readCallOutcomes: async () => { if (failInitialRead) { failInitialRead = false; throw new Error('offline'); } return { calls: structuredClone(rows) }; }, resolvePostCallCandidate: async args => { writes.push(args); return resolve(args, rows, writes.length); } };
  client.resolveConfirm = client.resolvePostCallCandidate;
  const view = mountCallReview(node, { sessionId: 's', client: () => client, describe: () => 'Task', undoRefusal: () => '' });
  t.after(() => { view.dispose(); dom.window.close(); });
  const initiallyUnavailable = failInitialRead;
  await view.refresh();
  if (initiallyUnavailable) { assert.match(node.textContent, /Could not check/); await view.refresh(); }
  const click = async name => { const button = [...node.querySelectorAll('button')].find(b => b.textContent === name); assert.ok(button, name); assert.equal(button.disabled, false, name); button.click(); await settle(); };
  await click('Approve or fix this item');
  return { node, rows, writes, view, click, client, dom };
}
for (const resolver of ['resolve-post-call-candidate', 'resolve-candidate']) test(`lost reply retains exact request for explicit check via ${resolver}`, async t => {
  const s = await setup(t, (args, rows, count) => { if (count === 1) throw new Error('lost'); rows[0].open_cards = []; return { ok: true }; }, resolver);
  await s.click('Approve item');
  assert.equal(s.writes.length, 1);
  assert.equal([...s.node.querySelectorAll('button')].find(b => b.textContent === 'Skip item').disabled, true);
  await s.click('Check outcome');
  assert.deepEqual(s.writes[1], s.writes[0]);
  assert.match(s.node.textContent, /No longer pending/);
});
test('lost response after commit reconciles without replay', async t => {
  const s = await setup(t, (args, rows) => { rows[0].open_cards = []; throw new Error('lost'); });
  await s.click('Approve item');
  assert.match(s.node.textContent, /No longer pending/); assert.equal(s.writes.length, 1);
});
test('changed candidate refuses replay until authoritative resolution', async t => {
  const s = await setup(t, () => { throw new Error('offline'); });
  await s.click('Approve item'); s.rows[0].open_cards[0].payload.action = 'Changed';
  await s.click('Check outcome'); assert.equal(s.writes.length, 1);
  assert.match(s.node.textContent, /changed/);
  s.rows[0].open_cards = []; await s.view.refresh(); assert.match(s.node.textContent, /No longer pending/);
});
test('definitive refusal permits a fresh decision but missing receipt stays unknown', async t => {
  const s = await setup(t, () => ({ ok: false })); await s.click('Approve item');
  assert.equal([...s.node.querySelectorAll('button')].find(b => b.textContent === 'Skip item').disabled, false);
  s.client.resolvePostCallCandidate = async args => { s.writes.push(args); return {}; };
  await s.click('Skip item'); assert.match(s.node.textContent, /outcome.*unknown/i);
});
test('authentication failure retires controls', async t => {
  const s = await setup(t, () => { throw { status: 401 }; }); await s.click('Approve item');
  assert.match(s.node.textContent, /Sign in again/); assert.equal(s.node.querySelector('.call-review-decision'), null);
});
test('late completion after invalidation cannot restore controls', async t => {
  let finish; const s = await setup(t, () => new Promise(resolve => { finish = resolve; }));
  await s.click('Approve item'); s.dom.window.dispatchEvent(new s.dom.window.Event('doctorcre-session-invalidated'));
  finish({ ok: true }); await settle(); assert.match(s.node.textContent, /Sign in again/);
});
test('late completion after disposal stays empty', async t => {
  let finish; const s = await setup(t, () => new Promise(resolve => { finish = resolve; }));
  await s.click('Approve item'); s.view.dispose(); finish({ ok: true }); await settle();
  assert.equal(s.node.innerHTML, ''); assert.equal(s.node.hidden, true);
});
test('failed authoritative read never replays and refresh restores recovery', async t => {
  const s = await setup(t, () => { throw new Error('lost'); }); await s.click('Skip item');
  s.client.readCallOutcomes = async () => { throw new Error('offline'); };
  await s.click('Check outcome'); assert.equal(s.writes.length, 1); assert.match(s.node.textContent, /Could not check/);
  s.client.readCallOutcomes = async () => ({ calls: structuredClone(s.rows) }); await s.view.refresh();
  assert.equal([...s.node.querySelectorAll('button')].find(b => b.textContent === 'Check outcome').disabled, false);
  s.client.resolvePostCallCandidate = async args => { s.writes.push(args); s.rows[0].open_cards = []; return { ok: true }; };
  await s.click('Check outcome'); assert.deepEqual(s.writes[1], s.writes[0]); assert.equal(s.writes[1].accept, false);
});
test('authorization failure during recovery permanently retires the guide', async t => {
  const s = await setup(t, () => { throw new Error('lost'); }); await s.click('Approve item');
  s.client.readCallOutcomes = async () => { throw { status: 403 }; };
  await s.click('Check outcome'); assert.match(s.node.textContent, /Sign in again/); assert.equal(s.writes.length, 1);
  s.client.readCallOutcomes = async () => ({ calls: s.rows }); await s.view.refresh(); assert.match(s.node.textContent, /Sign in again/);
});
test('initial unavailable read recovers and ready disposal clears controls', async t => {
  const s = await setup(t, () => ({ ok: true }), 'resolve-post-call-candidate', true);
  s.client.readCallOutcomes = async () => { throw new Error('offline'); };
  await s.view.refresh(); assert.match(s.node.textContent, /Could not check/);
  s.client.readCallOutcomes = async () => ({ calls: s.rows }); await s.view.refresh();
  assert.match(s.node.textContent, /Needs your decision/); s.view.dispose(); assert.equal(s.node.innerHTML, '');
});
test('ready authorization failure and recovery disposal retire controls', async t => {
  const s = await setup(t, () => ({ ok: true }));
  s.client.readCallOutcomes = async () => { throw { status: 401 }; };
  await s.view.refresh(); assert.match(s.node.textContent, /Sign in again/);
});
test('recovery disposal removes the held request', async t => {
  const s = await setup(t, () => { throw new Error('offline'); }); await s.click('Approve item');
  s.view.dispose(); await s.view.refresh(); assert.equal(s.node.innerHTML, ''); assert.equal(s.writes.length, 1);
});
