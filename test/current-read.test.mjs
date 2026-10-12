import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurrentRead } from '../js/current-read.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('a newer read cancels the old transport and suppresses its late success', async () => {
  const reads = createCurrentRead();
  const old = deferred();
  const applied = [];
  let signal;
  const pending = reads.run(scope => { signal = scope.signal; return old.promise; }, { success: value => applied.push(value) });
  await reads.run(() => 'current', { success: value => applied.push(value) });
  assert.equal(signal.aborted, true);
  old.resolve('obsolete');
  await pending;
  assert.deepEqual(applied, ['current']);
  reads.dispose();
});

test('a late failure cannot erase a newer accepted answer', async () => {
  const reads = createCurrentRead();
  const old = deferred();
  let shown;
  const pending = reads.run(() => old.promise, { success: value => { shown = value; }, failure: () => { shown = 'error'; } });
  await reads.run(() => 'current', { success: value => { shown = value; } });
  old.reject(Error('obsolete failure'));
  await pending;
  assert.equal(shown, 'current');
});

test('invalidation stops a multi-leg read before it can request obsolete context', async () => {
  const reads = createCurrentRead();
  const first = deferred();
  let contextReads = 0, applied = 0;
  const pending = reads.run(async scope => {
    await scope.read(first.promise);
    contextReads++;
    return scope.read(Promise.resolve('context'));
  }, { success: () => applied++ });
  reads.invalidate();
  first.resolve('obsolete result');
  await pending;
  await Promise.resolve();
  assert.equal(contextReads, 0);
  assert.equal(applied, 0);
});

test('a deadline rejects the current read, fences late answers, and permits recovery', async () => {
  let expire;
  const reads = createCurrentRead({ clock: { setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {} } });
  const old = deferred();
  const shown = [];
  const pending = reads.run(() => old.promise, { success: value => shown.push(value), failure: error => shown.push(error.code) });
  expire();
  await pending;
  await reads.run(() => 'recovered', { success: value => shown.push(value) });
  old.resolve('late');
  await Promise.resolve();
  assert.deepEqual(shown, ['read_timeout', 'recovered']);
});

test('external cancellation and disposal settle a hanging read without any callbacks', async () => {
  for (const dispose of [false, true]) {
    const reads = createCurrentRead();
    const controller = new AbortController();
    let callbacks = 0;
    const pending = reads.run(() => new Promise(() => {}), { signal: controller.signal, success: () => callbacks++, failure: () => callbacks++ });
    if (dispose) reads.dispose(); else controller.abort();
    await pending;
    if (dispose) await reads.run(() => 'late new read', { success: () => callbacks++ });
    assert.equal(callbacks, 0);
  }
});
