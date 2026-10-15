import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import invoiceContract from '../../contracts/e2e-staging-invoice-journey.v1.json' with { type: 'json' };
import { runBusinessJourneys } from '../../scripts/e2e-staging/business-journeys.mjs';
import { restoredTourDraftReady } from '../../scripts/e2e-staging/tour-draft-journey.mjs';
import { qualifyTourJourney } from '../../scripts/e2e-staging/tour-journey.mjs';
import { businessWorkerFailureCode, retainedBusinessWorkerCause, retainJourneyQualification, runBusinessPhase } from '../../scripts/e2e-staging/continue-run.mjs';
import { observedV1Action, V1_REQUIRED_ACTIONS } from '../../scripts/e2e-staging/v1-qualification.mjs';
import { RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';
import { stagingFixtureWriteGuard } from '../../scripts/e2e-staging/records.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';

const id = number => `70000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const binding = { checkout: 'a'.repeat(40), app: 'a'.repeat(40), carr: staging.producer.source_commit };
const release = { service: 'doctorcre-app', environment: 'staging', source_commit: binding.app, carr_source_commit: binding.carr };
const readPlan = async root => JSON.parse(await readFile(join(root, 'staging-records-plan.json'), 'utf8'));

test('W15 does not admit an absent, pending, or refused payment before Home observation and date collection', async t => {
  const priorEnvironment = { target: process.env.E2E_TARGET, supervised: process.env.E2E_RUN_SUPERVISED };
  process.env.E2E_TARGET = 'staging-live'; process.env.E2E_RUN_SUPERVISED = '1';
  t.after(() => {
    for (const [key, value] of [['E2E_TARGET', priorEnvironment.target], ['E2E_RUN_SUPERVISED', priorEnvironment.supervised]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  for (const prior of [null, { journey: { state: 'admitted' } },
    { state: 'refused', response: { refusal: { code: 'version_conflict' } } }]) {
    const phases = [];
    const fixtureGuard = { async admitBusinessJourneyStep({ phase }) {
      phases.push(phase);
      if (phase === 'fixture-status') return { proof: { fixture: { commission_id: id(2) } } };
      if (phase === 'status') return prior;
      return {};
    } };
    const page = { url: () => staging.origin + '/',
      evaluate: async () => ({ ...release, session: { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' } }),
      locator: () => ({ waitFor: async () => {}, click: async () => { throw new Error('stop at first Home read'); } }),
    };
    await assert.rejects(runBusinessJourneys({ page, fixtureGuard, release, deal: id(1), journeys: ['W15'],
      run: { check() {}, limits: RUN_LIMITS } }), { code: prior?.state === 'refused'
      ? 'business-journey-refused-version-conflict' : 'business-journey-selector-unavailable' });
    assert.deepEqual(phases, prior?.state === 'refused' ? ['fixture-status', 'status']
      : ['fixture-status', 'status', 'fixture-refresh']);
  }
});

async function paymentPhaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'payment-proof-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = { schema: 'doctorcre-staging-records-plan.v1', state: 'complete', inflight: null,
    run: id(1), release, keys: { awaiting_invoice_deal: id(7), awaiting_invoice_lead: id(8), awaiting_invoice_close: id(9) },
    records: { deal: { id: id(2) }, invoice: { deal_id: id(3) }, client: { ref: 'synthetic-client' },
      awaiting_invoice: { deal_id: id(4), name: 'Synthetic awaiting invoice' }, tour: { id: id(5) } },
    receipts: { awaiting_invoice_deal: { ok: true, deal_id: id(4), name: 'Synthetic awaiting invoice', client_ref: 'synthetic-client' },
      awaiting_invoice_lead: { ok: true, new_lead: 'joe' },
      awaiting_invoice_close: { ok: true, deal_id: id(4), field: 'phase', event_id: id(10) } } };
  await writeFile(join(root, 'staging-records-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  const run = { root, check() {}, signal: new AbortController().signal, limits: RUN_LIMITS,
    snapshot: () => ({ id: 'synthetic-payment-readiness' }), onStop: () => () => {},
    http: operation => operation(), writeFile: (path, bytes, writer) => writer(path, bytes) };
  const guard = { assertCoverage: async () => {}, forContext: () => ({ assertCoverage: async () => {},
    handle: (_request, forward) => forward() }) };
  let url;
  const page = { url: () => url, goto: async destination => { url = destination; return { ok: () => true }; }, waitForLoadState: async () => {} };
  const laterFailure = new Error('Synthetic Tour failure after payment');
  const expected = V1_REQUIRED_ACTIONS.filter(row => row.id === 'W15' && row.case !== 'invoice-close' && row.action !== 'awaiting-payment-hidden')
    .map(row => observedV1Action({ ...row, sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr },
      runId: run.snapshot().id, fixtureRun: plan.run, ui: { observed: row.action }, readback: { owned: true } }));
  let resumed = false;
  const supplied = { invoicePrerequisite: async () => ({ status: 'READY', verifiedTarget: {} }),
    coverage: async () => {}, session: async () => ({ state: {}, release }),
    prepare: async (_root, options) => ({ ...await options.session(staging.origin), complete: true, needs_restore: [], records: plan.records }),
    releaseProbe: async () => release, guardFactory: () => guard,
    browserFactory: async () => ({ newContext: async () => ({ route: async () => {}, addInitScript: async () => {},
      on() {}, newPage: async () => page, close: async () => {} }), close: async () => {} }),
    journeys: async ({ journeys }) => ({ completed: journeys,
      steps: journeys.map(journey => ({ journey, state: resumed ? 'previously-observed' : 'observed' })),
      actions: journeys[0] === 'W15' && !resumed ? expected : [], full_v1_qualified: false }),
    tourPrerequisite: async () => ({ status: 'READY', fixtureBinding: {} }),
    invoiceCloseJourney: async () => ({ actions: [], full_v1_qualified: false }),
    qualifyTour: async () => { throw laterFailure; },
  };
  return { root, run, supplied, expected, laterFailure, resume: () => { resumed = true; } };
}

test('all nine payment proofs survive a later Tour failure and an observed-payment resume', async t => {
  const f = await paymentPhaseFixture(t);
  await assert.rejects(runBusinessPhase({ binding, run: f.run, environment: {} }, f.supplied), error => error === f.laterFailure);
  const first = (await readPlan(f.root)).journey_qualification;
  assert.deepEqual(first.observations, f.expected);
  assert.deepEqual(first.readonly, { W1: 'pending', W2: 'pending', W5: 'pending', W14: 'pending' });
  f.resume();
  await assert.rejects(runBusinessPhase({ binding, run: f.run, environment: {} }, f.supplied), error => error === f.laterFailure);
  assert.deepEqual((await readPlan(f.root)).journey_qualification.observations, f.expected);
});

test('incremental payment retention still refuses malformed Tour or read-only observations', async t => {
  const f = await paymentPhaseFixture(t);
  for (const invalid of [{ tour: null }, { tour: { full_v1_qualified: true } }, { readonly: null }])
    await assert.rejects(retainJourneyQualification({ run: f.run, binding, release, result: {
      completed: ['W15'], steps: [{ journey: 'W15', state: 'observed' }], actions: f.expected,
      full_v1_qualified: false, ...invalid,
    } }), { code: Object.hasOwn(invalid, 'readonly') ? 'readonly-result-unqualified' : 'journey-observations-invalid' });
});

test('restored W6 requirements wait for the exact selected client option in the serialized page predicate', () => {
  const expected = { clientId: id(1), requirements: 'Synthetic saved requirements' };
  const ready = picker => runInNewContext(`(${restoredTourDraftReady})(expected)`, {
    expected, document: { querySelector: selector => selector === '#plan-client' ? picker : { value: expected.requirements } },
  });
  const restored = { value: expected.clientId, options: [{ value: expected.clientId, selected: true }] };
  assert.equal(ready({ value: '', options: [] }), false);
  assert.equal(ready({ value: expected.clientId, options: [{ value: id(2), selected: true }] }), false);
  assert.equal(ready(restored), true);
});

test('Tour qualification awaits owned library membership before its uniqueness check', async () => {
  const sourcePair = { app: binding.app, carr: binding.carr };
  const plan = { schema: 'doctorcre-staging-records-plan.v1', origin: staging.origin, state: 'complete', inflight: null,
    run: id(1), release, names: { tour: 'Synthetic readiness Tour' }, keys: { tour: id(7) },
    records: { client: { id: id(2) }, tour: { id: id(3), name: 'Synthetic readiness Tour' } }, receipts: {} };
  const fixtureBinding = { schema: 'doctorcre-staging-tour-fixture-binding.v1', provenance: 'private_installer_raw_readback',
    run: plan.run, source_pair: sourcePair, tour_id: id(3), route_version_id: id(4), excluded_stop_id: id(5), synthetic_property_id: id(6) };
  const stop = { id: id(5), property_id: id(6), stop_state: 'excluded', route_sequence: null, route_label: null, access_coordinate_status: 'unknown' };
  const detail = { id: id(3), name: plan.names.tour, subject_type: 'client', subject_id: id(2), status: 'draft',
    route_version_state: 'draft', accepted_route_version: 0, route_version_id: id(4), projection_id: null, stops: [stop],
    routes: [{ id: id(4), accepted: false, route_version: 1, routing_source: 'manual', created_by: 'joe', stops: [stop] }] };
  const events = [];
  let ready = false;
  const page = { url: () => staging.origin + '/tours', on() {}, off() {},
    evaluate: async fn => String(fn).includes('__tourJourneyIdentity__')
      ? { release, session: { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' } } : detail,
    locator: selector => ({
      waitFor: async () => { if (selector.includes('[data-tour-id=')) { ready = true; events.push('wait'); } },
      count: async () => { if (selector.includes('[data-tour-id=')) { events.push('count'); return ready ? 1 : 0; } return 0; },
      click: async () => { events.push('open'); }, textContent: async () => plan.names.tour,
      allTextContents: async () => ['draft', '0 stops'],
    }),
  };
  await qualifyTourJourney({ page, plan, sourcePair, fixtureBinding, run: { check() {}, limits: RUN_LIMITS } });
  assert.deepEqual(events, ['wait', 'count', 'open']);
});

test('verified pre-effect payment refusals retain their closed worker diagnostic codes', () => {
  for (const refusal of ['invalid_received_on', 'invoice_not_found', 'version_conflict', 'invoice_not_unpaid', 'payment_date_out_of_range']) {
    const code = `business-journey-refused-${refusal.replaceAll('_', '-')}`;
    assert.equal(businessWorkerFailureCode({ code }), code);
    assert.equal(retainedBusinessWorkerCause({ code: 'worker-exit-1', message: `Staging run stopped: worker-exit-1 (cause=${code})` }), code);
  }
  assert.equal(businessWorkerFailureCode({ code: 'business-journey-refused-private-provider-message' }), null);
});

test('fixture and companion refusal diagnostics remain a finite known set', () => {
  for (const code of ['staging-fixture-relationship-prerequisite', 'invoice-close-never-replay',
    'invoice-close-outcome-unresolved', 'companion-reconciliation-required', 'companion-source-binding-unproved'])
    assert.equal(businessWorkerFailureCode({ code }), code);
  assert.equal(businessWorkerFailureCode({ code: 'companion-private-provider-message' }), null);
});

const request = (name, args) => ({ method: () => 'POST', url: () => staging.origin + '/mcp',
  postDataJSON: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
const response = payload => ({ status: () => 200, json: async () => payload });
const rpc = (value, isError = false) => ({ jsonrpc: '2.0', id: 1,
  result: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] } });
const offsetDay = (date, days) => new Date(Date.parse(date.slice(0, 10)) - days * 86_400_000).toISOString().slice(0, 10);

async function admittedPayment(t) {
  const f = await paymentPhaseFixture(t), plan = await readPlan(f.root);
  const target = { project: { id: 'synthetic-staging-project', name: 'carr-staging-replacement-synthetic' },
    branch: { id: 'synthetic-branch', name: 'main' }, endpoint: { id: 'ep-synthetic', host: 'ep-synthetic.neon.tech' }, database: 'neondb' };
  const observed = new Date().toISOString();
  plan.origin = staging.origin; plan.observed_at = observed;
  plan.records.party = { id: 'fc08d2f4-a951-5679-9f34-40d0f4278842', name: 'Synthetic Staging Fixture' };
  plan.records.client = { id: id(11), name: plan.records.party.name };
  plan.names = { invoice: `Synthetic staging QA ${plan.run} closed deal` };
  plan.records.invoice.name = plan.names.invoice;
  plan.receipts.client = { client_id: plan.records.client.id };
  plan.receipts.invoice_deal = { deal_id: plan.records.invoice.deal_id };
  await writeFile(join(f.root, 'staging-records-plan.json'), JSON.stringify(plan), { mode: 0o600 });
  const bytes = createHash('sha1').update(Buffer.from('4acbfa5b1f3847afaac01c4688cfc479', 'hex'))
    .update('staging-invoice-commission:' + plan.run).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString('hex'), commission = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const invoiced = offsetDay(observed, 45), due = offsetDay(observed, 15), today = observed.slice(0, 10);
  const proof = { schema: invoiceContract.installer.proof_schema, provenance: { kind: 'raw-sql-fixture' },
    fixture_run: plan.run, source_pair: release, recorded_plan_observed_at: observed, verified_target: target,
    tool_source_sha256: invoiceContract.installer.sha256, fixture: { mode: 'aged-invoice',
      date_offsets_days: { invoiced_on_before_observation: 45, due_on_before_observation: 15 }, observation_date: today,
      party: plan.records.party, deal: { id: plan.records.invoice.deal_id, name: plan.names.invoice,
        phase: 'closed', outcome: null, owner: 'joe', client_id: plan.records.client.id },
      commission_id: commission, base_version: 1,
      commission_readback: { id: commission, deal_id: plan.records.invoice.deal_id, gross_amount: '1.00',
        status: 'invoiced', invoiced_on: invoiced, received_on: null, base_version: 1, due_on: due },
      tracker_readback: { deal_id: plan.records.invoice.deal_id, commission_id: commission, gross_amount: '1.00',
        status: 'invoiced', invoiced_on: invoiced, received_on: null, due_on: due } } };
  const proofPath = join(f.root, 'synthetic-invoice-proof.json');
  await writeFile(proofPath, JSON.stringify(proof), { mode: 0o600 });
  f.run.reserveBytes = () => {};
  const guard = stagingFixtureWriteGuard({ output: f.root, release, run: f.run, invoiceFixtureTarget: target });
  const scoped = guard.forContext(), spec = { journey: 'W15', step: 'paid', deal: plan.records.invoice.deal_id, release };
  await guard.admitBusinessJourneyStep({ ...spec, phase: 'import-fixture', proofPath });
  const tracker = { schema_version: 'invoice-tracker.v1', actor: 'joe', observed_at: observed, entries: [{
    deal_id: plan.records.invoice.deal_id, name: plan.names.invoice, phase: 'closed', owner: 'joe', lane: 'territory', outcome: null,
    commission_id: commission, gross_amount: '1.00', status: 'invoiced', base_version: 1,
    closed_on: null, invoiced_on: null, commission_invoiced_on: invoiced, due_on: due, received_on: null, as_of: today,
  }] };
  await scoped.handle(request('read-invoice-tracker', {}), async () => response(rpc(tracker)));
  await guard.admitBusinessJourneyStep({ ...spec, phase: 'admit', received_on: today,
    before_observation: { commission_id: commission, home_attention_present: true } });
  const args = { commission_id: commission, base_version: 1, received_on: today, idempotency_key: id(20) };
  return { ...f, guard, scoped, args, spec };
}

test('guard delivers all five authenticated payment refusals as non-effects and forbids replay', async t => {
  admitFixtureRun(t);
  for (const code of ['invalid_received_on', 'invoice_not_found', 'version_conflict', 'invoice_not_unpaid', 'payment_date_out_of_range']) {
    const f = await admittedPayment(t);
    const value = { error: code, ...(code === 'version_conflict' ? { current_version: 2 } : {}) };
    const reply = response(rpc(value, true));
    const delivered = await f.scoped.handle(request('record-commission-receipt', f.args), async () => reply);
    assert.equal(delivered, reply);
    const stored = await readPlan(f.root), row = stored.browser_write_attempts[0];
    assert.deepEqual([row.state, row.dispatched_outcome, row.response.refusal.code, stored.fixture_proofs.invoice.state],
      ['refused', 'verified pre-effect refusal', code, 'ready']);
    await assert.doesNotReject(f.guard.assertCoverage());
    let replays = 0;
    await assert.rejects(f.scoped.handle(request('record-commission-receipt', f.args), async () => { replays++; return reply; }),
      { code: 'journey-intent-missing' });
    assert.equal(replays, 0);
  }
});

test('unknown or malformed payment responses remain unresolved and require reconciliation', async t => {
  admitFixtureRun(t);
  for (const reply of [rpc({ error: 'unexpected_refusal' }, true), rpc({ error: 'invoice_not_found' }),
    { ...rpc({ error: 'invoice_not_found' }, true), id: 2 }, rpc({ error: 'version_conflict' }, true)]) {
    const f = await admittedPayment(t);
    await assert.rejects(f.scoped.handle(request('record-commission-receipt', f.args), async () => response(reply)),
      { code: 'dispatch-outcome-unresolved' });
    assert.equal((await readPlan(f.root)).browser_write_attempts[0].state, 'unresolved');
    await assert.rejects(f.guard.assertCoverage(), { code: 'write-coverage-incomplete' });
  }
});
