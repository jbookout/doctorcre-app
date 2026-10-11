import test from 'node:test';
import assert from 'node:assert/strict';
import { runCalendarCase } from '../../scripts/e2e-staging/calendar-coverage.mjs';
import { ControlSkip } from '../../scripts/e2e-staging/controls.mjs';

test('functional Calendar cases admit their declared action before pressing and retain zero-execution skips', async () => {
  let presses = 0, admissions = 0;
  const context = { status: 'ready', failed: 0, state: { view: 'month', anchor: '2026-01-31' }, today: '2026-01-31', sequence: 1, entries: [] };
  const control = { selector: '#calNext', identity: 'synthetic-calendar-next', name: 'Next', role: 'button', disabled: false };
  const page = { url: () => 'https://staging.invalid/calendar?view=month&d=2026-01-31',
    context: () => ({ close: async () => {} }),
    evaluate: async fn => fn.toString().includes("['ready'") ? true : context,
    locator: () => ({ click: async () => { presses++; },
      evaluateAll: async (_fn, arg) => Array.isArray(arg) ? arg : { rows: [control], busy: false } }),
  };
  const result = await runCalendarCase({ spec: { id: 'operation-month-next-nonleap', owner: '/calendar', kind: 'calendar-operation', case: 'month-next-nonleap' },
    freshPage: async () => page, admit: async () => { admissions++; throw new ControlSkip('control-scope-unproved'); } });
  assert.equal(admissions, 1);
  assert.equal(presses, 0);
  assert.equal(result.status, 'SKIPPED');
  assert.deepEqual(result.execution, { press_attempted: false, handler_executions: 0 });
  assert.deepEqual(result.steps, []);
});
