import { FACT_TERMS } from './client.js';
import { uuidv4 } from './uuid.js';

export function createFactReviewFixture() {
  const documents = ['Demo Lease.pdf', 'Demo Counteroffer.pdf', 'Demo Amendment.pdf'].map((filename, i) => ({
    id: `00000000-0000-4000-8000-00000000003${i}`, subject_type: 'deal', subject_id: 'd14', filename,
  }));
  const observations = [24, 25, 26].map((value, i) => ({ id: uuidv4(), entity_ref: 'd14', fact_key: 'base_rent_per_sf',
    value: String(value), normalized_value: String(value), unit: 'USD/SF/year', expense_basis: 'nnn', method: i === 0 ? 'ocr' : 'text_layer', confidence_tier: i === 0 ? 'verify_band' : 'auto_accept',
    source: { document_ref: documents[i].id, page_start: i + 1, page_end: i + 1, cited_text: i === 1 ? null : `Demo annual base rent is $${value} per square foot.`,
      cited_text_expires_at: i === 1 ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z', cited_text_sha256: 'a'.repeat(64) } }));
  const fields = new Map([['d14|base_rent_per_sf', { entity_ref: 'd14', fact_key: 'base_rent_per_sf', canonical_version: 0,
    review_version: '0'.repeat(64), pending: true, reasons: ['conflict', 'verify_band', 'human_review'], observations, canonical_fact: null, canonical_history: [], review_history: [] }]]);
  const receipts = new Map();
  const refuse = error => { throw Object.assign(new Error(error), { payload: { error } }); };
  const response = result => structuredClone({ ...result, ok: true, schema_version: 'fact-review.v1' });
  function replay(args) {
    const prior = receipts.get(args.idempotency_key);
    if (!prior) return null;
    if (prior.request !== JSON.stringify(args)) refuse('key_reuse');
    return response({ ...prior.result, replayed: true });
  }
  function save(args, result) {
    receipts.set(args.idempotency_key, { request: JSON.stringify(args), result: structuredClone(result) });
    return response(result);
  }
  function record(entity, input) {
    const contract = FACT_TERMS[input?.fact_key];
    const source = input?.source;
    if (!contract || !Object.hasOwn(contract.units, input.unit) || !/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/.test(input.value)
      || !source?.cited_text?.trim() || source.cited_text.length > 4000 || !Number.isInteger(source.page_start) || !Number.isInteger(source.page_end)
      || source.page_start < 1 || source.page_end < source.page_start || source.page_end > 100000
      || (input.fact_key === 'base_rent_per_sf' ? !['nnn','modified_gross','full_service_gross','gross'].includes(input.expense_basis) : Object.hasOwn(input, 'expense_basis'))) refuse('validation_error');
    if (!documents.some(doc => doc.subject_id === entity && doc.id === source.document_ref)) refuse('document_not_found');
    const key = `${entity}|${input.fact_key}`;
    if (!fields.has(key)) fields.set(key, { entity_ref: entity, fact_key: input.fact_key, canonical_version: 0, review_version: '0'.repeat(64),
      pending: true, reasons: ['human_review'], observations: [], canonical_fact: null, canonical_history: [], review_history: [] });
    const field = fields.get(key);
    const [whole, fraction = ''] = input.value.split('.');
    const scaled = (BigInt(whole + fraction) * BigInt(contract.units[input.unit])).toString().padStart(fraction.length + 1, '0');
    const normalized = fraction ? `${scaled.slice(0, -fraction.length)}.${scaled.slice(-fraction.length)}`.replace(/0+$/, '').replace(/\.$/, '') : scaled;
    const observation = { ...structuredClone(input), id: uuidv4(), entity_ref: entity, normalized_value: normalized, method: 'human', confidence_tier: 'human_review',
      source: { ...source, cited_text_expires_at: '2099-01-01T00:00:00Z', cited_text_sha256: 'b'.repeat(64) } };
    field.observations.push(observation);
    field.pending = true;
    field.review_version = (BigInt(`0x${field.review_version}`) + 1n).toString(16).padStart(64, '0');
    return observation;
  }
  return {
    attachments: entity => structuredClone(documents.filter(doc => doc.subject_id === entity)),
    async listFactReview({ entity_ref, include_resolved = false, limit = 50, cursor } = {}) {
      const all = [...fields.values()].filter(field => (!entity_ref || entity_ref === field.entity_ref) && (include_resolved || field.pending))
        .sort((a, b) => `${a.entity_ref}|${a.fact_key}`.localeCompare(`${b.entity_ref}|${b.fact_key}`));
      let offset = 0;
      if (cursor) {
        let parsed; try { parsed = JSON.parse(cursor); } catch { refuse('invalid_cursor'); }
        if (parsed.entity_ref !== entity_ref || parsed.include_resolved !== include_resolved) refuse('invalid_cursor');
        offset = parsed.offset;
      }
      const items = all.slice(offset, offset + limit);
      const has_more = offset + limit < all.length;
      return response({ items, has_more, next_cursor: has_more ? JSON.stringify({ entity_ref, include_resolved, offset: offset + limit }) : null });
    },
    async recordHumanFact(args) {
      const prior = replay(args); if (prior) return prior;
      const observation = record(args.entity_ref, args.observation);
      return save(args, { replayed: false, batch_id: uuidv4(), observations: [{ id: observation.id, observation_ref: 'human' }], observation });
    },
    async resolveFactReview(args) {
      const prior = replay(args); if (prior) return prior;
      const field = fields.get(`${args.entity_ref}|${args.fact_key}`);
      if (!field) refuse('not_found');
      if (args.base_version !== field.canonical_version || args.review_version !== field.review_version) refuse('version_conflict');
      if (!args.reason?.trim() || args.reason.length > 2000 || !['approve','correct','reject'].includes(args.decision)
        || (args.decision === 'approve') !== Object.hasOwn(args, 'observation_id')
        || (args.decision === 'correct') !== Object.hasOwn(args, 'correction')) refuse('validation_error');
      let chosen;
      if (args.decision === 'correct') {
        if (args.correction.fact_key !== args.fact_key) refuse('validation_error');
        chosen = record(args.entity_ref, args.correction);
      }
      if (args.decision === 'approve') {
        chosen = field.observations.find(row => row.id === args.observation_id);
        if (!chosen) refuse('not_found');
      }
      if (chosen) {
        field.canonical_version++;
        field.canonical_fact = { entity_ref: field.entity_ref, fact_key: field.fact_key, normalized_value: chosen.normalized_value,
          canonical_unit: Object.keys(FACT_TERMS[field.fact_key].units)[0], expense_basis: chosen.expense_basis || null, version: field.canonical_version,
          observation_ids: [chosen.id], basis: 'human_review' };
        field.canonical_history.push(structuredClone(field.canonical_fact));
      }
      const review_receipt = { decision: args.decision, reason: args.reason, canonical_version: field.canonical_version, chosen_observation_id: chosen?.id || null };
      field.review_history.push(review_receipt); field.pending = false;
      field.review_version = (BigInt(`0x${field.review_version}`) + 1n).toString(16).padStart(64, '0');
      return save(args, { replayed: false, canonical_fact: field.canonical_fact, review_receipt });
    },
  };
}
