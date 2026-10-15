import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStagingRecords, stagingFixtureWriteGuard, assertStagingWriteCoverage } from '../../scripts/e2e-staging/records.mjs';
import { LOCAL_AGENT_PHASE_REASON } from '../../scripts/e2e-staging/local-agent-phase.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
import { fakeAPI, release } from './record-fixture.mjs';

const response = (id, value) => ({ status: () => 200, headers: () => ({ 'content-type': 'application/json' }),
  json: async () => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }) });
const request = (name, args, id = 1) => ({ method: () => 'POST', url: () => STAGING_ORIGIN + '/mcp',
  postDataJSON: () => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
const event = (id, verb, oldPhase, newPhase, actor = 'joe') => ({ id, recorded_at: new Date().toISOString(), actor,
  verb, field: 'phase', old_value: { phase: oldPhase }, new_value: { phase: newPhase } });

async function fixture(t) {
  admitFixtureRun(t);
  const output = await mkdtemp(join(tmpdir(), 'w4-automatic-undo-'));
  const run = openRun(output, { runId: 'synthetic-automatic-undo', events: null });
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  const setup = await prepareStagingRecords(output, { ...fakeAPI(output), run });
  const deal = setup.records.deal.id, planPath = join(output, 'staging-records-plan.json');
  const plan = () => readFile(planPath, 'utf8').then(JSON.parse);
  const detail = { deal_id: deal, phase: 'pending', events: [], phase_change: null };
  let reads, readCount = 0;
  const guard = stagingFixtureWriteGuard({ output, release, run,
    normalReads: async (_run, _release, _deal, since) => {
      assert.equal(_run, run); assert.deepEqual(_release, release); assert.equal(_deal, deal);
      assert.equal(since, (await journal()).receipt.event_recorded_at);
      readCount++;
      return structuredClone(reads);
    } });
  const journalPath = join(output, 'private', 'w4-local-agent-phase.json');
  const journal = () => readFile(journalPath, 'utf8').then(JSON.parse);
  const putJournal = async value => {
    await mkdir(join(output, 'private'), { recursive: true, mode: 0o700 });
    await writeFile(journalPath, JSON.stringify(value), { mode: 0o600 });
  };
  const send = async (name, args, value, { fail = false } = {}) => guard.handle(request(name, args), async () => {
    const pending = (await plan()).browser_write_attempts.find(row => row.arguments.idempotency_key === args.idempotency_key);
    assert.equal(pending.state, 'inflight', 'durable intent precedes browser forwarding');
    if (fail) throw new Error('synthetic response lost after dispatch');
    return response(1, value);
  });
  const readDetail = async () => guard.handle(request('get-deal-room', { deal }), async () => response(1, structuredClone(detail)));
  const write = async (step, args, receipt) => {
    await send(step === 'move' ? 'patch-deal-field' : 'revert-deal-field', args, receipt);
    const change = event(receipt.event_id, step === 'move' ? 'patch-deal-field' : 'revert-deal-field', receipt.old_value, receipt.new_value);
    detail.phase = receipt.new_value; detail.phase_change = { event_id: receipt.event_id };
    detail.events.push(change);
    await readDetail();
    await guard.admitBusinessJourneyStep({ phase: 'observe', journey: 'W4', step, deal, release,
      observation: step === 'move' ? { phase: receipt.new_value, event_id: receipt.event_id }
        : { phase: receipt.new_value, reverted_event_id: receipt.reverted_event_id, badge: 'Undone' } });
  };
  const move = await guard.admitBusinessJourneyStep({ phase: 'admit', journey: 'W4', step: 'move', deal, release });
  const moveId = randomUUID();
  await write('move', { ...move.argument_template, idempotency_key: randomUUID() }, {
    ok: true, deal_id: deal, field: 'phase', old_value: 'pending', new_value: 'research',
    event_id: moveId, event_recorded_at: new Date().toISOString() });
  const undo = await guard.admitBusinessJourneyStep({ phase: 'admit', journey: 'W4', step: 'undo', deal, release });
  await write('undo', { ...undo.argument_template, idempotency_key: randomUUID() }, {
    ok: true, deal_id: deal, field: 'phase', old_value: 'research', new_value: 'pending',
    reverted_event_id: moveId, event_id: randomUUID(), event_recorded_at: new Date().toISOString() });
  const privatePlan = await plan();
  const agentEvent = event(randomUUID(), 'patch-deal-field', 'pending', 'research', 'joe-local');
  const agentJournal = { schema: 'staging-w4-local-agent-phase.v1', state: 'observed',
    source_pair: privatePlan.release, run_id: run.snapshot().id, fixture_run: privatePlan.run, deal_id: deal,
    request: { idempotency_key: randomUUID(), deal, field: 'phase', value: 'research', base_event_id: null,
      change_reason: LOCAL_AGENT_PHASE_REASON },
    before_sha256: 'a'.repeat(64), receipt: { ok: true, deal_id: deal, field: 'phase',
      old_value: 'pending', new_value: 'research', event_id: agentEvent.id,
      event_recorded_at: agentEvent.recorded_at }, board_sha256: 'b'.repeat(64),
    detail_sha256: 'c'.repeat(64), cause_sha256: 'd'.repeat(64),
    started_at: new Date().toISOString(), observed_at: new Date().toISOString(),
    doc_authorship_qualified: false };
  await putJournal(agentJournal);
  detail.phase = 'research'; detail.phase_change = { event_id: agentEvent.id, automatic: true };
  detail.events.push(agentEvent);
  const boardRow = { id: deal, name: privatePlan.records.deal.name, owner: 'joe',
    client_ref: privatePlan.records.client.ref, phase: 'research', phase_change: {
      automatic: true, event_id: agentEvent.id, prior_phase: 'pending', phase: 'research',
      reason: LOCAL_AGENT_PHASE_REASON, evidence_date: agentEvent.recorded_at } };
  const activity = { schema_version: 'doc-activity.v1', entries: [{ id: agentEvent.id,
    actor: 'Joe (local)', partner: 'joe', record: { id: deal }, why: LOCAL_AGENT_PHASE_REASON,
    before: 'pending', after: 'research', undo: { state: 'available', event_id: agentEvent.id } }] };
  reads = { board: { schema_version: 'local-deals-board.v1', actor: 'joe', deals: [boardRow] },
    detail: structuredClone(detail), activity };
  return { output, run, deal, guard, plan, detail, agentEvent, agentJournal, putJournal,
    readDetail, send, getReads: () => reads, setReads: value => { reads = value; }, readCount: () => readCount };
}

test('exact agent event admits one browser Undo, requires readback and observed UI', async t => {
  const f = await fixture(t);
  const admitted = await f.guard.admitAutomaticPhaseUndo({ phase: 'admit', deal: f.deal, release });
  assert.equal(admitted.automatic_phase.event_id, f.agentEvent.id);
  const args = { event_id: f.agentEvent.id, idempotency_key: randomUUID() };
  const undoEvent = event(randomUUID(), 'revert-deal-field', 'research', 'pending');
  await f.send('revert-deal-field', args, { ok: true, deal_id: f.deal, field: 'phase',
    reverted_event_id: f.agentEvent.id, old_value: 'research', new_value: 'pending',
    event_id: undoEvent.id, event_recorded_at: undoEvent.recorded_at });
  const afterSend = await f.plan();
  assert.equal(afterSend.browser_write_attempts.at(-1).state, 'acknowledged');
  assert.equal(afterSend.browser_write_attempts.at(-1).independent_readback, undefined);
  await assert.rejects(f.guard.admitAutomaticPhaseUndo({ phase: 'observe', deal: f.deal, release,
    observation: { event_id: f.agentEvent.id, before_badge_visible: true, exact_undo_clicked: true,
      after_badge_absent: true, restored_phase: 'pending', undo_event_id: undoEvent.id } }), /automatic-undo-observation-unproved/);
  f.detail.phase = 'pending'; f.detail.phase_change = { event_id: undoEvent.id };
  f.detail.events.push(undoEvent);
  await f.readDetail();
  const now = f.getReads(); now.board.deals[0].phase = 'pending';
  now.board.deals[0].phase_change = { automatic: false, event_id: undoEvent.id };
  now.detail = structuredClone(f.detail);
  const observed = await f.guard.admitAutomaticPhaseUndo({ phase: 'observe', deal: f.deal, release,
    observation: { event_id: f.agentEvent.id, before_badge_visible: true, exact_undo_clicked: true,
      after_badge_absent: true, restored_phase: 'pending', undo_event_id: undoEvent.id } });
  assert.equal(observed.automatic_phase.state, 'observed');
  assert.equal((await f.plan()).automatic_phase_fixture.state, 'observed');
  await assertStagingWriteCoverage(f.output);
  assert.ok(f.readCount() >= 3);
  await assert.rejects(f.guard.admitAutomaticPhaseUndo({ phase: 'admit', deal: f.deal, release }), /already-exists/);
  const altered = structuredClone(f.agentJournal);
  altered.cause_sha256 = 'e'.repeat(64);
  await f.putJournal(altered);
  await assert.rejects(assertStagingWriteCoverage(f.output), /automatic-event-journal-changed/);
});

test('unsettled, foreign, altered and ambiguous agent evidence cannot admit browser Undo', async t => {
  for (const kind of ['unsettled', 'source', 'deal', 'event', 'actor', 'cause', 'manual-event']) await t.test(kind, async t => {
    const f = await fixture(t);
    const journal = structuredClone(f.agentJournal), reads = f.getReads();
    if (kind === 'unsettled') journal.state = 'quarantined';
    if (kind === 'source') journal.source_pair.source_commit = 'b'.repeat(40);
    if (kind === 'deal') journal.deal_id = randomUUID();
    if (kind === 'event') journal.receipt.event_id = randomUUID();
    if (kind === 'actor') reads.detail.events.at(-1).actor = 'joe';
    if (kind === 'cause') reads.activity.entries[0].why = 'other fictional cause';
    if (kind === 'manual-event') journal.receipt.event_id = (await f.plan()).browser_write_attempts[0].response.receipt.event_id;
    await f.putJournal(journal); f.setReads(reads);
    await assert.rejects(f.guard.admitAutomaticPhaseUndo({ phase: 'admit', deal: f.deal, release }), /automatic-event/);
    assert.equal((await f.plan()).browser_write_attempts.length, 2);
  });
});

test('unknown browser Undo remains inflight and cannot be retried', async t => {
  const f = await fixture(t);
  await f.guard.admitAutomaticPhaseUndo({ phase: 'admit', deal: f.deal, release });
  let sent = 0;
  const args = { event_id: f.agentEvent.id, idempotency_key: randomUUID() };
  await assert.rejects(f.guard.handle(request('revert-deal-field', args), async () => {
    sent++; throw new Error('private-synthetic-response-canary');
  }), /dispatch-outcome-unresolved/);
  assert.equal((await f.plan()).browser_write_attempts.at(-1).state, 'inflight');
  await assert.rejects(f.guard.handle(request('revert-deal-field', args), () => { sent++; return response(1, {}); }), /refused/);
  assert.equal(sent, 1);
  await assert.rejects(f.guard.admitAutomaticPhaseUndo({ phase: 'observe', deal: f.deal, release,
    observation: { event_id: f.agentEvent.id } }), /automatic-undo-observation-unproved/);
});

test('after admission, changed source, foreign browser event and bad receipt cannot produce an observed effect', async t => {
  for (const kind of ['source-after-admit', 'foreign-event', 'bad-receipt']) await t.test(kind, async t => {
    const f = await fixture(t);
    await f.guard.admitAutomaticPhaseUndo({ phase: 'admit', deal: f.deal, release });
    const args = { event_id: f.agentEvent.id, idempotency_key: randomUUID() };
    let forwarded = 0;
    if (kind === 'source-after-admit') {
      const journal = structuredClone(f.agentJournal);
      journal.source_pair.source_commit = 'b'.repeat(40);
      await f.putJournal(journal);
      await assert.rejects(f.guard.handle(request('revert-deal-field', args), () => { forwarded++; return response(1, {}); }), /refused/);
    } else if (kind === 'foreign-event') {
      await assert.rejects(f.guard.handle(request('revert-deal-field', { ...args, event_id: randomUUID() }),
        () => { forwarded++; return response(1, {}); }), /refused/);
    } else {
      await assert.rejects(f.guard.handle(request('revert-deal-field', args), () => {
        forwarded++;
        return response(1, { ok: true, deal_id: f.deal, field: 'phase',
          reverted_event_id: randomUUID(), old_value: 'research', new_value: 'pending',
          event_id: randomUUID(), event_recorded_at: new Date().toISOString() });
      }), /dispatch-outcome-unresolved/);
      assert.equal((await f.plan()).browser_write_attempts.at(-1).state, 'unresolved');
    }
    assert.equal(forwarded, kind === 'bad-receipt' ? 1 : 0);
  });
});

test('foreign owned-deal substitution stops before normal authenticated reads', async t => {
  const f = await fixture(t), before = f.readCount();
  await assert.rejects(f.guard.admitAutomaticPhaseUndo({ phase: 'admit', deal: randomUUID(), release }), /record-outside-fixtures/);
  assert.equal(f.readCount(), before);
});
