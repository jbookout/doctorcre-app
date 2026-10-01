import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAutoRefresh, updatedLabel } from '../js/auto-refresh.mjs';
import { readFile } from 'node:fs/promises';

function clock() {
  const document = new EventTarget(); document.visibilityState = 'visible';
  const window = new EventTarget(); let pending = new Map(), next = 0;
  window.setTimeout = fn => { pending.set(++next, fn); return next; };
  window.clearTimeout = id => pending.delete(id);
  return { document, window, tick() { const jobs = [...pending.values()]; pending.clear(); jobs.forEach(fn => fn()); }, get count() { return pending.size; }, hide() { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }, show() { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); } };
}
const settle = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };

test('background refresh recovers after failure, does not overlap, sleeps hidden and disposes', async () => {
  const c = clock(); let reads = 0, release;
  const refresh = mountAutoRefresh({ ...c, refresh: () => { reads++; if (reads === 1) throw Error('synthetic outage'); return new Promise(resolve => { release = resolve; }); } });
  assert.equal(reads, 0); assert.equal(c.count, 1);
  c.tick(); await settle(); assert.equal(reads, 1); assert.equal(c.count, 1);
  c.tick(); await settle(); assert.equal(reads, 2);
  const same = refresh.refresh(); c.window.dispatchEvent(new Event('online')); await settle(); assert.equal(reads, 2);
  release(); await same; await settle(); assert.equal(c.count, 1);
  c.hide(); assert.equal(c.count, 0); c.tick(); assert.equal(reads, 2);
  c.show(); await settle(); assert.equal(reads, 3); release(); await settle();
  refresh.dispose(); assert.equal(c.count, 0); c.window.dispatchEvent(new Event('online')); c.hide(); c.show(); await settle(); assert.equal(reads, 3);
});
test('read eligibility preserves a draft while polling resumes after the draft closes', async () => {
  const c = clock(); let draft = true, reads = 0;
  const handle = mountAutoRefresh({ ...c, shouldRefresh: () => !draft, refresh: () => { reads++; } });
  c.tick(); await settle(); assert.equal(reads, 0); assert.equal(c.count, 1);
  draft = false; c.tick(); await settle(); assert.equal(reads, 1); handle.dispose();
});
test('update timestamps use a human clock and missing clocks never look current', () => {
  assert.match(updatedLabel('2026-10-01T15:00:00Z'), /^Updated \d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(updatedLabel(undefined), 'Updating…');
  assert.equal(updatedLabel(null), 'Updating…');
  assert.equal(updatedLabel('invalid'), 'Updating…');
});
test('every data surface mounts background refresh or the existing board coordinator', async () => {
  for (const name of ['workspace-command-center','workspace-business','leads-app','calendar','ideas','control-room','atlas','notifications','incidents','conversations','task-records','work-inventory','system-work-app','model-room','sessions','business-workspace','charts','search','status']) {
    assert.match(await readFile(new URL(`../js/${name}.js`, import.meta.url), 'utf8'), /mountAutoRefresh\(/, name);
  }
  assert.match(await readFile(new URL('../tours/app.js', import.meta.url), 'utf8'), /mountAutoRefresh\(/);
  assert.match(await readFile(new URL('../js/app.js', import.meta.url), 'utf8'), /refreshBoard/);
});
