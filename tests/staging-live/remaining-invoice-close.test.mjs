import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createInvoiceCloseGuard, runInvoiceCloseJourney } from '../../scripts/e2e-staging/invoice-close-journey.mjs';
import { qualifyV1Journeys, V1_REQUIRED_ACTIONS, observedV1Action } from '../../scripts/e2e-staging/v1-qualification.mjs';
import { release } from './record-fixture.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit };
const envelope = (id, data) => ({ status: () => 200, json: async () => ({ jsonrpc: '2.0', id,
  result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }) });
function adapter({ unknown = false, foreign = false, unscoped = false, capability = true, captureMutation, throwAt } = {}) {
  const plan = { run: id(1), observed_at: '2026-10-10T12:00:00.000Z', release: binding,
    records: { deal: { id: id(2), name: `Synthetic staging QA ${id(1)} open deal` },
      client: { id: id(3), name: 'Synthetic Staging Fixture' } },
    receipts: { deal: { deal_id: id(2) }, client: { client_id: id(3) } } };
  const requests = [], durable = [];
  let version = 4, phase = 'pending', invoiced = null, status = null, sequence = 0;
  const run = { check() {}, snapshot: () => ({ id: 'remaining-invoice-close' }), http: fn => fn() };
  const guard = createInvoiceCloseGuard({ currentPlan: async () => plan, run,
    persistPlan: async current => durable.push(structuredClone(current)), locked: fn => fn() });
  const send = async (name, args = {}) => {
    const requestId = ++sequence;
    const request = { method: () => 'POST', url: () => `${STAGING_ORIGIN}/mcp`,
      postDataJSON: () => ({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }) };
    const result = await guard.handle(request, async () => {
      requests.push({ name, args });
      if (throwAt === name) throw new Error('network disconnected');
      if (name === 'read-deal-reconciliation') return envelope(requestId, { id: id(2), phase,
        invoiced_on: invoiced, base_version: version });
      if (name === 'invoice-close-queue') {
        const invoice = { invoice_id: id(4), deal_id: id(2), deal_name: plan.records.deal.name,
          status: status || 'proposed', evidence_ref: `local-mail:staging-invoice:${id(1)}:${id(2)}`,
          base_version: version, invoiced_on: '2026-10-10' };
        const queue = status ? { proposals: [], moves: [invoice] } : { proposals: [invoice], moves: [] };
        if (!status) captureMutation?.(queue);
        return envelope(requestId, queue);
      }
      if (name === 'lead-stage-preview') return envelope(requestId, { scope_enforced: capability,
        staging_scope: { contract: 'staging-invoice-close.v1', ...args.staging_fixture }, moves: [],
        drafts_prepared: 0, sent: false, invoice_closes: [{ invoice_id: id(4), deal_id: id(2), status: 'applied',
          evidence_ref: `local-mail:staging-invoice:${id(1)}:${id(2)}` }] });
      const step = { 'record-deal-invoice': 'capture', 'advance-leads': 'close', 'undo-invoice-close': 'undo' }[name];
      assert.equal(durable.at(-1).invoice_close_journey.steps[step].state, 'inflight');
      if (name === 'record-deal-invoice') return envelope(requestId, { ok: true, invoice_id: id(4), evidence_ref: args.native_ref });
      if (name === 'advance-leads') {
        phase = 'closed'; invoiced = '2026-10-10'; version++; status = 'applied';
        return envelope(requestId, { ok: true, moves: [], drafts_prepared: 0, sent: false,
          ...(unscoped ? {} : { staging_scope: { contract: 'staging-invoice-close.v1', ...args.staging_fixture } }),
          invoice_closes: [{ invoice_id: id(4), deal_id: foreign ? id(99) : id(2), status: unknown ? 'proposed' : 'applied',
            from_phase: 'pending', to_phase: 'closed', evidence_ref: `local-mail:staging-invoice:${id(1)}:${id(2)}`,
            invoiced_on: invoiced }] });
      }
      assert.equal(args.base_version, version);
      phase = 'pending'; invoiced = null; version++; status = 'undone';
      return envelope(requestId, { ok: true, deal_id: id(2), phase, invoiced_on: invoiced, undone_by: id(8) });
    });
    if (!result.handled) throw new Error('Guard failed to handle request');
    return JSON.parse((await result.response.json()).result.content[0].text);
  };
  return { plan, guard, requests, send, run, durable,
    page: { evaluate: (_fn, { name, args }) => send(name, args) } };
}

test('invoice close captures evidence, confines automation, proves close and undoes with fresh version', async () => {
  const f = adapter();
  const fixtureGuard = { ...f.guard, assertCoverage: () => f.guard.assertCoverage() };
  const result = await runInvoiceCloseJourney({ ...f, release, fixtureGuard });
  assert.deepEqual(result.actions.map(row => row.action),
    ['capture-evidence', 'automatic-close', 'close-readback', 'undo-close', 'undo-readback']);
  assert.deepEqual(f.requests.find(row => row.name === 'advance-leads').args.staging_fixture,
    { fixture_run: id(1), invoice_id: id(4), deal_id: id(2) });
  assert.deepEqual(f.requests.find(row => row.name === 'undo-invoice-close').args,
    { invoice_id: id(4), base_version: 5,
      idempotency_key: f.plan.invoice_close_journey.steps.undo.arguments.idempotency_key });
  const before = f.requests.length;
  const recovered = await runInvoiceCloseJourney({ ...f, release, fixtureGuard });
  assert.deepEqual(recovered, result);
  assert.equal(f.requests.length, before);
});

test('unscoped automation, wrong-deal close and incomplete close receipt stay uncertain and cannot replay', async () => {
  for (const mode of ['unscoped', 'foreign', 'unknown']) {
    const f = adapter({ [mode]: true });
    await assert.rejects(runInvoiceCloseJourney({ ...f, release, fixtureGuard: f.guard }), /outcome-unresolved/);
    assert.equal(f.plan.invoice_close_journey.steps.close.state, 'unresolved');
    await assert.rejects(f.guard.assertCoverage(), /coverage-incomplete/);
    await assert.rejects(f.guard.admitInvoiceClose({ phase: 'admit', step: 'close', release: binding }), /never-replay/);
    assert.equal(f.requests.filter(row => row.name === 'advance-leads').length, 1);
  }
});

test('interrupted capture retains uncertain intent and forbids any second dispatch', async () => {
  const f = adapter({ throwAt: 'record-deal-invoice' });
  await assert.rejects(runInvoiceCloseJourney({ ...f, release, fixtureGuard: f.guard }), /network disconnected/);
  assert.equal(f.plan.invoice_close_journey.steps.capture.state, 'unresolved');
  await assert.rejects(runInvoiceCloseJourney({ ...f, release, fixtureGuard: f.guard }), /never-replay/);
  assert.equal(f.requests.filter(row => row.name === 'record-deal-invoice').length, 1);
});

test('invoice readback must be independently observed after close and bind the same invoice and deal', async () => {
  const f = adapter();
  await f.send('read-deal-reconciliation', { deal: id(2) });
  const capture = await f.guard.admitInvoiceClose({ phase: 'admit', step: 'capture', release: binding });
  await f.send('record-deal-invoice', capture.arguments);
  await f.send('invoice-close-queue');
  await f.guard.admitInvoiceClose({ phase: 'observe', step: 'capture', release: binding,
    observation: { invoice_id: id(4), state: 'captured' } });
  await f.send('lead-stage-preview', { staging_fixture: { fixture_run: id(1), invoice_id: id(4), deal_id: id(2) } });
  const close = await f.guard.admitInvoiceClose({ phase: 'admit', step: 'close', release: binding });
  await f.send('advance-leads', close.arguments);
  await assert.rejects(f.guard.admitInvoiceClose({ phase: 'observe', step: 'close', release: binding,
    observation: { invoice_id: id(4), state: 'applied' } }), /readback-unproved/);
  await f.send('read-deal-reconciliation', { deal: id(2) });
  await f.send('invoice-close-queue');
  const timestamp = f.plan.invoice_close_journey.queue_read_at;
  delete f.plan.invoice_close_journey.queue_read_at;
  await assert.rejects(f.guard.admitInvoiceClose({ phase: 'observe', step: 'close', release: binding,
    observation: { invoice_id: id(4), state: 'applied' } }), /readback-unproved/);
  f.plan.invoice_close_journey.queue_read_at = timestamp;
  const row = await f.guard.admitInvoiceClose({ phase: 'observe', step: 'close', release: binding,
    observation: { invoice_id: id(4), state: 'applied' } });
  assert.equal(row.state, 'observed');
});

test('missing producer scope capability refuses automation before any advance-leads dispatch', async () => {
  const f = adapter({ capability: false });
  await assert.rejects(runInvoiceCloseJourney({ ...f, release, fixtureGuard: f.guard }), /scope-unproved/);
  assert.deepEqual(f.requests.map(row => row.name), ['read-deal-reconciliation', 'record-deal-invoice',
    'invoice-close-queue', 'read-deal-reconciliation', 'lead-stage-preview']);
  const capture = f.plan.invoice_close_journey.steps.capture;
  assert.equal(capture.state, 'observed');
  assert.equal(capture.readback_sha256, createHash('sha256').update(JSON.stringify(capture.observation)).digest('hex'));
  await f.guard.assertCoverage();
  capture.readback_sha256 = null;
  await assert.rejects(f.guard.assertCoverage(), /coverage-incomplete/);
});

test('scope failure cannot leave acknowledgement-only invoice capture covered', async () => {
  const f = adapter({ capability: false });
  await f.send('read-deal-reconciliation', { deal: id(2) });
  const capture = await f.guard.admitInvoiceClose({ phase: 'admit', step: 'capture', release: binding });
  await f.send('record-deal-invoice', capture.arguments);
  await assert.rejects(f.send('lead-stage-preview', { staging_fixture: {
    fixture_run: id(1), invoice_id: id(4), deal_id: id(2) } }), /scope-unproved/);
  assert.equal(f.plan.invoice_close_journey.steps.capture.state, 'acknowledged');
  assert.equal(f.plan.invoice_close_journey.steps.capture.readback_sha256 ?? null, null);
  await assert.rejects(f.guard.assertCoverage(), /coverage-incomplete/);
});

test('capture readback requires a fresh unique invoice with the fixture identity and content', async () => {
  for (const captureMutation of [
    queue => { queue.proposals = []; },
    queue => { queue.moves = queue.proposals; queue.proposals = []; },
    queue => { queue.moves = structuredClone(queue.proposals); },
    queue => { queue.proposals.push(structuredClone(queue.proposals[0])); },
    queue => { queue.proposals[0].invoice_id = id(99); },
    queue => { queue.proposals[0].deal_id = id(99); },
    queue => { queue.proposals[0].deal_name = 'Other synthetic deal'; },
    queue => { queue.proposals[0].evidence_ref += ':changed'; },
    queue => { queue.proposals[0].invoiced_on = '2026-10-11'; },
  ]) {
    const f = adapter({ captureMutation });
    await assert.rejects(runInvoiceCloseJourney({ ...f, release, fixtureGuard: f.guard }), /readback-unproved/);
    await assert.rejects(f.guard.assertCoverage(), /coverage-incomplete/);
    assert.deepEqual(f.requests.map(row => row.name),
      ['read-deal-reconciliation', 'record-deal-invoice', 'invoice-close-queue']);
  }
  const f = adapter();
  await f.send('read-deal-reconciliation', { deal: id(2) });
  await f.send('invoice-close-queue');
  const capture = await f.guard.admitInvoiceClose({ phase: 'admit', step: 'capture', release: binding });
  await f.send('record-deal-invoice', capture.arguments);
  const observe = () => f.guard.admitInvoiceClose({ phase: 'observe', step: 'capture', release: binding,
    observation: { invoice_id: id(4), state: 'captured' } });
  await assert.rejects(observe(), /readback-unproved/);
  await f.send('invoice-close-queue');
  f.plan.invoice_close_journey.queue_read_at = f.plan.invoice_close_journey.steps.capture.completed_at - 1;
  await assert.rejects(observe(), /readback-unproved/);
  await f.send('invoice-close-queue');
  const observed = await observe();
  assert.equal(observed.state, 'observed');
  assert.equal(observed.observation.invoice_id, id(4));
  observed.observation.evidence_ref += ':changed';
  f.plan.invoice_close_journey.steps.capture.observation = observed.observation;
  await assert.rejects(f.guard.assertCoverage(), /coverage-incomplete/);
});

test('queue read begun before capture completion cannot become capture readback by finishing later', async t => {
  t.mock.method(Date, 'now', () => 1781100000000);
  const f = adapter();
  await f.send('read-deal-reconciliation', { deal: id(2) });
  const capture = await f.guard.admitInvoiceClose({ phase: 'admit', step: 'capture', release: binding });
  let queueStarted, finishQueue;
  const started = new Promise(resolve => { queueStarted = resolve; });
  const response = new Promise(resolve => { finishQueue = resolve; });
  const request = { method: () => 'POST', url: () => `${STAGING_ORIGIN}/mcp`, postDataJSON: () => ({
    jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'invoice-close-queue', arguments: {} } }) };
  const pending = f.guard.handle(request, async () => { queueStarted(); return response; });
  await started;
  await f.send('record-deal-invoice', capture.arguments);
  finishQueue(envelope(99, { proposals: [{ invoice_id: id(4), deal_id: id(2),
    deal_name: f.plan.records.deal.name, status: 'proposed',
    evidence_ref: `local-mail:staging-invoice:${id(1)}:${id(2)}`, invoiced_on: '2026-10-10' }], moves: [] }));
  await pending;
  const observe = () => f.guard.admitInvoiceClose({ phase: 'observe', step: 'capture', release: binding,
    observation: { invoice_id: id(4), state: 'captured' } });
  await assert.rejects(observe(), /readback-unproved/);
  await assert.rejects(f.guard.assertCoverage(), /coverage-incomplete/);
  await f.send('invoice-close-queue');
  const observed = await observe();
  assert.equal(observed.state, 'observed');
  await f.guard.assertCoverage();
});

test('malformed typed content never becomes an invoice receipt', async () => {
  const f = adapter();
  await f.send('read-deal-reconciliation', { deal: id(2) });
  const capture = await f.guard.admitInvoiceClose({ phase: 'admit', step: 'capture', release: binding });
  const request = { method: () => 'POST', url: () => `${STAGING_ORIGIN}/mcp`, postDataJSON: () => ({
    jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'record-deal-invoice', arguments: capture.arguments } }) };
  await assert.rejects(f.guard.handle(request, async () => ({ status: () => 200, json: async () => ({
    jsonrpc: '2.0', id: 99, result: { content: [{ type: 'image', text: JSON.stringify({
      ok: true, invoice_id: id(4), evidence_ref: capture.arguments.native_ref }) }] } }) })), /outcome-unresolved/);
  assert.equal(f.plan.invoice_close_journey.steps.capture.state, 'unresolved');
});

test('qualification always requires invoice close and undo even when every prior action is observed', () => {
  const observations = V1_REQUIRED_ACTIONS.filter(row => row.case !== 'invoice-close').map(row => observedV1Action({
    ...row, sourcePair: binding, runId: 'remaining-invoice-close', fixtureRun: id(1), ui: { measured: row.action },
    readback: { measured: row.action } }));
  const result = qualifyV1Journeys({ sourcePair: binding, runId: 'remaining-invoice-close', fixtureRun: id(1),
    observations, writeCoverage: true, retainedEvidenceVerified: true, sweepAccepted: true });
  assert.deepEqual(result.pending.map(row => row.action),
    ['capture-evidence', 'automatic-close', 'close-readback', 'undo-close', 'undo-readback']);
  assert.equal(result.full_v1_qualified, false);
});
