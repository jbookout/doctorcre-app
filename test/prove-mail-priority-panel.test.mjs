import test from 'node:test';
import assert from 'node:assert/strict';
import { prove } from '../scripts/prove-mail-priority-panel.mjs';
const expectedCommit = '1'.repeat(40);
function setup({ observed = expectedCommit, failing = false, stall = false, late = false } = {}) {
  let pages = 0, sharedClosed = 0;
  const button = { waitFor: async () => {}, click: async () => {}, first() { return this; }, count: async () => 0 };
  const page = { close: async () => { pages--; }, goto: async () => {}, url: () => 'http://localhost/', getByRole: () => ({ ...button, getByRole: () => button }), waitForResponse: async () => ({ ok: () => true, status: () => 200, json: async () => ({ state: 'empty' }) }), waitForFunction: async () => {}, evaluate: async () => { if (stall) return new Promise(() => {}); assert.ok(!failing, 'Synthetic containing release assertion'); return { count: 0 }; } };
  const context = { async newPage() { if (late) await new Promise(resolve => setTimeout(resolve, 60)); pages++; return page; } };
  return { options: { origin: 'http://localhost', expectedCommit, cdpUrl: 'http://localhost:9222', timeoutMs: 500, releaseReader: async () => ({ source_commit: observed }), engine: { connectOverCDP: async () => ({ contexts: () => [context], close: async () => { sharedClosed++; } }) } }, resources: () => ({ pages, sharedClosed }) };
}
for (const mode of ['equal', 'descendant', 'older', 'unrelated', 'unknown']) test(`release containment ${mode}`, async () => {
  const fixture = setup({ observed: mode === 'equal' ? expectedCommit : '2'.repeat(40) });
  fixture.options.ancestry = async () => mode === 'descendant';
  if (['equal', 'descendant'].includes(mode)) assert.equal((await prove(fixture.options)).status, 'passed');
  else await assert.rejects(prove(fixture.options), { exitCode: 78 });
  assert.deepEqual(fixture.resources(), { pages: 0, sharedClosed: ['equal', 'descendant'].includes(mode) ? 1 : 0 });
});
test('containing release assertion failure exits 1, missing session exits 78', async () => {
  const failure = setup({ failing: true });
  await assert.rejects(prove(failure.options), error => (error.exitCode || 1) === 1);
  const missing = setup(); delete missing.options.cdpUrl;
  await assert.rejects(prove(missing.options), { exitCode: 78 });
});
for (const mode of ['late acquisition', 'stalled evaluation']) test(`timeout cleanup ${mode}`, async () => {
  const fixture = setup({ late: mode === 'late acquisition', stall: mode === 'stalled evaluation' });
  await assert.rejects(prove({ ...fixture.options, timeoutMs: 20 }), { exitCode: 78 });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(fixture.resources(), { pages: 0, sharedClosed: 1 });
});
