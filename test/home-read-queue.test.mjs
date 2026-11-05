import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeReadQueue, readHomeAgenda, readHomeDashboard } from '../js/home-dashboard-model.js';

const scopes = { agenda: readHomeAgenda, full: readHomeDashboard };
for (const [pending, requested, expected] of [
  [null, 'agenda', 'agenda'], [null, 'full', 'full'],
  ['agenda', 'agenda', 'agenda'], ['agenda', 'full', 'full'],
  ['full', 'agenda', 'full'], ['full', 'full', 'full'],
]) {
  test(`pending ${pending ?? 'default'} plus ${requested} reads ${expected} then resets`, () => {
    const queue = createHomeReadQueue();
    if (pending) queue.request(scopes[pending]);
    queue.request(scopes[requested]);
    assert.equal(queue.take(), scopes[expected]);
    assert.equal(queue.take(), readHomeDashboard, 'consumption restores the default full read');
    queue.request(readHomeAgenda);
    assert.equal(queue.take(), readHomeAgenda, 'consumed full intent does not widen later agenda requests');
  });
}
test('an unrequested read loads the full dashboard', () => {
  assert.equal(createHomeReadQueue().take(), readHomeDashboard);
});
