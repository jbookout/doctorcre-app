import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = await build({ entryPoints: ['src/ui/ideal-client-profile.tsx'], bundle: true, write: false, format: 'iife', globalName: 'HistoricalFit', jsx: 'automatic' });
import { responseFixture } from '../scripts/prove-historical-fit-session-retirement.mjs';
const payload = await responseFixture();
const fixture = () => structuredClone(payload);
async function mounted(t) {
  const dom = new JSDOM('<main></main>', { runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.eval(bundle.outputFiles[0].text + ';window.HistoricalFit = HistoricalFit;');
  const host = dom.window.document.querySelector('main');
  const pending = [], reads = [];
  const mount = dom.window.HistoricalFit.mountIdealClientProfile(host, { getIdealClientProfile(filters) {
    reads.push(filters); return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  } });
  t.after(() => { mount.dispose(); dom.window.close(); });
  const tick = () => new Promise(resolve => dom.window.setTimeout(resolve, 0));
  const event = name => dom.window.dispatchEvent(new dom.window.Event(name));
  const open = async () => { const details = host.querySelector('details'); if (details) { details.open = true; details.dispatchEvent(new dom.window.Event('toggle')); } await tick(); };
  return { dom, host, mount, pending, reads, tick, event, open };
}
for (const state of ['idle', 'loading', 'ready', 'error']) {
  test(`${state} retires permanently and saved controls cannot read`, async t => {
    const p = await mounted(t);
    if (state !== 'idle') await p.open();
    if (state === 'ready') { p.pending[0].resolve(fixture()); await p.tick(); assert.ok(p.host.querySelector('table')); }
    if (state === 'error') { p.pending[0].reject(Error('offline')); await p.tick(); assert.ok(p.host.querySelector('[role=alert]')); }
    const controls = [...p.host.querySelectorAll('button,form,details')];
    p.event('doctorcre-session-invalidated');
    assert.equal(p.host.querySelectorAll('table, input, button, details').length, 0);
    assert.match(p.host.textContent, /Sign in again/);
    const count = p.reads.length;
    p.mount.clear(); p.event('pagehide'); p.event('doctorcre-session-invalidated'); await p.open();
    controls.forEach(el => { el.click(); el.dispatchEvent(new p.dom.window.Event(el.tagName === 'FORM' ? 'submit' : 'toggle', { bubbles: true, cancelable: true })); });
    p.pending.forEach(item => item.resolve(fixture())); await p.tick();
    assert.equal(p.reads.length, count); assert.equal(p.host.querySelectorAll('table').length, 0);
    assert.match(p.host.textContent, /Sign in again/);
  });
  test(`${state} clear and pagehide recover, disposal stays terminal`, async t => {
    const p = await mounted(t);
    if (state !== 'idle') await p.open();
    if (state === 'ready') { p.pending[0].resolve(fixture()); await p.tick(); }
    if (state === 'error') { p.pending[0].reject(Error('offline')); await p.tick(); }
    for (const clear of [() => p.mount.clear(), () => p.event('pagehide')]) {
      clear(); const count = p.reads.length; await p.open(); assert.equal(p.reads.length, count + 1);
    }
    p.mount.clear(); p.event('doctorcre-session-invalidated');
    p.mount.dispose(); p.mount.dispose(); p.mount.clear(); p.event('doctorcre-session-invalidated');
    p.pending.forEach(item => item.reject(Error('late failure'))); await p.tick();
    assert.equal(p.host.textContent, '');
  });
}
test('newer requests win and late success after disposal stays hidden', async t => {
  const p = await mounted(t); await p.open();
  p.host.querySelector('button[type=button]').click();
  p.pending[1].resolve(fixture()); await p.tick(); assert.ok(p.host.querySelector('table'));
  p.pending[0].reject(Error('stale')); await p.tick(); assert.ok(p.host.querySelector('table'));
  p.host.querySelector('button[type=button]').click();
  p.mount.dispose(); p.pending[2].resolve(fixture()); await p.tick(); assert.equal(p.host.textContent, '');
});

for (const state of ['idle', 'loading', 'ready', 'error']) {
  test(`${state} disposes directly without reentry`, async t => {
    const p = await mounted(t);
    if (state !== 'idle') await p.open();
    if (state === 'ready') { p.pending[0].resolve(fixture()); await p.tick(); }
    if (state === 'error') { p.pending[0].reject(Error('offline')); await p.tick(); }
    const reads = p.reads.length;
    p.mount.dispose(); p.mount.clear(); p.event('pagehide'); p.event('doctorcre-session-invalidated');
    p.pending.forEach(item => item.resolve(fixture())); await p.tick(); await p.open();
    assert.equal(p.reads.length, reads); assert.equal(p.host.textContent, '');
  });
}
test('late failure after retirement cannot replace sign-in status', async t => {
  const p = await mounted(t); await p.open(); p.event('doctorcre-session-invalidated');
  p.pending[0].reject(Error('late failure')); await p.tick();
  assert.match(p.host.textContent, /Sign in again/); assert.equal(p.host.querySelectorAll('[role=alert],table').length, 0);
});
test('retired idle details cannot reenter the read path', async t => {
  const p = await mounted(t); p.event('doctorcre-session-invalidated'); await p.open();
  assert.equal(p.reads.length, 0, 'opening details after session retirement must issue zero reads');
});
for (const scenario of ['empty', 'overflow', 'invalid-date', 'duplicate-evidence', 'invalid-coverage']) {
  test(`${scenario} retains historical evidence behavior`, async t => {
    const p = await mounted(t); await p.open(); const payload = fixture();
    if (scenario === 'empty') payload.profiles = [];
    if (scenario === 'invalid-date') payload.profiles[0].evidence[0].closed_on = '2026-02-31';
    if (scenario === 'duplicate-evidence') { payload.profiles[0].won_deals = 2; payload.profiles[0].evidence.push(payload.profiles[0].evidence[0]); }
    if (scenario === 'invalid-coverage') payload.coverage = 'all_deals';
    if (scenario === 'overflow') p.pending[0].reject(Object.assign(Error('limit'), { code: 'client_profile_limit_exceeded' })); else p.pending[0].resolve(payload);
    await p.tick();
    assert.equal(p.host.querySelectorAll('table').length, 0);
    assert.match(p.host.textContent, scenario === 'empty' ? /No completed wins match/ : scenario === 'overflow' ? /Narrow.*filters/ : /Historical client fit unavailable/);
    assert.match(p.host.textContent, /Historical fit, not a prediction or qualification rule/);
  });
}
