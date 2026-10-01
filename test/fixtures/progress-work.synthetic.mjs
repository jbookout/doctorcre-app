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
