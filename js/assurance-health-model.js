// App boundary for assurance-health.v1. Mirrored contract is checked against the pinned interface.
export const ASSURANCE_CONTRACT = {
  "schema_version": "assurance-health.v1",
  "required_keys": [
    "schema_version",
    "scope",
    "state",
    "green",
    "state_reason",
    "capability_stage",
    "capability_stage_attributable_to_findings",
    "workflow_truth",
    "owner",
    "evidence",
    "failing_layers",
    "indeterminate_layers",
    "missing_layers",
    "unbindable_layers",
    "reasons",
    "impact",
    "recovery"
  ],
  "states": [
    "healthy",
    "degraded",
    "failed",
    "unknown",
    "disabled",
    "not-yet-operational"
  ],
  "capability_stages": [
    "act",
    "draft",
    "read",
    "unavailable"
  ],
  "owner_keys": [
    "kind",
    "ref"
  ],
  "workflow_truth": {
    "unavailable_keys": [
      "available",
      "source",
      "reason"
    ],
    "available_keys": [
      "available",
      "source",
      "state",
      "enabled",
      "admissible_modes"
    ],
    "states": [
      "unknown",
      "conflict",
      "undeclared",
      "unregistered",
      "declared_disabled",
      "enabled_shadow_only",
      "enabled_canary_eligible",
      "enabled_live_eligible",
      "operational"
    ]
  },
  "evidence_states": [
    "unreadable",
    "missing",
    "mismatched",
    "unbindable",
    "conflicting",
    "refused_substitute",
    "failed",
    "error",
    "skipped",
    "untested",
    "self_attested",
    "indistinct",
    "stale",
    "passing"
  ],
  "evidence_statuses": [
    "pass",
    "fail",
    "skipped",
    "untested",
    "error",
    "conflicting"
  ],
  "absent_evidence_keys": [
    "layer",
    "state",
    "present",
    "scope"
  ],
  "present_evidence_keys": [
    "layer",
    "state",
    "present",
    "status",
    "basis",
    "scope",
    "subject_ref",
    "evaluator_ref",
    "evidence_ref",
    "evidence_digest",
    "observed_at",
    "expires_at",
    "incident_refs",
    "recovery_refs"
  ],
  "layer_details": {
    "artifact_assessment": [
      "repository_commit_sha",
      "repository_tree_sha",
      "reviewer_fact_id"
    ],
    "execution_assessment": [
      "attempt_id",
      "envelope_digest",
      "plan_hash"
    ],
    "controller_assessment": [
      "controller_state",
      "readback_source",
      "readback_at"
    ],
    "candidate_outcome_oracle": [
      "governed_data_ref",
      "environment",
      "expected_result_ref",
      "equivalence_comparator",
      "component_versions"
    ],
    "activation_readback": [
      "activation_id",
      "readback_source",
      "readback_at"
    ],
    "actual_business_outcome": [
      "outcome_feedback_ref",
      "outcome_feedback_hash",
      "acceptance_receipt_id"
    ]
  },
  "layer_bases": {
    "artifact_assessment": "independent_artifact_review",
    "execution_assessment": "attempt_receipt_execution_evidence",
    "controller_assessment": "controller_readback",
    "candidate_outcome_oracle": "candidate_outcome_oracle_receipt",
    "activation_readback": "activation_readback",
    "actual_business_outcome": "accepted_sourced_outcome_feedback_receipt"
  },
  "impact_keys": [
    "scope_limited_to",
    "withdrawn_stages"
  ],
  "recovery_keys": [
    "required_evidence"
  ]
};
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function assuranceHealthRequest(args) {
  const scope = args?.scope;
  const keys = ['workflow_key', 'workflow_version', ...(Object.hasOwn(scope ?? {}, 'work_request_id') ? ['work_request_id'] : [])];
  if (!exact(args, ['scope']) || !exact(scope, keys) || typeof scope.workflow_key !== 'string' ||
      scope.workflow_key.length < 1 || scope.workflow_key.length > 255 ||
      !Number.isSafeInteger(scope.workflow_version) || scope.workflow_version < 1 ||
      (keys.includes('work_request_id') && (typeof scope.work_request_id !== 'string' || !/^WR-[0-9]{1,12}$/.test(scope.work_request_id)))) {
    throw new TypeError('read-assurance-health requires an exact workflow scope');
  }
  return { scope: { ...scope } };
}

export const ASSURANCE_LAYERS = Object.freeze(Object.keys(ASSURANCE_CONTRACT.layer_details));
const text = v => typeof v === 'string' && v.length > 0;
function instant(v) {
  if (typeof v !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[7] ?? 0); const offsetMinute = Number(match[8] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour < 24 && minute < 60 && second < 60 && offsetHour < 24 && offsetMinute < 60 && Number.isFinite(Date.parse(v));
}
const digest = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const list = (v, allowed) => Array.isArray(v) && v.every(item => allowed.includes(item)) && new Set(v).size === v.length;
const refs = v => Array.isArray(v) && v.every(text);
function sameScope(a, b) {
  try {
    assuranceHealthRequest({ scope: a }); assuranceHealthRequest({ scope: b });
    return a.workflow_key === b.workflow_key && a.workflow_version === b.workflow_version && a.work_request_id === b.work_request_id;
  } catch { return false; }
}
function validProjection(answer, scope) {
  const c = ASSURANCE_CONTRACT;
  if (!exact(answer, c.required_keys) || answer.schema_version !== c.schema_version || !sameScope(answer.scope, scope) ||
      !c.states.includes(answer.state) || typeof answer.green !== 'boolean' || answer.green !== (answer.state === 'healthy') ||
      !text(answer.state_reason) || !c.capability_stages.includes(answer.capability_stage) ||
      !c.capability_stages.includes(answer.capability_stage_attributable_to_findings) ||
      !exact(answer.owner, c.owner_keys) || answer.owner.kind !== 'record_layer' || answer.owner.ref !== 'ops.assurance_health_evidence') return false;
  const truth = answer.workflow_truth;
  if (truth?.available === false) {
    if (!exact(truth, c.workflow_truth.unavailable_keys) || !text(truth.reason) || answer.state !== 'unknown' || answer.capability_stage !== 'unavailable') return false;
  } else if (truth?.available === true) {
    if (!exact(truth, c.workflow_truth.available_keys) || !c.workflow_truth.states.includes(truth.state) ||
        typeof truth.enabled !== 'boolean' || !list(truth.admissible_modes, ['shadow', 'canary', 'live']) ||
        (['unknown', 'conflict', 'undeclared'].includes(truth.state) && answer.state !== 'unknown') ||
        (answer.state === 'disabled') !== (truth.state === 'declared_disabled')) return false;
  } else return false;
  if (truth.source !== 'V5-F09 workflow census' || !exact(answer.evidence, ASSURANCE_LAYERS)) return false;
  const identities = new Set(); const digests = new Set();
  for (const layer of ASSURANCE_LAYERS) {
    const row = answer.evidence[layer];
    if (!row || typeof row.present !== 'boolean' || row.layer !== layer || !sameScope(row.scope, scope) || !c.evidence_states.includes(row.state)) return false;
    if (!row.present) {
      if (!exact(row, c.absent_evidence_keys) || !['missing', 'unbindable'].includes(row.state)) return false;
    } else {
      if (!exact(row, [...c.present_evidence_keys, ...c.layer_details[layer]]) || !c.evidence_statuses.includes(row.status) ||
          row.basis !== c.layer_bases[layer] || !text(row.subject_ref) || !text(row.evaluator_ref) || !text(row.evidence_ref) ||
          !digest(row.evidence_digest) || !instant(row.observed_at) || !instant(row.expires_at) ||
          Date.parse(row.expires_at) <= Date.parse(row.observed_at) || !refs(row.incident_refs) || !refs(row.recovery_refs) ||
          !c.layer_details[layer].every(key => key === 'component_versions' ? object(row[key]) : text(row[key])) ||
          (Object.hasOwn(row, 'readback_at') && !instant(row.readback_at))) return false;
    }
    if (row.state === 'passing') {
      if (!row.present || row.status !== 'pass' || row.subject_ref === row.evaluator_ref ||
          (layer === 'actual_business_outcome' && !scope.work_request_id) ||
          identities.has(row.evidence_ref) || digests.has(row.evidence_digest)) return false;
      identities.add(row.evidence_ref); digests.add(row.evidence_digest);
    }
  }
  if (!['failing_layers', 'indeterminate_layers', 'missing_layers', 'unbindable_layers'].every(key => list(answer[key], ASSURANCE_LAYERS)) ||
      !refs(answer.reasons) || !exact(answer.impact, c.impact_keys) || !sameScope(answer.impact.scope_limited_to, scope) ||
      !list(answer.impact.withdrawn_stages, ['act', 'draft', 'read']) || !exact(answer.recovery, c.recovery_keys) ||
      !list(answer.recovery.required_evidence, ASSURANCE_LAYERS) ||
      ASSURANCE_LAYERS.some(layer => answer.evidence[layer].state !== 'passing' && !answer.recovery.required_evidence.includes(layer))) return false;
  if (answer.green || answer.capability_stage === 'act') {
    if (identities.size !== ASSURANCE_LAYERS.length || truth.available !== true || !truth.enabled ||
        !truth.admissible_modes.includes('live') || answer.state !== 'healthy' || answer.capability_stage !== 'act' ||
        answer.capability_stage_attributable_to_findings !== 'act' || answer.impact.withdrawn_stages.length ||
        answer.recovery.required_evidence.length ||
        ['failing_layers', 'indeterminate_layers', 'missing_layers', 'unbindable_layers'].some(key => answer[key].length)) return false;
  }
  return true;
}
export function evidenceAge(observedAt, now = Date.now()) {
  if (!instant(observedAt) || Date.parse(observedAt) > now) return 'age unknown';
  const seconds = Math.floor((now - Date.parse(observedAt)) / 1000);
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h old`;
  return `${Math.floor(seconds / 86400)}d old`;
}
/** Presentation guard only: never computes an upgraded CARR capability/state. */
export function assuranceHealthState(answer, scope, now = Date.now()) {
  const unknown = reason => ({ state: 'unknown', green: false, scope: scope ?? null, reason, evidence: [] });
  if (!scope) return unknown('Choose a workflow and version');
  if (!answer || answer instanceof Error) return unknown('The scoped assurance read refused, failed or timed out.');
  if (!validProjection(answer, scope)) return unknown('The scoped assurance response was invalid.');
  const evidence = ASSURANCE_LAYERS.map(layer => {
    const row = answer.evidence[layer];
    return { layer, state: row.state, age: evidenceAge(row.observed_at, now),
      expired: row.present && now > Date.parse(row.expires_at),
      fresh: row.present && Date.parse(row.observed_at) <= now && now <= Date.parse(row.expires_at) &&
        (!Object.hasOwn(row, 'readback_at') || Date.parse(row.readback_at) <= now) };
  });
  const expiredClaim = evidence.some(row => row.state === 'passing' && !row.fresh);
  const guarded = expiredClaim && (answer.green || answer.capability_stage === 'act');
  return { state: guarded ? 'unknown' : answer.state, green: !guarded && answer.green, scope: { ...scope },
    reason: guarded ? 'Passing evidence expired or carries a future timestamp; fresh evidence is required.' : answer.state_reason,
    capability_stage: guarded ? 'unavailable' : answer.capability_stage, evidence };
}

/** Bounded read only. A hung health producer cannot hold the independent page. */
export async function loadAssuranceHealth(client, scope, { timeoutMs = 8000 } = {}) {
  if (!scope) return null;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.readAssuranceHealth(assuranceHealthRequest({ scope }))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('assurance read timeout')), timeoutMs); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
