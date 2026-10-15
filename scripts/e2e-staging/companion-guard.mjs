import { createHash, randomUUID } from 'node:crypto';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const origin = 'http://127.0.0.1:4682';
const states = new Set(['idle', 'recording', 'transcribing', 'ready_to_extract', 'filed', 'state_unknown']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const companionDigest = value => createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex');
const same = (a, b) => companionDigest(a) === companionDigest(b);
const fail = code => { throw Object.assign(new Error(code), { code, fixturePolicy: true }); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...expected].sort().join();

function fixtureFor(plan) {
  const fixture = plan.companion_fixture;
  if (plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.state !== 'complete' || plan.inflight ||
      fixture?.schema !== 'doctorcre-staging-companion-fixture.v1' || fixture.operation !== 'seed-staging-companion' ||
      fixture.synthetic !== true || fixture.metadata_only !== true || fixture.fixture_run !== plan.run ||
      !same(fixture.source_pair, plan.release) || fixture.session !== `staging-${plan.run}` ||
      fixture.bridge_origin !== staging.carr_origin || !uuid(fixture.capture_session_id) || !uuid(fixture.candidate_id) ||
      !/^[0-9a-f]{16}$/.test(fixture.draft_id || '') || !hash(fixture.content_hash) || !hash(fixture.report_sha256) ||
      !hash(fixture.transcript_sha256) || !hash(fixture.candidate_payload_sha256) ||
      fixture.deal_id !== plan.records?.deal?.id || fixture.party_id !== plan.records?.party?.id ||
      fixture.candidate_kind !== 'email_draft' || fixture.initial_candidate_status !== 'pending' ||
      fixture.recipient_email !== `staging-qa-${plan.run}@example.invalid` ||
      fixture.subject !== `Synthetic staging QA ${plan.run}` ||
      fixture.body !== `Synthetic staging QA draft for fixture ${plan.run}. Nothing should be sent.`)
    fail('companion-fixture-provenance-unproved');
  return fixture;
}

function attestation(fixture) {
  return Object.fromEntries(['fixture_run', 'source_pair', 'session', 'capture_session_id', 'bridge_origin', 'report_sha256']
    .map(key => [key, fixture[key]]));
}

function reportFor(payload, fixture, stage) {
  const report = payload?.report;
  const status = payload?.status;
  if (status?.session !== fixture.session || !['ready_review', 'filed'].includes(status?.state) ||
      report?.session !== fixture.session || !Array.isArray(report.draft_proposals) || report.draft_proposals.length !== 1 ||
      ['joe_tasks', 'dell_tasks', 'deal_updates', 'review_questions'].some(key => !Array.isArray(report[key]) || report[key].length))
    fail('companion-report-scope-unproved');
  const draft = report.draft_proposals[0];
  if (draft.draft_id !== fixture.draft_id || draft.candidate_id !== fixture.candidate_id ||
      draft.deal_id !== fixture.deal_id || draft.recipient_party_id !== fixture.party_id ||
      draft.content_hash !== fixture.content_hash || draft.recipient_email !== fixture.recipient_email ||
      draft.subject !== fixture.subject || draft.body !== fixture.body ||
      !['pending', 'confirmed'].includes(draft.candidate_status)) fail('companion-report-scope-unproved');
  if (stage === 'initial' && (draft.candidate_status !== 'pending' || draft.status === 'created' ||
      companionDigest(report) !== fixture.report_sha256)) fail('companion-report-provenance-unproved');
  if (stage === 'confirmed' && (draft.candidate_status !== 'confirmed' || draft.status === 'created'))
    fail('companion-candidate-readback-unproved');
  if (stage === 'created' && (draft.candidate_status !== 'confirmed' || draft.status !== 'created' ||
      !Number.isFinite(Date.parse(draft.created_at)))) fail('companion-draft-readback-unproved');
  return { session: fixture.session, draft_id: draft.draft_id, candidate_id: draft.candidate_id,
    candidate_status: draft.candidate_status, created: draft.status === 'created', sha256: companionDigest(payload) };
}

export function createCompanionGuard({ currentPlan, persistPlan, locked, run }) {
  const update = operation => locked(async () => {
    run.check();
    const plan = await currentPlan();
    const result = await operation(plan);
    await persistPlan(plan);
    return result;
  });
  const last = (plan, operation) => (plan.companion_attempts || []).findLast(row => row.operation === operation);
  const acknowledged = (plan, operation) => last(plan, operation)?.state === 'acknowledged';

  async function companionJourney({ phase, release, fixture_run: fixtureRun, ui } = {}) {
    return update(plan => {
      if (!same(plan.release, release) || plan.run !== fixtureRun) fail('companion-source-binding-unproved');
      const eligibility = last(plan, 'state');
      if (phase === 'status') return { eligibility: eligibility?.observation || null,
        journey: plan.companion_journey || null, attempts: structuredClone(plan.companion_attempts || []) };
      if (phase === 'admit') {
        const fixture = fixtureFor(plan);
        if (eligibility?.state !== 'acknowledged' || !same(eligibility.observation?.staging_fixture, attestation(fixture)) ||
            eligibility.observation.session_sha256 !== companionDigest(fixture.session) ||
            eligibility.observation.mode !== 'weekly_deal_call' ||
            !['filed', 'ready_to_extract'].includes(eligibility.observation?.recorder_state))
          fail('companion-enabled-state-unproved');
        if (plan.companion_journey) {
          if (!same(plan.companion_journey.fixture, fixture)) fail('companion-fixture-binding-changed');
          if (plan.companion_journey.state !== 'observed') fail('companion-reconciliation-required');
          return structuredClone(plan.companion_journey);
        }
        plan.companion_journey = { state: 'admitted', fixture: structuredClone(fixture) };
        return structuredClone(plan.companion_journey);
      }
      if (phase !== 'observe') fail('companion-phase-unproved');
      if (eligibility?.state === 'unavailable') {
        if (plan.companion_journey || ui?.button_hidden !== true || ui?.retry_visible !== true ||
            ui?.draft_count !== 0 || ui?.availability !== 'Call recording runs on the Mac with Quill')
          fail('companion-disabled-ui-unproved');
        return { enabled: false, state: 'disabled-observed', ui_sha256: companionDigest(ui),
          readback_sha256: companionDigest(eligibility.observation) };
      }
      const fixture = fixtureFor(plan);
      if (!plan.companion_journey || !same(plan.companion_journey.fixture, fixture) ||
          !acknowledged(plan, 'confirm') || !acknowledged(plan, 'sync') || !acknowledged(plan, 'draft') ||
          !acknowledged(plan, 'report') || !last(plan, 'report')?.observation?.created || ui?.dialog_open !== true ||
          ui?.report_visible !== true || ui?.draft_count !== 1 || ui?.draft_id !== fixture.draft_id ||
          ui?.candidate_id !== fixture.candidate_id || ui?.content_hash !== fixture.content_hash ||
          ui?.draft_disabled !== true || ui?.draft_label !== 'Created in Outlook' || ui?.start_controls_hidden !== true)
        fail('companion-enabled-readback-unproved');
      plan.companion_journey.state = 'observed';
      plan.companion_journey.observation = { enabled: true, state: 'qualified', ui_sha256: companionDigest(ui),
        readback_sha256: companionDigest(plan.companion_attempts.map(row => ({ operation: row.operation,
          state: row.state, observation: row.observation }))) };
      return structuredClone(plan.companion_journey.observation);
    });
  }

  async function handle(request, forward) {
    const url = new URL(request.url());
    let rpc;
    if (url.origin === staging.origin && url.pathname === '/mcp' && request.method() === 'POST') {
      try { rpc = request.postDataJSON(); } catch {}
    }
    const confirm = rpc?.method === 'tools/call' && rpc.params?.name === 'resolve-post-call-candidate';
    if (url.origin !== origin && !confirm) return { handled: false };
    if (url.username || url.password || url.hash) fail('companion-route-unproved');
    let operation, args;
    const headers = request.headers?.() || {};
    if (request.method() === 'GET' && url.href === `${origin}/api/state`) operation = 'state';
    else {
      if (!confirm && !(request.method() === 'GET' && url.pathname === '/api/post-call' ||
          request.method() === 'POST' && !url.search && (url.pathname === '/api/post-call/sync' ||
            /^\/api\/post-call\/drafts\/[0-9a-f]{16}\/create$/.test(url.pathname))))
        fail('companion-route-unproved');
      const plan = await currentPlan();
      const fixture = fixtureFor(plan);
      if (!plan.companion_journey || !same(plan.companion_journey.fixture, fixture)) fail('companion-admission-required');
      if (confirm) {
        args = rpc.params.arguments;
        if (url.href !== `${staging.origin}/mcp` || rpc.jsonrpc !== '2.0' ||
            !(typeof rpc.id === 'string' && rpc.id || Number.isSafeInteger(rpc.id)) ||
            !keys(args, ['candidate_id', 'accept', 'idempotency_key']) || args.candidate_id !== fixture.candidate_id ||
            args.accept !== true || !uuid(args.idempotency_key)) fail('companion-candidate-scope-unproved');
        operation = 'confirm';
      } else if (request.method() === 'GET' && url.href === `${origin}/api/post-call?session=${encodeURIComponent(fixture.session)}`)
        operation = 'report';
      else if (request.method() === 'POST' && !url.search && headers['x-carr-call-mode'] === 'deal-room-v1') {
        try { args = request.postDataJSON(); } catch {}
        if (url.pathname === '/api/post-call/sync' && keys(args, ['session']) && args.session === fixture.session)
          operation = 'sync';
        else if (url.pathname === `/api/post-call/drafts/${fixture.draft_id}/create` &&
            keys(args, ['session', 'approved_content_hash']) && args.session === fixture.session &&
            args.approved_content_hash === fixture.content_hash) operation = 'draft';
      }
      if (!operation || operation === 'report' && headers['x-carr-call-mode'] !== 'deal-room-v1')
        fail('companion-route-unproved');
    }
    const token = await update(plan => {
      plan.companion_attempts ||= [];
      if (operation !== 'state') {
        fixtureFor(plan);
        if (['confirm', 'sync', 'draft'].includes(operation) && last(plan, operation)) fail('companion-reconciliation-required');
        if (operation === 'confirm' && !acknowledged(plan, 'report') ||
            operation === 'sync' && !acknowledged(plan, 'confirm') ||
            operation === 'draft' && !acknowledged(plan, 'sync')) fail('companion-order-unproved');
        if (operation === 'report' && plan.companion_attempts.filter(row => row.operation === 'report').length >= 16)
          fail('companion-report-budget-exceeded');
      }
      const row = { id: randomUUID(), operation, state: 'inflight', attempted_at: new Date().toISOString(),
        ...(operation === 'report' ? { expected_stage: acknowledged(plan, 'draft') ? 'created'
          : acknowledged(plan, 'confirm') ? 'confirmed' : 'initial' } : {}),
        ...(args ? { arguments_sha256: companionDigest(args) } : {}) };
      plan.companion_attempts.push(row);
      return row.id;
    });
    let response;
    try { response = await run.http(forward); }
    catch (error) {
      const unavailable = operation === 'state' && /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String(error?.message));
      await update(plan => {
        const row = plan.companion_attempts.find(item => item.id === token);
        row.state = unavailable ? 'unavailable' : 'unresolved';
        row.observation = { enabled: false, outcome: unavailable ? 'connection-refused' : 'unknown', forwarded: true };
      });
      if (operation === 'state') throw Object.assign(error, { companionRead: true });
      fail('companion-dispatch-outcome-unresolved');
    }
    await update(async plan => {
      const row = plan.companion_attempts.find(item => item.id === token);
      let payload;
      try {
        if (response.status() !== 200) fail('companion-response-unproved');
        payload = await response.json();
        if (operation === 'state') {
          if (!states.has(payload?.state)) fail('companion-state-unproved');
          row.observation = { enabled: true, recorder_state: payload.state, mode: payload.mode || null,
            session_sha256: companionDigest(payload.session || null),
            ...(payload.staging_fixture ? { staging_fixture: payload.staging_fixture } : {}) };
        } else {
          const fixture = fixtureFor(plan);
          if (operation === 'confirm') {
            let receipt;
            try { receipt = JSON.parse(payload.result.content[0].text); } catch {}
            if (payload.jsonrpc !== '2.0' || payload.id !== rpc.id || payload.error || payload.result?.isError ||
                payload.result?.content?.length !== 1 || payload.result.content[0].type !== 'text' ||
                !keys(receipt, ['ok', 'candidate_id', 'status', 'ref', 'local_only', 'send']) ||
                receipt.ok !== true || receipt.candidate_id !== fixture.candidate_id || receipt.status !== 'confirmed' ||
                receipt.ref !== null || receipt.local_only !== true || receipt.send !== false)
              fail('companion-candidate-receipt-unproved');
            row.observation = receipt;
          } else if (operation === 'draft') {
            if (!keys(payload, ['draft_id', 'content_hash', 'idempotent']) || payload.draft_id !== fixture.draft_id ||
                payload.content_hash !== fixture.content_hash || payload.idempotent !== false)
              fail('companion-draft-receipt-unproved');
            row.observation = payload;
          } else row.observation = reportFor(payload, fixture, operation === 'sync' ? 'confirmed' : row.expected_stage);
        }
        row.state = 'acknowledged';
        row.response_sha256 = companionDigest(payload);
      } catch (error) {
        row.state = 'unresolved';
        row.response_sha256 = companionDigest(payload ?? null);
        row.reason = error.code || 'companion-response-unproved';
      }
    });
    const plan = await currentPlan();
    if (plan.companion_attempts.find(item => item.id === token)?.state !== 'acknowledged')
      fail('companion-dispatch-outcome-unresolved');
    return { handled: true, response };
  }

  async function assertCoverage() {
    const plan = await currentPlan();
    if ((plan.companion_attempts || []).some(row => ['inflight', 'unresolved'].includes(row.state)) ||
        (plan.companion_attempts || []).some(row => ['confirm', 'sync', 'draft'].includes(row.operation)) &&
        plan.companion_journey?.state !== 'observed') fail('companion-reconciliation-required');
  }

  return { handle, companionJourney, assertCoverage };
}
