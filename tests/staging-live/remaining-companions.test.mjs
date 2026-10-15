import assert from 'node:assert/strict';
import test from 'node:test';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import qualification from '../../contracts/e2e-staging-v1-qualification.v1.json' with { type: 'json' };
import { createCompanionGuard, companionDigest } from '../../scripts/e2e-staging/companion-guard.mjs';
import { runCompanionJourneys } from '../../scripts/e2e-staging/companion-journeys.mjs';

process.env.E2E_TARGET = 'staging-live';
process.env.E2E_RUN_SUPERVISED = '1';
const release = { source_commit: 'a'.repeat(40), carr_source_commit: qualification.producer.source_commit };
const fixtureRun = '11111111-1111-4111-8111-111111111111';
const ids = { deal: '22222222-2222-4222-8222-222222222222', party: '33333333-3333-4333-8333-333333333333',
  candidate: '44444444-4444-4444-8444-444444444444', capture: '55555555-5555-4555-8555-555555555555' };
const loopback = 'http://127.0.0.1:4682';
const request = (path, { method = 'GET', body, headers = {} } = {}) => ({
  url: () => path.startsWith('https:') ? path : loopback + path,
  method: () => method, headers: () => headers, postDataJSON: () => structuredClone(body),
});
const response = payload => ({ status: () => 200, json: async () => structuredClone(payload) });

function fixture() {
  const receipt = { schema: 'doctorcre-staging-companion-fixture.v1', operation: 'seed-staging-companion',
    synthetic: true, metadata_only: true, fixture_run: fixtureRun, source_pair: release,
    session: `staging-${fixtureRun}`, capture_session_id: ids.capture, candidate_id: ids.candidate,
    draft_id: '0123456789abcdef', content_hash: 'b'.repeat(64), transcript_sha256: 'c'.repeat(64),
    candidate_payload_sha256: 'd'.repeat(64), bridge_origin: staging.carr_origin,
    deal_id: ids.deal, party_id: ids.party, candidate_kind: 'email_draft', initial_candidate_status: 'pending',
    recipient_email: `staging-qa-${fixtureRun}@example.invalid`, subject: `Synthetic staging QA ${fixtureRun}`,
    body: `Synthetic staging QA draft for fixture ${fixtureRun}. Nothing should be sent.` };
  const report = { session: receipt.session, joe_tasks: [], dell_tasks: [], deal_updates: [], review_questions: [],
    draft_proposals: [{ draft_id: receipt.draft_id, content_hash: receipt.content_hash, candidate_id: ids.candidate,
      deal_id: ids.deal, recipient_party_id: ids.party, recipient_email: receipt.recipient_email,
      subject: receipt.subject, body: receipt.body, candidate_status: 'pending' }] };
  receipt.report_sha256 = companionDigest(report);
  return { receipt, report };
}

function harness({ enabled = true } = {}) {
  const seeded = fixture();
  let plan = { schema: 'doctorcre-staging-records-plan.v1', state: 'complete', run: fixtureRun, release,
    records: { deal: { id: ids.deal }, party: { id: ids.party } }, companion_fixture: seeded.receipt };
  let report = seeded.report;
  const run = { check() {}, limits: { httpTimeoutMs: 100, settlementMs: 100 },
    snapshot: () => ({ id: 'synthetic-companion-run' }), http: operation => operation() };
  let tail = Promise.resolve();
  const guard = createCompanionGuard({ currentPlan: async () => structuredClone(plan),
    persistPlan: async value => { plan = structuredClone(value); }, run,
    locked: operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next; } });
  const invoke = (phase, extra = {}) => guard.companionJourney({ phase, release, fixture_run: fixtureRun, ...extra });
  const envelope = () => ({ status: { state: 'ready_review', session: seeded.receipt.session }, report });
  const state = () => guard.handle(request('/api/state'), async () => {
    if (!enabled) throw new Error('connect ECONNREFUSED 127.0.0.1:4682');
    return response({ state: 'filed', mode: 'weekly_deal_call', session: seeded.receipt.session,
      staging_fixture: Object.fromEntries(['fixture_run', 'source_pair', 'session', 'capture_session_id', 'bridge_origin', 'report_sha256']
        .map(key => [key, seeded.receipt[key]])) });
  });
  const confirmation = { jsonrpc: '2.0', id: 'synthetic-confirm', method: 'tools/call',
    params: { name: 'resolve-post-call-candidate', arguments: { candidate_id: ids.candidate, accept: true,
      idempotency_key: '66666666-6666-4666-8666-666666666666' } } };
  const dialogOpen = false;
  const ui = () => enabled ? { button_hidden: false, retry_visible: false,
    availability: 'Checking Quill on this device…', dialog_open: dialogOpen, report_visible: dialogOpen,
    draft_count: dialogOpen ? 1 : 0, draft_id: seeded.receipt.draft_id, candidate_id: ids.candidate,
    content_hash: seeded.receipt.content_hash, draft_disabled: report.draft_proposals[0].status === 'created',
    draft_label: report.draft_proposals[0].status === 'created' ? 'Created in Outlook' : 'Approve and create Outlook draft',
    start_controls_hidden: true } : { button_hidden: true, retry_visible: true,
    availability: 'Call recording runs on the Mac with Quill', draft_count: 0 };
  const page = { url: () => staging.origin + '/deals',
    async evaluate(fn) {
      if (fn.name === 'probeCompanion') { try { await state(); return { available: true }; } catch { return { available: false }; } }
      if (fn.name === 'measuredCompanionUI') return ui();
      return { app: { service: 'doctorcre-app', environment: 'staging', source_commit: release.source_commit },
        session: { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' } };
    },
    waitForFunction: async () => {},
    locator: () => { throw new Error('measured-unavailable companion must never open controls'); },
  };
  return { guard, invoke, run, page, state, ui, confirmation,
    get plan() { return structuredClone(plan); }, get report() { return report; },
    alter: operation => { operation(plan); }, seed: seeded.receipt };
}

test('disabled companions require a forwarded refused connection and measured unavailable UI', async () => {
  const h = harness({ enabled: false });
  const rows = await runCompanionJourneys({ page: h.page, fixtureGuard: h.guard,
    release: { ...release, service: 'doctorcre-app', environment: 'staging' }, plan: h.plan, run: h.run });
  assert.deepEqual(rows.map(row => ({ id: row.id, enabled: row.enabled, state: row.state, actor: row.actor,
    source_pair: row.source_pair, fixture_run: row.fixture_run, run_id: row.run_id })),
  ['Outlook draft', 'Call Mode'].map(id => ({ id, enabled: false, state: 'disabled-observed', actor: 'joe',
    source_pair: release, fixture_run: fixtureRun, run_id: 'synthetic-companion-run' })));
  assert.match(rows[0].readback_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(h.plan.companion_attempts.map(row => [row.operation, row.state, row.observation.outcome]),
    [['state', 'unavailable', 'connection-refused']]);
  await h.guard.assertCoverage();
});

test('a fabricated disabled observation and a timeout cannot qualify optional features', async () => {
  const missing = harness({ enabled: false });
  await assert.rejects(missing.invoke('observe', { ui: missing.ui() }), /companion-enabled-readback-unproved/);
  const timed = harness();
  await assert.rejects(timed.guard.handle(request('/api/state'), async () => { throw new Error('Timed out'); }), /Timed out/);
  assert.deepEqual(timed.plan.companion_attempts.map(row => [row.state, row.observation.outcome]), [['unresolved', 'unknown']]);
  await assert.rejects(timed.guard.assertCoverage(), /companion-reconciliation-required/);
});

test('enabled companion execution fails closed before opening any draft control', async () => {
  const h = harness();
  let clicks = 0;
  h.page.locator = () => ({ waitFor: async () => {}, click: async () => { clicks++; } });
  await assert.rejects(runCompanionJourneys({ page: h.page, fixtureGuard: h.guard,
    release, plan: h.plan, run: h.run }), { code: 'companion-isolated-mailbox-required' });
  assert.equal(clicks, 0);
  assert.equal(h.plan.companion_journey, undefined);
  await assert.rejects(h.guard.assertCoverage(), /companion-reconciliation-required/);
});

test('fixture and bridge assertions cannot enable a mailbox without independent isolation and readback', async () => {
  const h = harness();
  await h.state().catch(() => {});
  h.alter(plan => {
    plan.companion_fixture.mailbox = { isolated: true, environment: 'staging', address: 'qa@example.invalid' };
    plan.companion_fixture.mailbox_readback = { draft_id: h.seed.draft_id, content_hash: h.seed.content_hash };
  });
  await assert.rejects(h.invoke('admit'), { code: 'companion-isolated-mailbox-required' });
  assert.equal(h.plan.companion_journey, undefined);
});

test('a created report and creator receipts never qualify a legacy enabled journey', async () => {
  const h = harness();
  h.alter(plan => {
    plan.companion_journey = { state: 'observed', fixture: plan.companion_fixture };
    plan.companion_attempts = ['state', 'confirm', 'sync', 'draft', 'report'].map(operation => ({
      operation, state: 'acknowledged', observation: { enabled: true, created: true,
        candidate_status: 'confirmed', created_at: '2026-10-15T12:00:00Z' },
    }));
  });
  await assert.rejects(h.invoke('observe', { ui: { ...h.ui(), dialog_open: true, report_visible: true,
    draft_count: 1, draft_disabled: true, draft_label: 'Created in Outlook' } }),
  { code: 'companion-isolated-mailbox-required' });
  await assert.rejects(h.guard.assertCoverage(), /companion-reconciliation-required/);
});

test('sync is refused before capture-bridge poll can file or consume the capture', async () => {
  const h = harness();
  h.alter(plan => {
    plan.companion_journey = { state: 'admitted', fixture: plan.companion_fixture };
    plan.companion_attempts = ['state', 'report', 'confirm'].map(operation => ({ operation, state: 'acknowledged' }));
  });
  let forwarded = 0;
  await assert.rejects(h.guard.handle(request('/api/post-call/sync', { method: 'POST',
    headers: { 'x-carr-call-mode': 'deal-room-v1' }, body: { session: h.seed.session } }),
  async () => { forwarded++; return response({ status: { state: 'ready_review', session: h.seed.session },
    report: { ...h.report, draft_proposals: h.report.draft_proposals.map(row => ({ ...row, candidate_status: 'confirmed' })) } }); }),
  { code: 'companion-route-unproved' });
  assert.equal(forwarded, 0);
  assert.deepEqual(h.plan.companion_attempts.map(row => row.operation), ['state', 'report', 'confirm']);
});

test('only exact status GET can reach the companion, even with a retained admitted fixture', async () => {
  const h = harness();
  h.alter(plan => { plan.companion_journey = { state: 'admitted', fixture: plan.companion_fixture }; });
  let forwarded = 0;
  for (const req of [request('/api/start', { method: 'POST', body: {} }),
    request('/api/stop', { method: 'POST', body: {} }), request('/api/state?session=other'),
    request(`/api/post-call?session=${h.seed.session}`, { headers: { 'x-carr-call-mode': 'deal-room-v1' } }),
    request(`/api/post-call/drafts/${h.seed.draft_id}/create`, { method: 'POST',
      headers: { 'x-carr-call-mode': 'deal-room-v1' }, body: { session: h.seed.session, approved_content_hash: h.seed.content_hash } }),
    request(staging.origin + '/mcp', { method: 'POST', body: h.confirmation })])
    await assert.rejects(h.guard.handle(req, async () => { forwarded++; return response({}); }),
      { code: 'companion-route-unproved' });
  assert.equal(forwarded, 0);
  assert.equal(h.plan.companion_attempts, undefined);
  assert.deepEqual(await h.guard.handle(request(staging.origin + '/app-release'), async () => {}), { handled: false });
});

test('same-origin page and authenticated exact source are required before probing', async () => {
  const h = harness();
  await assert.rejects(runCompanionJourneys({ page: { ...h.page, url: () => 'https://example.invalid/deals' },
    fixtureGuard: h.guard, release, plan: h.plan, run: h.run }), /companion-source-binding-unproved/);
  const page = { ...h.page, evaluate: async () => ({ app: { service: 'doctorcre-app', environment: 'production',
    source_commit: release.source_commit }, session: { actor: { slug: 'joe' }, e2e_principal: 'e2e-joe' } }) };
  await assert.rejects(runCompanionJourneys({ page, fixtureGuard: h.guard, release, plan: h.plan, run: h.run }),
    /companion-source-binding-unproved/);
  assert.deepEqual((await h.invoke('status')).attempts, []);
});
