import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStagingRecords, stagingFixtureWriteGuard } from '../../scripts/e2e-staging/records.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import { fakeAPI, release, envelope } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';

beforeEach(admitFixtureRun);
const activeRuns = new Set();
const roots = [];
afterEach(async () => {
  for (const run of activeRuns) run.dispose();
  activeRuns.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const key = number => `51000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const timestamp = () => new Date().toISOString();
const request = (name, args) => ({
  method: () => 'POST',
  url: () => `${STAGING_ORIGIN}/mcp`,
  postDataJSON: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
});
async function fixture(t) {
  const output = await mkdtemp(join(tmpdir(), 'business-fixture-writes-'));
  roots.push(output);
  const run = openRun(output, { runId: `business-fixture-${roots.length}`, events: null });
  activeRuns.add(run);
  const api = fakeAPI(output);
  const setup = await prepareStagingRecords(output, { ...api, run });
  const path = join(output, 'staging-records-plan.json');
  const read = async () => JSON.parse(await readFile(path, 'utf8'));
  return { output, setup, read, guard: stagingFixtureWriteGuard({ output, release, run }) };
}
function phasePatch(f, overrides = {}) {
  return { deal: f.setup.records.deal.id, field: 'phase', value: 'research', base_event_id: null,
    idempotency_key: key(1), ...overrides };
}
function patchReceipt(args, eventId = key(31)) {
  return { ok: true, deal_id: args.deal, field: 'phase', old_value: 'pending', new_value: args.value,
    event_id: eventId, event_recorded_at: timestamp() };
}
function phaseEvent(id, verb, oldValue, newValue, dealId) {
  return { id, subject_id: dealId, subject_type: 'deal', field: 'phase', verb,
    old_value: { phase: oldValue }, new_value: { phase: newValue } };
}
function dealReadback(dealId, phase, events, criticalDates = []) {
  return envelope({ deal_id: dealId, phase, events, critical_dates: criticalDates });
}

test('phase change and undo require pinned producer receipts plus independent final deal-room state', async t => {
  const f = await fixture(t), dealId = f.setup.records.deal.id, patch = phasePatch(f);
  let dispatches = 0;
  await f.guard.handle(request('patch-deal-field', patch), async () => {
    dispatches++;
    return envelope(patchReceipt(patch));
  });

  const initialEvent = phaseEvent(key(31), 'patch-deal-field', 'pending', 'research', dealId);
  const initialRead = request('get-deal-room', { deal: dealId });
  const undo = { event_id: key(31), idempotency_key: key(2) };
  await f.guard.handle(request('revert-deal-field', undo), async () => {
    dispatches++;
    return envelope({ ok: true, deal_id: dealId, field: 'phase', reverted_event_id: key(31),
      old_value: 'research', new_value: 'pending', event_id: key(32), event_recorded_at: timestamp() });
  });
  const undoEvent = phaseEvent(key(32), 'revert-deal-field', 'research', 'pending', dealId);
  await f.guard.handle(initialRead, async () => { dispatches++; return dealReadback(dealId, 'pending', [undoEvent, initialEvent]); });
  await f.guard.assertCoverage();
  const plan = await f.read();
  assert.equal(dispatches, 3);
  assert.deepEqual(plan.browser_write_attempts.map(row => row.operation), ['patch-deal-field', 'revert-deal-field']);
  assert.ok(plan.browser_write_attempts.every(row => row.independent_readback?.matched === true));
});

test('contract-date write is scoped to the synthetic rent-start row and needs independent deal-room readback', async t => {
  const f = await fixture(t), dealId = f.setup.records.deal.id;
  const args = { deal: dealId, kind: 'rent_start', due_on: '2031-12-01', source: 'Synthetic fixture evidence',
    idempotency_key: key(3) };
  await f.guard.handle(request('add-critical-date', args), async () =>
    envelope({ ok: true, critical_date_id: key(33) }));
  await assert.rejects(f.guard.assertCoverage(), /write-coverage-incomplete/);

  const read = request('get-deal-room', { deal: dealId });
  await f.guard.handle(read, async () => dealReadback(dealId, 'pending', []));
  await assert.rejects(f.guard.assertCoverage(), /write-coverage-incomplete/);
  await f.guard.handle(read, async () => dealReadback(dealId, 'pending', [], [
    { id: key(33), deal_id: dealId, kind: 'rent_start', due_on: '2031-12-01', source: args.source, note: null, status: 'open' },
  ]));
  await f.guard.assertCoverage();
  assert.equal((await f.read()).browser_write_attempts[0].independent_readback.operation, 'get-deal-room');
});

test('unsupported, nonfixture, malformed, and unverified writes fail closed before dispatch or coverage', async t => {
  const f = await fixture(t), dealId = f.setup.records.deal.id;
  let dispatches = 0, dispatchedName = null;
  const outside = key(90);
  const dateArgs = { deal: dealId, kind: 'rent_start', due_on: '2031-12-01', source: 'Synthetic fixture evidence', idempotency_key: key(4) };
  const invalid = [
    request('patch-deal-field', phasePatch(f, { deal: outside })),
    request('patch-deal-field', phasePatch(f, { deal: f.setup.records.invoice.deal_id })),
    request('patch-deal-field', phasePatch(f, { value: 'closed' })),
    request('patch-deal-field', phasePatch(f, { field: 'owner' })),
    request('revert-deal-field', { event_id: key(91), idempotency_key: key(5) }),
    request('add-critical-date', { ...dateArgs, deal: outside }),
    request('add-critical-date', { ...dateArgs, deal: f.setup.records.invoice.deal_id }),
    request('add-critical-date', { ...dateArgs, kind: 'other' }),
    request('record-commission-receipt', { commission_id: outside, idempotency_key: key(6) }),
  ];
  for (const call of invalid)
    await assert.rejects(f.guard.handle(call, () => {
      dispatches++;
      const { name, arguments: args } = call.postDataJSON().params;
      dispatchedName = `${name}/${args.field ?? ''}/${args.value ?? ''}/${args.deal ?? ''}`;
    }), /Staging fixture write refused/);
  assert.equal(dispatches, 0, dispatchedName);
  assert.equal((await f.read()).browser_write_attempts, undefined);

  const patch = phasePatch(f, { idempotency_key: key(7) });
  await assert.rejects(f.guard.handle(request('patch-deal-field', patch), async () => {
    dispatches++;
    return envelope({ ok: true, deal_id: dealId, field: 'phase', old_value: 'pending', new_value: 'research',
      event_id: 'not-an-event-id', event_recorded_at: timestamp() });
  }), /dispatch-outcome-unresolved/);
  await assert.rejects(f.guard.assertCoverage(), /write-coverage-incomplete/);
  await assert.rejects(f.guard.handle(request('patch-deal-field', phasePatch(f, { value: 'legal', idempotency_key: key(8) })),
    () => { dispatches++; }), /Staging fixture write refused/);
  assert.equal(dispatches, 1);
});
