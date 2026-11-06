import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
const compiled = await build({ entryPoints: ['src/ui/quiet-vendors.tsx'], bundle: true, write: false, format: 'iife', globalName: 'island', jsx: 'automatic' });
const row = { subject_type: 'vendor', subject_id: 'synthetic', ref: 'V-1', name: 'Synthetic vendor', basis: 'created_at', anchor_on: '2026-01-01', due_on: '2026-02-01', days_overdue: 1 };
const good = () => ({ cadence: { vendor_days: 14 }, proposals: [{ ...row }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
function mount(t, load) {
  const dom = new JSDOM('<div id="host"></div>', { runScripts: 'dangerously', url: 'http://localhost', virtualConsole: new VirtualConsole() });
  dom.window.eval(compiled.outputFiles[0].text + ";globalThis.island = island;");
  const host = dom.window.document.querySelector('#host');
  const island = dom.window.island.mountQuietVendors(host, { load, href: id => `/vendors?record=${id}`, open() {} });
  t.after(() => { island.dispose(); dom.window.close(); });
  const click = async name => { const button = [...host.querySelectorAll('button')].find(el => el.textContent === name); assert.ok(button, name); button.click(); await tick(); };
  return { host, island, click, dom };
}
const malformed = [null, {}, { cadence: { vendor_days: 14 }, proposals: [null] },
  { proposals: [] }, { cadence: null, proposals: [] }, { cadence: { vendor_days: '14' }, proposals: [] },
  ...[0, -1, 1.5, Infinity].map(vendor_days => ({ cadence: { vendor_days }, proposals: [] })),
  ...['subject_type', 'subject_id', 'ref', 'name', 'basis', 'anchor_on', 'due_on', 'days_overdue'].map(key => {
    const broken = { ...row }; delete broken[key]; return { cadence: { vendor_days: 14 }, proposals: [broken] };
  }), { cadence: { vendor_days: 14 }, proposals: [row, null] }];
for (const [index, invalid] of malformed.entries()) test(`malformed snapshot ${index} refuses visibly and recovers`, async t => {
  let next = invalid;
  const { host, click, dom } = mount(t, async () => next);
  await click('Show quiet vendors');
  assert.match(host.querySelector('[role=alert]')?.textContent || '', /unavailable/);
  assert.doesNotMatch(host.textContent, /No quiet vendors/);
  await click('Hide quiet vendors');
  assert.equal(dom.window.document.activeElement.textContent, 'Show quiet vendors');
  await click('Show quiet vendors');
  next = good();
  await click('Refresh quiet vendors');
  assert.equal(host.querySelectorAll('li').length, 1);
  assert.equal(host.querySelector('[role=alert]'), null);
  next = { cadence: { vendor_days: 14 }, proposals: [] };
  await click('Refresh quiet vendors');
  assert.match(host.textContent, /No quiet vendors in this server snapshot/);
});
test('pending reads ignore repeated clicks and late resolution after disposal', async t => {
  let finish, reads = 0;
  const { host, island, click } = mount(t, () => { reads++; return new Promise(resolve => finish = resolve); });
  assert.equal(reads, 0);
  await click('Show quiet vendors');
  await click('Loading quiet vendors…');
  assert.equal(reads, 1);
  await click('Hide quiet vendors');
  await click('Show quiet vendors');
  assert.equal(reads, 1);
  island.dispose();
  finish(good()); await tick();
  assert.equal(host.innerHTML, '');
});

test('a rejected read recovers and valid payloads stay bounded at 1000 proposals', async t => {
  let fail = true;
  let payload = { cadence: { vendor_days: 14 }, proposals: Array.from({ length: 1000 }, () => ({ ...row })) };
  const { host, click } = mount(t, async () => { if (fail) throw Error('synthetic refusal'); return payload; });
  await click('Show quiet vendors');
  assert.ok(host.querySelector('[role=alert]'));
  fail = false;
  await click('Refresh quiet vendors');
  assert.equal(host.querySelectorAll('li').length, 5);
  assert.match(host.textContent, /of 1000 quiet vendors/);
  payload.proposals.push({ ...row });
  await click('Refresh quiet vendors');
  assert.ok(host.querySelector('[role=alert]'));
  assert.equal(host.querySelectorAll('li').length, 0);
});
test('same-turn repeated clicks create one pending load', async t => {
  let reads = 0, finish;
  const { host } = mount(t, () => { reads++; return new Promise(resolve => finish = resolve); });
  const show = host.querySelector('button');
  for (let i = 0; i < 5; i++) show.click();
  await tick();
  assert.equal(reads, 1);
  finish(good()); await tick();
  assert.equal(host.querySelectorAll('li').length, 1);
});

for (const [state, payload] of [
  ['refused', { cadence: { vendor_days: 14 }, proposals: [null] }],
  ['ready', good()],
]) test(`disposal removes the ${state} panel`, async t => {
  const { host, island, click } = mount(t, async () => payload);
  await click('Show quiet vendors');
  if (state === 'refused') assert.match(host.querySelector('[role=alert]')?.textContent || '', /unavailable/);
  else assert.equal(host.querySelectorAll('li').length, 1);
  island.dispose();
  assert.equal(host.innerHTML, '');
});
