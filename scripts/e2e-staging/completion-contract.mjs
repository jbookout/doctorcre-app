import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

export const COMPLETION_STATUS = Object.freeze({
  PARTIAL: 'PARTIAL',
  NEEDS_RECONCILIATION: 'NEEDS_RECONCILIATION',
  FAILED: 'FAILED',
  ACCEPTED_SWEEP: 'ACCEPTED_SWEEP',
});

const sourceBound = release => release?.service === 'doctorcre-app' &&
  release.environment === 'staging' && /^[0-9a-f]{40}$/.test(release.source_commit || '') &&
  release.carr_source_commit === contract.producer.source_commit;
const goalKey = row => JSON.stringify([row.target, row.screen, row.path, row.agent]);
const completedStatuses = new Set(['completed', 'finished']);
const incompleteStatuses = new Set(['time', 'stuck', 'aborted', 'step-limit', 'SKIPPED']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The existing exploration scheduler defines two desktop agents and one phone
// agent for every routed screen. Keep its accepted terminal statuses and goal
// identity exact; no missing or malformed row can count as completed.
export function explorationCoverage({ targets, routedScreens, explorations, explorationRelease, release }) {
  const planned = targets.flatMap(target => routedScreens.filter(screen => screen.surface === target.surface).flatMap(screen => {
    const agents = target.name.endsWith('phone') ? ['phone-reviewer'] : ['bug-hunter', 'first-time-ux'];
    return agents.map(agent => ({ target: target.name, screen: screen.name, path: screen.path, agent }));
  }));
  const sourceMatches = sourceBound(explorationRelease) && sourceBound(release) &&
    explorationRelease.source_commit === release.source_commit &&
    explorationRelease.carr_source_commit === release.carr_source_commit;
  const pendingExplorations = [], failedExplorations = [], skippedExplorations = [];
  const plannedKeys = new Set(planned.map(goalKey));
  const seen = new Set();
  let completedExplorations = 0;
  if (!Array.isArray(explorations)) explorations = [];
  for (const row of explorations) {
    const validIdentity = row && typeof row === 'object' &&
      ['target', 'screen', 'path', 'agent'].every(key => typeof row[key] === 'string' && row[key].length > 0);
    const key = validIdentity ? goalKey(row) : null;
    if (!validIdentity || !plannedKeys.has(key) || seen.has(key)) {
      failedExplorations.push({ target: validIdentity ? row.target : 'unknown', path: validIdentity ? row.path : 'unknown', status: 'invalid-or-duplicate' });
      continue;
    }
    seen.add(key);
    const goal = { target: row.target, screen: row.screen, path: row.path, agent: row.agent };
    if (row.status === 'ERROR') {
      failedExplorations.push({ ...goal, status: row.status });
    } else if (row.status === 'SKIPPED') {
      skippedExplorations.push({ ...goal, status: row.status });
      pendingExplorations.push({ ...goal, status: row.status });
    } else if (completedStatuses.has(row.status) && Number.isSafeInteger(row.steps) && row.steps > 0 && row.steps <= 40 &&
        typeof row.evidence === 'string' && row.evidence.includes('/evidence/explore/')) {
      if (!sourceMatches) pendingExplorations.push({ ...goal, status: 'source-pair-unbound' });
      else completedExplorations++;
    } else if (row.status === undefined || incompleteStatuses.has(row.status) || typeof row.status === 'string') {
      pendingExplorations.push({ ...goal, status: typeof row.status === 'string' ? row.status : 'missing-proof-fields' });
    } else {
      failedExplorations.push({ ...goal, status: 'invalid-status' });
    }
  }
  for (const goal of planned) if (!seen.has(goalKey(goal))) pendingExplorations.push({ ...goal, status: 'MISSING' });
  if (!sourceMatches && !pendingExplorations.length) {
    for (const goal of planned) pendingExplorations.push({ ...goal, status: 'source-pair-unbound' });
    completedExplorations = 0;
  }
  return Object.freeze({
    expectedExplorations: planned.length,
    completedExplorations,
    pendingExplorations,
    failedExplorations,
    skippedExplorations,
    explorationsSourceBound: sourceMatches,
  });
}

function fixturePrerequisiteSummary(setup, release) {
  const missing = [];
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return { complete: false, missing: ['fixture-setup'] };
  if (setup.schema !== 'doctorcre-staging-records.v1' || !sourceBound(setup.release) ||
      setup.release.source_commit !== release.source_commit || setup.release.carr_source_commit !== release.carr_source_commit) {
    return { complete: false, missing: ['fixture-source-pair'] };
  }
  if (setup.complete !== true) missing.push('fixture-setup-incomplete');
  const records = setup.records && typeof setup.records === 'object' ? setup.records : {};
  const ids = {
    party: records.party?.id,
    client: records.client?.id,
    deal: records.deal?.id,
    invoice: records.invoice?.deal_id,
    lead_party: records.lead_party?.id,
    lead: records.lead?.id,
    conversation: records.conversation?.id,
    tour: records.tour?.id,
  };
  for (const [name, id] of Object.entries(ids)) if (typeof id !== 'string' || !uuid.test(id)) missing.push(`fixture-${name}`);
  if (Object.values(ids).every(id => typeof id === 'string' && uuid.test(id)) && new Set(Object.values(ids)).size !== Object.keys(ids).length)
    missing.push('fixture-record-identities-ambiguous');
  if (setup.eligibleLead !== true) missing.push('eligible-lead');
  if (!Array.isArray(setup.needs_restore)) missing.push('restore-state-unavailable');
  else if (setup.needs_restore.length) missing.push(`restore-required-${setup.needs_restore.length}`);
  return { complete: missing.length === 0, missing };
}

// ACCEPTED_SWEEP covers the existing screen/state/exploration sweep and its
// prepared fixture prerequisites. No business-journey proof catalog exists in
// this source contract, so full V1 acceptance remains PARTIAL until one is
// supplied by an authorized source owner.
export function completionContract({ verdict, release, fixtureWriteScopeComplete, setup, targets, routedScreens,
  retainedEvidence, businessProof, runId }) {
  const plannedExplorations = Array.isArray(targets) && Array.isArray(routedScreens)
    ? targets.flatMap(target => routedScreens.filter(screen => screen.surface === target.surface)
      .flatMap(() => target.name.endsWith('phone') ? ['phone-reviewer'] : ['bug-hunter', 'first-time-ux'])).length
    : 0;
  if (!verdict || typeof verdict !== 'object' || !Array.isArray(verdict.pendingScreens) ||
      !Array.isArray(verdict.failedScreens) || !Array.isArray(verdict.failedStateObligations) ||
      !Array.isArray(verdict.pendingStateObligations) || !Array.isArray(verdict.newDeadControls) ||
      !Array.isArray(verdict.pendingExplorations) || !Array.isArray(verdict.failedExplorations) ||
      !Array.isArray(verdict.skippedExplorations) || plannedExplorations < 1 ||
      !Number.isSafeInteger(verdict.expectedExplorations) ||
      !Number.isSafeInteger(verdict.completedExplorations) ||
      verdict.completedExplorations < 0 || verdict.completedExplorations > verdict.expectedExplorations ||
      typeof verdict.explorationsSourceBound !== 'boolean' ||
      !Number.isSafeInteger(verdict.skippedControls) || verdict.skippedControls < 0 ||
      !Number.isSafeInteger(verdict.skippedStateObligations) || verdict.skippedStateObligations < 0 ||
      typeof verdict.completed !== 'boolean' || typeof verdict.failed !== 'boolean' ||
      typeof fixtureWriteScopeComplete !== 'boolean') {
    throw new Error('Staging completion contract requires canonical source-bound run and exploration verdicts');
  }

  const fixtures = fixturePrerequisiteSummary(setup, release);
  const evidenceVerified = retainedEvidence?.schema === 'doctorcre-staging-retained-evidence.v1' &&
    retainedEvidence.verified === true && retainedEvidence.source_pair?.source_commit === release?.source_commit &&
    retainedEvidence.source_pair?.carr_source_commit === release?.carr_source_commit &&
    typeof runId === 'string' && runId.length > 0 && retainedEvidence.run_id === runId &&
    Number.isSafeInteger(retainedEvidence.referencedFiles) && retainedEvidence.referencedFiles > 0;
  const businessSourceBound = businessProof?.schema === 'staging-business-journey-result.v1' &&
    businessProof.release?.source_commit === release?.source_commit &&
    businessProof.release?.carr_source_commit === release?.carr_source_commit &&
    Array.isArray(businessProof.completed) && Array.isArray(businessProof.unqualified_journeys) &&
    businessProof.full_v1_qualified === false;
  let status, reason;
  if (!sourceBound(release) || fixtures.missing.includes('fixture-source-pair')) {
    status = COMPLETION_STATUS.FAILED;
    reason = 'source-pair-invalid';
  } else if (verdict.newDeadControls.length || verdict.failedScreens.length || verdict.failedStateObligations.length || verdict.failedExplorations.length) {
    status = COMPLETION_STATUS.FAILED;
    reason = 'measured-failure';
  } else if (!fixtureWriteScopeComplete) {
    status = COMPLETION_STATUS.NEEDS_RECONCILIATION;
    reason = 'fixture-write-scope-unreconciled';
  } else if (!verdict.completed || verdict.pendingScreens.length || verdict.pendingStateObligations.length ||
      verdict.skippedControls || verdict.skippedStateObligations || verdict.pendingExplorations.length ||
      verdict.skippedExplorations.length || verdict.completedExplorations !== verdict.expectedExplorations ||
      verdict.expectedExplorations !== plannedExplorations || !verdict.explorationsSourceBound || !fixtures.complete || !evidenceVerified) {
    status = COMPLETION_STATUS.PARTIAL;
    reason = 'source-bound-work-or-fixture-prerequisite-remains';
  } else {
    status = COMPLETION_STATUS.ACCEPTED_SWEEP;
    reason = 'bounded-sweep-complete; business-journey-proof-contract-unavailable';
  }

  return Object.freeze({
    schema: 'doctorcre-staging-completion.v2',
    status,
    proofStatus: status,
    v1Status: status === COMPLETION_STATUS.ACCEPTED_SWEEP ? 'PARTIAL' : status,
    jobStatus: status === COMPLETION_STATUS.ACCEPTED_SWEEP ? 'SWEEP_ACCEPTED' : status === COMPLETION_STATUS.PARTIAL ? 'CONTINUE' : 'BLOCKED',
    accepted: status === COMPLETION_STATUS.ACCEPTED_SWEEP,
    acceptedV1: false,
    resumable: status === COMPLETION_STATUS.PARTIAL,
    expectedExplorations: plannedExplorations,
    completedExplorations: verdict.completedExplorations,
    pendingExplorations: verdict.pendingExplorations,
    failedExplorations: verdict.failedExplorations,
    skippedExplorations: verdict.skippedExplorations,
    fixturePrerequisitesComplete: fixtures.complete,
    missingFixturePrerequisites: fixtures.missing,
    retainedEvidenceVerified: evidenceVerified,
    businessProofSourceBound: businessSourceBound,
    unqualifiedJourneys: businessSourceBound ? [...businessProof.unqualified_journeys] : [],
    reason,
  });
}

export function assertSweepJobOutcome(completion) {
  if (['ACCEPTED_SWEEP', 'PARTIAL'].includes(completion?.status)) return completion;
  throw new Error(`Staging sweep ${completion?.status || 'INVALID'}; see sweep-verdict.json and coverage.md.`);
}
