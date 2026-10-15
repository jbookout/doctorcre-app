import { setTimeout as pause } from 'node:timers/promises';
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
  } else {
    if (probe.available !== true || status.eligibility?.enabled !== true) fail('companion-eligibility-unproved');
    const admitted = await invoke('admit');
    const fixture = admitted.fixture;
    if (!fixture) fail('companion-fixture-provenance-unproved');
    const open = page.locator('#callModeButton');
    await open.waitFor({ state: 'visible', timeout });
    await open.click({ timeout });
    const selector = `[data-create-outlook-draft="${fixture.draft_id}"]`;
    const draft = page.locator(selector);
    await draft.waitFor({ state: 'visible', timeout });
    const before = await page.evaluate(measuredCompanionUI);
    if (!before.dialog_open || !before.report_visible || before.draft_count !== 1 ||
        before.draft_id !== fixture.draft_id || before.candidate_id !== fixture.candidate_id ||
        before.content_hash !== fixture.content_hash || !before.start_controls_hidden)
      fail('companion-report-ui-unproved');
    if (admitted.state !== 'observed') {
      if (before.draft_disabled || before.draft_label !== 'Approve and create Outlook draft')
        fail('companion-draft-control-unproved');
      await draft.click({ timeout });
      const deadline = Date.now() + run.limits.settlementMs;
      for (;;) {
        run.check();
        const current = await invoke('status');
        if (current.attempts.some(row => row.state === 'unresolved')) fail('companion-reconciliation-required');
        if (current.attempts.findLast(row => row.operation === 'report')?.observation?.created) break;
        if (Date.now() >= deadline) fail('companion-settlement-unverified');
        await pause(25, undefined, { signal: run.signal });
      }
    }
    await page.waitForFunction(id => {
      const button = document.querySelector(`[data-create-outlook-draft="${id}"]`);
      return button?.disabled === true && button.textContent.trim() === 'Created in Outlook';
    }, fixture.draft_id, { timeout });
    measured = await invoke('observe', { ui: await page.evaluate(measuredCompanionUI) });
    await page.locator('#callModeClose').click({ timeout });
  }
  return ['Outlook draft', 'Call Mode'].map(id => Object.freeze({ id, ...measured,
    source_pair: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    run_id: run.snapshot().id, fixture_run: plan.run, actor: 'joe', contract_sha256: V1_QUALIFICATION_SHA256 }));
}
