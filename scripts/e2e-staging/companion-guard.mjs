import { createHash, randomUUID } from 'node:crypto';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const origin = 'http://127.0.0.1:4682';
const states = new Set(['idle', 'recording', 'transcribing', 'ready_to_extract', 'filed', 'state_unknown']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const companionDigest = value => createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex');
const same = (a, b) => companionDigest(a) === companionDigest(b);
const fail = code => { throw Object.assign(new Error(code), { code, fixturePolicy: true }); };
const unavailable = row => row?.operation === 'state' && row.state === 'unavailable' &&
  row.observation?.enabled === false && row.observation.outcome === 'connection-refused' &&
  row.observation.forwarded === true;

export function createCompanionGuard({ currentPlan, persistPlan, locked, run }) {
  const update = operation => locked(async () => {
    run.check();
    const plan = await currentPlan();
    const result = await operation(plan);
    await persistPlan(plan);
    return result;
  });

  async function companionJourney({ phase, release, fixture_run: fixtureRun, ui } = {}) {
    return update(plan => {
      if (plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.state !== 'complete' || plan.inflight ||
          !same(plan.release, release) || plan.run !== fixtureRun) fail('companion-source-binding-unproved');
      const eligibility = (plan.companion_attempts || []).findLast(row => row.operation === 'state');
      if (phase === 'status') return { eligibility: eligibility?.observation || null,
        attempts: structuredClone(plan.companion_attempts || []) };
      if (phase === 'admit') fail('companion-isolated-mailbox-required');
      if (phase !== 'observe') fail('companion-phase-unproved');
      if (!eligibility) fail('companion-enabled-readback-unproved');
      if (!unavailable(eligibility)) fail('companion-isolated-mailbox-required');
      if (plan.companion_journey || plan.companion_attempts.some(row => !unavailable(row)))
        fail('companion-reconciliation-required');
      if (ui?.button_hidden !== true || ui?.retry_visible !== true || ui?.draft_count !== 0 ||
          ui?.availability !== 'Call recording runs on the Mac with Quill') fail('companion-disabled-ui-unproved');
      return { enabled: false, state: 'disabled-observed', ui_sha256: companionDigest(ui),
        readback_sha256: companionDigest(eligibility.observation) };
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
    if (request.method() !== 'GET' || url.href !== `${origin}/api/state`) fail('companion-route-unproved');
    const token = await update(plan => {
      plan.companion_attempts ||= [];
      const row = { id: randomUUID(), operation: 'state', state: 'inflight', attempted_at: new Date().toISOString() };
      plan.companion_attempts.push(row);
      return row.id;
    });
    let response;
    try { response = await run.http(forward); }
    catch (error) {
      const refused = /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String(error?.message));
      await update(plan => {
        const row = plan.companion_attempts.find(item => item.id === token);
        row.state = refused ? 'unavailable' : 'unresolved';
        row.observation = { enabled: false, outcome: refused ? 'connection-refused' : 'unknown', forwarded: true };
      });
      throw Object.assign(error, { companionRead: true });
    }
    await update(async plan => {
      const row = plan.companion_attempts.find(item => item.id === token);
      let payload;
      try {
        if (response.status() !== 200) fail('companion-response-unproved');
        payload = await response.json();
        if (!states.has(payload?.state)) fail('companion-state-unproved');
        row.state = 'blocked';
        row.observation = { enabled: true, outcome: 'isolated-mailbox-unavailable', forwarded: true };
      } catch (error) {
        row.state = 'unresolved';
        row.reason = error.code || 'companion-response-unproved';
      }
      row.response_sha256 = companionDigest(payload ?? null);
    });
    const plan = await currentPlan();
    if (plan.companion_attempts.find(item => item.id === token)?.state === 'blocked')
      fail('companion-isolated-mailbox-required');
    fail('companion-dispatch-outcome-unresolved');
  }

  async function assertCoverage() {
    const plan = await currentPlan();
    if (plan.companion_journey || (plan.companion_attempts || []).some(row => !unavailable(row)))
      fail('companion-reconciliation-required');
  }

  return { handle, companionJourney, assertCoverage };
}
