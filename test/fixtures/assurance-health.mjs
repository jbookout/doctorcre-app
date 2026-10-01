// Synthetic contract examples; no production records or evidence.
export const scope = { workflow_key: 'demo.workflow', workflow_version: 3, work_request_id: 'WR-700' };
export const NOW = Date.parse('2026-10-01T15:00:00.000Z');
const details = {
  artifact_assessment: { repository_commit_sha: 'a'.repeat(40), repository_tree_sha: 'b'.repeat(40), reviewer_fact_id: 'demo-review' },
  execution_assessment: { attempt_id: 'demo-attempt', envelope_digest: 'sha256:' + 'c'.repeat(64), plan_hash: 'sha256:' + 'd'.repeat(64) },
  controller_assessment: { controller_state: 'demo-controller', readback_source: 'demo-readback', readback_at: '2026-10-01T14:55:00.000Z' },
  candidate_outcome_oracle: { governed_data_ref: 'demo-data', environment: 'demo', expected_result_ref: 'demo-result', equivalence_comparator: 'demo-comparator', component_versions: { demo: 1 } },
  activation_readback: { activation_id: 'demo-activation', readback_source: 'demo-readback', readback_at: '2026-10-01T14:55:00.000Z' },
  actual_business_outcome: { outcome_feedback_ref: 'demo-feedback', outcome_feedback_hash: 'sha256:' + 'e'.repeat(64), acceptance_receipt_id: 'demo-acceptance' },
};
const bases = ['independent_artifact_review', 'attempt_receipt_execution_evidence', 'controller_readback',
  'candidate_outcome_oracle_receipt', 'activation_readback', 'accepted_sourced_outcome_feedback_receipt'];
export function projection(state = 'unknown') {
  const healthy = state === 'healthy';
  const evidence = Object.fromEntries(Object.entries(details).map(([layer, detail], i) => [layer, {
    layer, state: 'passing', present: true, status: 'pass', basis: bases[i], scope: { ...scope },
    subject_ref: 'demo-subject', evaluator_ref: 'demo-evaluator', evidence_ref: `demo-receipt-${i}`,
    evidence_digest: 'sha256:' + String(i + 1).repeat(64), observed_at: '2026-10-01T14:55:00.000Z',
    expires_at: '2026-10-01T15:10:00.000Z', incident_refs: [], recovery_refs: [], ...detail,
  }]));
  if (state === 'degraded') { evidence.actual_business_outcome.state = 'failed'; evidence.actual_business_outcome.status = 'fail'; }
  return {
    schema_version: 'assurance-health.v1', scope: { ...scope }, state, green: healthy,
    state_reason: state === 'unknown' ? 'authoritative workflow truth (V5-F09) is unreadable; nothing is claimed about this scope' : 'Demo scoped evidence disposition',
    capability_stage: healthy ? 'act' : state === 'degraded' ? 'draft' : 'unavailable',
    capability_stage_attributable_to_findings: healthy ? 'act' : state === 'degraded' ? 'draft' : 'unavailable',
    workflow_truth: state === 'unknown' ? { available: false, source: 'V5-F09 workflow census', reason: 'workflow truth is not readable by this store; no stage above unavailable and no green state can be claimed' }
      : { available: true, source: 'V5-F09 workflow census', state: 'operational', enabled: true, admissible_modes: ['shadow', 'canary', 'live'] },
    owner: { kind: 'record_layer', ref: 'ops.assurance_health_evidence' }, evidence,
    failing_layers: state === 'degraded' ? ['actual_business_outcome'] : [], indeterminate_layers: [], missing_layers: [], unbindable_layers: [], reasons: [],
    impact: { scope_limited_to: { ...scope }, withdrawn_stages: healthy ? [] : state === 'degraded' ? ['act'] : ['act', 'draft', 'read'] },
    recovery: { required_evidence: state === 'degraded' ? ['actual_business_outcome'] : [] },
  };
}
export function missingProjection() {
  const answer = projection();
  for (const layer of Object.keys(answer.evidence)) answer.evidence[layer] = { layer, state: 'missing', present: false, scope: { ...scope } };
  answer.missing_layers = Object.keys(answer.evidence); answer.recovery.required_evidence = Object.keys(answer.evidence);
  return answer;
}
