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
function phaseEvent(id, verb, oldValue, newValue) {
  return { id, recorded_at: timestamp(), actor: 'fixture', field: 'phase', verb,
    old_value: { phase: oldValue }, new_value: { phase: newValue } };
}
function dealReadback(dealId, phase, events, criticalDates = []) {
  return envelope({ deal_id: dealId, phase, events, critical_dates: criticalDates });
}

test('two exact W4 drag presence leases settle with producer receipts and a third refuses', async t => {
  const f = await fixture(t), deal = f.setup.records.deal.id;
  await f.guard.admitBusinessJourneyStep({ phase: 'admit', journey: 'W4', step: 'move', deal, release });
  let dispatched = 0;
  for (const index of [0, 1]) {
    const spec = { journey: 'W4', step: 'move', deal, field: 'phase', release };
    const admitted = await f.guard.admitBusinessJourneyPresence({ ...spec, phase: 'admit' });
    assert.match(admitted.admission_id, /^[0-9a-f-]{36}$/);
    const args = { deal, field: 'phase', idempotency_key: key(70 + index) };
    await f.guard.handle(request('presence-lease', args), async () => {
      dispatched++;
      return envelope({ ok: true, deal_id: deal, field: 'phase',
        expires_at: new Date(Date.now() + 3000).toISOString() });
    });
    const settled = await f.guard.admitBusinessJourneyPresence({ ...spec, phase: 'settle',
      admission_id: admitted.admission_id });
    assert.equal(settled.state, 'settled');
  }
  assert.equal(dispatched, 2);
  assert.deepEqual((await f.read()).browser_presence_leases.map(row => row.state), ['settled', 'settled']);
  await assert.rejects(f.guard.admitBusinessJourneyPresence({ phase: 'admit', journey: 'W4',
    step: 'move', deal, field: 'phase', release }), /presence|journey/);
});

test('W4 presence refuses foreign record, wrong field, missing move, and false producer receipt before dispatch', async t => {
  for (const variant of ['missing-move', 'foreign-record', 'wrong-field', 'wrong-receipt']) {
    const f = await fixture(t), deal = f.setup.records.deal.id, foreign = key(99);
    if (variant !== 'missing-move') await f.guard.admitBusinessJourneyStep({
      phase: 'admit', journey: 'W4', step: 'move', deal, release });
    const spec = { phase: 'admit', journey: 'W4', step: 'move', deal: variant === 'foreign-record' ? foreign : deal,
      field: variant === 'wrong-field' ? 'owner' : 'phase', release };
    if (variant !== 'wrong-receipt') {
      await assert.rejects(f.guard.admitBusinessJourneyPresence(spec), /presence|journey|fixture/);
      assert.equal((await f.read()).browser_presence_leases?.length || 0, 0);
      continue;
    }
    const admitted = await f.guard.admitBusinessJourneyPresence(spec);
    let dispatched = 0;
    await assert.rejects(f.guard.handle(request('presence-lease', { deal, field: 'phase',
      idempotency_key: key(75) }), async () => {
      dispatched++;
      return envelope({ ok: true, deal_id: foreign, field: 'phase',
        expires_at: new Date(Date.now() + 3000).toISOString() });
    }), /unresolved/);
    assert.equal(dispatched, 1);
    assert.equal((await f.read()).browser_presence_leases[0].state, 'unresolved');
    await assert.rejects(f.guard.admitBusinessJourneyPresence({ ...spec, phase: 'settle',
      admission_id: admitted.admission_id }), /presence|journey/);
  }
});

test('W4 presence rejects request substitution and idempotency replay before dispatch', async t => {
  const f = await fixture(t), deal = f.setup.records.deal.id, foreign = key(99);
  await f.guard.admitBusinessJourneyStep({ phase: 'admit', journey: 'W4', step: 'move', deal, release });
  const spec = { journey: 'W4', step: 'move', deal, field: 'phase', release };
  const first = await f.guard.admitBusinessJourneyPresence({ ...spec, phase: 'admit' });
  let dispatched = 0;
  for (const args of [
    { deal: foreign, field: 'phase', idempotency_key: key(80) },
    { deal, field: 'owner', idempotency_key: key(80) },
    { deal, field: 'phase', idempotency_key: key(80), extra: true },
  ]) {
    await assert.rejects(f.guard.handle(request('presence-lease', args), async () => {
      dispatched++;
      return envelope({ ok: true, deal_id: deal, field: 'phase',
        expires_at: new Date(Date.now() + 3000).toISOString() });
    }), /presence-journey-request-unproved/);
  }
  assert.equal(dispatched, 0);
  const accepted = { deal, field: 'phase', idempotency_key: key(80) };
  await f.guard.handle(request('presence-lease', accepted), async () => {
    dispatched++;
    return envelope({ ok: true, deal_id: deal, field: 'phase',
      expires_at: new Date(Date.now() + 3000).toISOString() });
  });
  await f.guard.admitBusinessJourneyPresence({ ...spec, phase: 'settle', admission_id: first.admission_id });
  await f.guard.admitBusinessJourneyPresence({ ...spec, phase: 'admit' });
  await assert.rejects(f.guard.handle(request('presence-lease', accepted), async () => {
    dispatched++;
    return envelope({ ok: true, deal_id: deal, field: 'phase',
      expires_at: new Date(Date.now() + 3000).toISOString() });
  }), /presence-journey-request-unproved/);
  assert.equal(dispatched, 1);
});

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

test('real projected event needs the exact parent deal and immutable phase effect', async t => {
  const f = await fixture(t), dealId = f.setup.records.deal.id, patch = phasePatch(f);
  await f.guard.handle(request('patch-deal-field', patch), async () => envelope(patchReceipt(patch)));
  const read = request('get-deal-room', { deal: dealId });
  const event = phaseEvent(key(31), 'patch-deal-field', 'pending', 'research');
  const invalid = [
    { deal_id: key(90), phase: 'research', events: [event] },
    { deal_id: dealId, phase: 'research', events: [{ ...event, id: key(90) }] },
    { deal_id: dealId, phase: 'research', events: [{ ...event, verb: 'revert-deal-field' }] },
    { deal_id: dealId, phase: 'research', events: [{ ...event, old_value: { phase: 'research' } }] },
    { deal_id: dealId, phase: 'research', events: [event, event] },
  ];
  for (const detail of invalid) {
    await f.guard.handle(read, async () => envelope(detail));
    await assert.rejects(f.guard.assertCoverage(), /write-coverage-incomplete/);
    assert.equal((await f.read()).browser_write_attempts[0].independent_readback, undefined);
  }
  await f.guard.handle(read, async () => dealReadback(dealId, 'research', [event]));
  await f.guard.assertCoverage();
  assert.equal((await f.read()).browser_write_attempts[0].independent_readback?.matched, true);
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
  const date = { id: key(33), kind: 'rent_start', due_on: '2031-12-01', source: args.source, note: null, status: 'open' };
  for (const detail of [
    { deal_id: key(90), critical_dates: [date] },
    { deal_id: dealId, critical_dates: [{ ...date, id: key(90) }] },
    { deal_id: dealId, critical_dates: [{ ...date, kind: 'contract' }] },
    { deal_id: dealId, critical_dates: [{ ...date, due_on: '2031-12-02' }] },
    { deal_id: dealId, critical_dates: [{ ...date, source: 'unrelated' }] },
    { deal_id: dealId, critical_dates: [date, date] },
  ]) {
    await f.guard.handle(read, async () => envelope({ phase: 'pending', events: [], ...detail }));
    await assert.rejects(f.guard.assertCoverage(), /write-coverage-incomplete/);
    assert.equal((await f.read()).browser_write_attempts[0].independent_readback, undefined);
  }
  await f.guard.handle(read, async () => dealReadback(dealId, 'pending', [], [date]));
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
