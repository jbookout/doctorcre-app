import fixture from './progress-work.synthetic.json' with {type:'json'};
import { passportProjectionDigest } from '../../js/job-passport.js';

// Canonical producer attribution is bound to its envelope; historical wire
// fixtures intentionally exercise a separate contract.
export function canonicalFixture() {
  const value=structuredClone(fixture.engineering);
  for(const receipt of value.receipts){
    const envelope=value.execution_envelopes.find(row=>passportProjectionDigest(row)===receipt.envelope_digest);
    envelope.agent_session.id=receipt.attribution.session_ref;
    envelope.server_binding.identity.agent_principal_id=receipt.attribution.actor_ref;
    envelope.server_binding.adapter.adapter_id=receipt.attribution.adapter_ref;
    receipt.envelope_digest=passportProjectionDigest(envelope);
  }
  value.current_receipts=structuredClone(value.receipts);value.current_reviewer_facts=structuredClone(value.reviewer_facts);
  value.projection_digest=passportProjectionDigest(value);return value;
}

// Two successive jobs each start at attempt:1. The pinned CARR producer
// (f57eef02890e3642042fc5c14d1ce4e6ecf3c82e) retains both envelope generations.
export function multiEnvelopeCanonicalFixture({ reviewed = false } = {}) {
  const value = canonicalFixture();
  const prior = value.receipts[0];
  prior.attempt_id = 'attempt:1';
  value.execution_envelopes[0].envelope_id = 'env:first';
  prior.envelope_digest = passportProjectionDigest(value.execution_envelopes[0]);
  const envelope = structuredClone(value.execution_envelopes[0]);
  envelope.envelope_id = 'env:second';
  envelope.request.job_ref = 'job:second';
  envelope.agent_session.id = 'session:second';
  envelope.server_binding.identity.agent_principal_id = 'actor:second';
  const current = structuredClone(prior);
  current.envelope_digest = passportProjectionDigest(envelope);
  current.attribution.actor_ref = 'actor:second';
  current.attribution.session_ref = 'session:second';
  current.executor_claim.claimed_by = 'actor:second';
  current.evidence_refs[0].ref = 'evidence:second';
  value.execution_envelopes.push(envelope);
  value.receipts.push(current);
  value.current_receipts = [structuredClone(current)];
  const review = (receipt, actor, session) => ({ slice_ref: receipt.slice_ref,
    attempt_id: receipt.attempt_id, reviewer_ref: actor, session_ref: session,
    state: 'passed', evidence_refs: structuredClone(receipt.evidence_refs),
    is_independent: true, reviewed_deviation_refs: [], resolved_deviation_refs: [] });
  // The later executor may independently review the earlier generation.
  value.reviewer_facts = [review(prior, 'actor:second', 'session:second')];
  value.current_reviewer_facts = reviewed ? [review(current, 'actor:reviewer', 'session:reviewer')] : [];
  value.reviewer_facts.push(...structuredClone(value.current_reviewer_facts));
  value.slices[0].state = reviewed ? 'verified_complete' : 'claimed';
  const evidence = value.receipts.flatMap(receipt => receipt.evidence_refs);
  value.operator_receipt = { what_changed: [], why: 'derived from the accepted plan and typed execution evidence',
    evidence_refs: evidence, deviations: [], remaining_risk: reviewed ? [] : [prior.slice_ref], manual_qa_items: [] };
  for (const key of ['work', 'proof', 'explanation', 'release']) {
    value.closure[key] = { state: reviewed ? 'complete' : 'unresolved', evidence_refs: evidence, note: 'derived from canonical persisted facts' };
  }
  value.closure.learning = { state: 'unresolved', route: null, evidence_refs: evidence, note: 'learning remains a proposal/disposition seam' };
  value.closure_state = reviewed ? 'complete' : 'blocked';
  value.projection_digest = passportProjectionDigest(value);
  return value;
}

// The producer binds each review to a separate receipt ledger ID, then omits
// those IDs from the projection. Independent reviews can have equal payloads.
export function equalReviewCanonicalFixture() {
  const value = multiEnvelopeCanonicalFixture({ reviewed: true });
  value.reviewer_facts[0] = structuredClone(value.current_reviewer_facts[0]);
  value.projection_digest = passportProjectionDigest(value);
  return value;
}
