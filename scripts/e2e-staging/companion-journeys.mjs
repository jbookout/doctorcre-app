import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { requireSupervisedRun } from './run-limits.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { V1_QUALIFICATION_SHA256 } from './v1-qualification.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };

async function probeCompanion(timeout) {
  try {
    const response = await fetch('http://127.0.0.1:4682/api/state', {
      method: 'GET', targetAddressSpace: 'loopback', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return { available: null };
    const body = await response.json();
    return { available: true, state: body.state };
  } catch { return { available: false }; }
}

function measuredCompanionUI() {
  const button = document.querySelector('#callModeButton');
  const retry = document.querySelector('#callModeRetry');
  const dialog = document.querySelector('#callModeDialog');
  const report = document.querySelector('#postCallPanel');
  const draftButtons = [...document.querySelectorAll('[data-create-outlook-draft]')];
  const draft = draftButtons[0];
  return { button_hidden: button?.hidden === true, retry_visible: retry?.hidden === false,
    availability: document.querySelector('#callModeAvailability')?.textContent?.trim(),
    dialog_open: dialog?.open === true, report_visible: report?.hidden === false,
    draft_count: draftButtons.length, draft_id: draft?.dataset.createOutlookDraft || null,
    candidate_id: draft?.dataset.draftCandidate || null, content_hash: draft?.dataset.contentHash || null,
    draft_disabled: draft?.disabled === true, draft_label: draft?.textContent?.trim() || null,
    start_controls_hidden: document.querySelector('#callModeStarts')?.hidden === true &&
      document.querySelector('#callModeConsentRow')?.hidden === true &&
      document.querySelector('#callModeStop')?.hidden === true };
}

export async function runCompanionJourneys({ page, fixtureGuard, release, plan, run } = {}) {
  run = requireSupervisedRun(undefined, run);
  const url = new URL(page?.url?.() || 'about:blank');
  if (url.origin !== staging.origin || url.pathname !== '/deals' || !fixtureGuard?.companionJourney ||
      plan?.state !== 'complete' || plan?.inflight || plan?.release?.source_commit !== release?.source_commit ||
      plan?.release?.carr_source_commit !== release?.carr_source_commit) fail('companion-source-binding-unproved');
  const timeout = Math.max(1, Math.min(run.limits.httpTimeoutMs, run.limits.settlementMs));
  const identity = await page.evaluate(async limit => {
    const [app, session] = await Promise.all(['/app-release', '/auth/session'].map(path =>
      fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(limit) })
        .then(response => response.ok ? response.json() : null)));
    return { app, session };
  }, timeout);
  if (identity.app?.service !== 'doctorcre-app' || identity.app.environment !== 'staging' ||
      identity.app.source_commit !== release.source_commit || !stagingAuth.session.matches(identity.session))
    fail('companion-source-binding-unproved');
  const sourcePair = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit };
  const invoke = (phase, extra = {}) => fixtureGuard.companionJourney({ phase, release: sourcePair, fixture_run: plan.run, ...extra });
  const probe = await page.evaluate(probeCompanion, timeout);
  const status = await invoke('status');
  let measured;
  if (probe.available === false && status.eligibility?.outcome === 'connection-refused') {
    await page.waitForFunction(() => document.querySelector('#callModeButton')?.hidden === true &&
      document.querySelector('#callModeRetry')?.hidden === false &&
      document.querySelector('#callModeRetry')?.disabled === false, undefined, { timeout });
    measured = await invoke('observe', { ui: await page.evaluate(measuredCompanionUI) });
  } else fail('companion-isolated-mailbox-required');
  return ['Outlook draft', 'Call Mode'].map(id => Object.freeze({ id, ...measured,
    source_pair: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    run_id: run.snapshot().id, fixture_run: plan.run, actor: 'joe', contract_sha256: V1_QUALIFICATION_SHA256 }));
}
