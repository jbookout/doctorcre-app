import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scenario } from './browser-scenario.mjs';

const NOW = '2026-11-03T16:00:00Z';
const options = { now: NOW, timezone: 'America/Chicago', seed: { notes: [] } };

async function document(s) {
  await s.page.route('**/probe', route => route.fulfill({ contentType: 'text/html', body: '<title>scenario</title>' }));
  await s.open('/probe');
}

test('interleaved scenarios isolate cookies, records, holds and output paths', { timeout: 120_000 }, async t => {
  const seed = { notes: ['original'] };
  const a = await scenario(t, { ...options, seed });
  const b = await scenario(t, { ...options, seed });
  await document(a); await document(b);
  await a.page.context().addCookies([{ name: 'identity', value: 'a', url: a.origin }]);
  assert.deepEqual(await b.page.context().cookies(), []);
  a.records.notes.push('a');
  assert.deepEqual(b.records.notes, ['original']);
  assert.deepEqual(seed.notes, ['original']);
  assert.notEqual(a.outputDir, b.outputDir);
  await access(a.outputDir); await access(b.outputDir);
  await a.page.route('**/record', route => route.fulfill({ json: a.records }));
  await b.page.route('**/record', route => route.fulfill({ json: b.records }));
  const gate = await a.hold(request => new URL(request.url()).pathname === '/record');
  const readA = a.page.evaluate(() => fetch('/record').then(r => r.json()));
  await gate.requested;
  assert.deepEqual(await b.page.evaluate(() => fetch('/record').then(r => r.json())), { notes: ['original'] });
  gate.release(); gate.release();
  assert.deepEqual(await readA, { notes: ['original', 'a'] });
  await a.open('/probe');
  await a.teardown(); await a.teardown();
  assert.equal(a.page.isClosed(), true);
  await assert.rejects(access(a.outputDir));
  assert.equal(await b.page.title(), 'scenario');
});

test('failure cleanup releases all holds including unrequested holds', { timeout: 120_000 }, async () => {
  let cleanup;
  const s = await scenario({ after(fn) { cleanup = fn; } }, options);
  await document(s);
  await s.page.route('**/record', route => route.fulfill({ body: 'released' }));
  const gates = [await s.hold(r => r.url().endsWith('/record')), await s.hold(r => r.url().endsWith('/unused'))];
  const pending = s.page.evaluate(() => fetch('/record')).catch(() => {});
  await gates[0].requested;
  try { throw Error('test assertion fails'); } catch { await cleanup(); }
  gates.forEach(gate => { gate.release(); gate.release(); });
  await pending;
  assert.equal(s.page.isClosed(), true);
  await s.teardown();
  await assert.rejects(s.open('/probe'), /closed/);
});

test('failed navigation cleans resources and teardown stays harmless', async t => {
  const s = await scenario(t, options);
  await s.page.route('**/broken', route => route.abort());
  await assert.rejects(s.open('/broken'));
  assert.equal(s.page.isClosed(), true);
  await s.teardown();
});

for (const [instant, expected] of [
  ['2026-11-04T05:59:59Z', '11/03/2026, 23:59:59'],
  ['2026-11-04T06:00:00Z', '11/04/2026, 00:00:00'],
  ['2026-03-08T07:59:59Z', '03/08/2026, 01:59:59'],
  ['2026-03-08T08:00:00Z', '03/08/2026, 03:00:00'],
  ['2026-11-01T06:59:59Z', '11/01/2026, 01:59:59'],
  ['2026-11-01T07:00:00Z', '11/01/2026, 01:00:00'],
]) test(`explicit scenario time ${instant} formats as ${expected}`, async t => {
  const s = await scenario(t, { ...options, now: instant });
  await document(s);
  assert.equal(await s.page.evaluate(() => Date.now()), s.now.getTime());
  assert.equal(await s.page.evaluate(() => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date())), expected);
});

test('fixed Date leaves real timers running and preserves explicit clock overrides', async t => {
  const s = await scenario(t, options);
  await document(s);
  assert.equal(await s.page.evaluate(() => new Promise(resolve => setTimeout(() => resolve(Date.now()), 20))), Date.parse(NOW));
  await s.page.clock.install({ time: new Date(NOW) });
  await s.page.evaluate(() => { window.timer = new Promise(resolve => setTimeout(() => resolve('fired'), 1000)); });
  await s.page.clock.runFor(1000);
  assert.equal(await s.page.evaluate(() => window.timer), 'fired');
});

test('omitting now keeps the wall clock instead of silently pinning Date', async t => {
  const s = await scenario(t);
  await document(s);
  const before = Date.now();
  const value = await s.page.evaluate(() => Date.now());
  assert.ok(value >= before && value <= Date.now());
});

test('created scenarios can be torn down without opening a document', async t => {
  const s = await scenario(t, options);
  await s.teardown(); await s.teardown();
  assert.equal(s.page.isClosed(), true);
  await assert.rejects(s.hold('**/*'), /closed/);
});

test('startup failure is cleaned and its registered cleanup can repeat', async () => {
  let cleanup;
  await assert.rejects(scenario({ after(fn) { cleanup = fn; } }, { timezone: 'Invalid/Timezone' }));
  await cleanup(); await cleanup();
});

test('expired holds fail cleanup and release a requested response', async () => {
  const s = await scenario({ after() {} }, options);
  await document(s);
  await s.page.route('**/record', route => route.fulfill({ body: 'released' }));
  const gate = await s.hold('**/record', { timeout: 1000 });
  const response = s.page.evaluate(() => fetch('/record').then(r => r.text()));
  await gate.requested;
  assert.equal(await response, 'released');
  await assert.rejects(s.teardown(), AggregateError);
  assert.equal(s.page.isClosed(), true);
});

test('browser launch does not mutate the parent temporary environment', async () => {
  const harness = new URL('./browser-harness.mjs', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import test from 'node:test';
    import { chromium } from ${JSON.stringify(harness)};
    test('temporary environment remains unchanged', async () => {
      const before = [process.env.TMPDIR, process.env.TEMP, process.env.TMP];
      const browser = await chromium.launch();
      try { assert.deepEqual([process.env.TMPDIR, process.env.TEMP, process.env.TMP], before); }
      finally { await browser.close(); }
    });
  `], { timeout: 30_000 });
});
