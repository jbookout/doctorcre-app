// App presentation only. CARR owns consent, relevance and receipt validation.
const NATIVE_KEYS = ['source_system', 'native_id', 'native_id_epoch'];
const CEILING_KEYS = ['dispatchable', 'provider_operation', 'send_authority_holder', 'send_authority_seam', 'automatic_internal_update', 'effects'];
const RECEIPT_KEYS = ['read_receipt_id', 'partner_slug', 'adapter_kind', 'account_digest', 'native_identity', 'thread_metadata', 'metadata_digest', 'consent_in_force', 'recorded_at'];
const EFFECT_KEYS = ['creates_effect', 'database_writes', 'network_calls', 'provider_actions', 'notifications', 'schedules', 'deployments', 'activations', 'acceptances'];
const READINESS_KEYS = ['ok', 'schema_version', 'readiness', 'mailbox_reads_possible', 'activation', 'owed', 'kernel_gaps', 'policy', 'consentable_operations', 'never_consentable_operations', ...CEILING_KEYS];
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function readinessRequest(args = {}) {
  if (!exact(args, [])) throw new TypeError('correspondence-readiness takes no arguments');
  return {};
}
export function threadRequest(args) {
  if (!exact(args, NATIVE_KEYS) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(args.source_system ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/@!+=-]{0,254}$/.test(args.native_id ?? '') ||
      typeof args.source_system !== 'string' || typeof args.native_id !== 'string' ||
      !Number.isSafeInteger(args.native_id_epoch) || args.native_id_epoch < 0) {
    throw new TypeError('read-correspondence-thread requires the exact native identity');
  }
  return { ...args };
}
function sameIdentity(a, b) {
  try { threadRequest(a); threadRequest(b); return NATIVE_KEYS.every(key => a[key] === b[key]); } catch { return false; }
}
function ceiling(answer) {
  return answer.dispatchable === false && answer.provider_operation === null && answer.automatic_internal_update === false &&
    text(answer.send_authority_holder) && text(answer.send_authority_seam) && exact(answer.effects, EFFECT_KEYS) &&
    answer.effects.creates_effect === false && EFFECT_KEYS.slice(1).every(key => answer.effects[key] === 0);
}
export function unavailableEvidence(reason = 'read_unavailable') {
  return { state: 'unavailable', count: null, items: [], reason };
}
export function readinessState(answer) {
  if (!exact(answer, READINESS_KEYS) || answer.ok !== true || !ceiling(answer) ||
      answer.schema_version !== 'doctorcre-v5-j103-correspondence-store.v1') return unavailableEvidence();
  const read = answer.readiness;
  if (!exact(read, ['server_instant', 'partners', 'read_receipt_writer_granted_to_runtime']) || !instant(read.server_instant) ||
      !Array.isArray(read.partners) || !read.partners.length || typeof read.read_receipt_writer_granted_to_runtime !== 'boolean' ||
      typeof answer.mailbox_reads_possible !== 'boolean' || answer.mailbox_reads_possible !== read.read_receipt_writer_granted_to_runtime ||
      !read.partners.every(p => exact(p, ['partner_slug', 'consents_in_force', 'consents_revoked', 'read_receipts', 'drafts']) &&
        text(p.partner_slug) && ['consents_in_force', 'consents_revoked', 'read_receipts', 'drafts'].every(key => Number.isSafeInteger(p[key]) && p[key] >= 0)) ||
      !exact(answer.activation, ['human_step', 'status', 'note']) || !exact(answer.activation.human_step, ['step', 'owner', 'what']) ||
      !exact(answer.policy, ['correspondence', 'journey']) || !Array.isArray(answer.owed) ||
      !answer.owed.every(step => exact(step, ['step', 'owner', 'what'])) ||
      !Array.isArray(answer.consentable_operations) || !Array.isArray(answer.never_consentable_operations)) return unavailableEvidence();
  // Global receipt/draft counts do not answer how much evidence THIS deal has.
  return read.read_receipt_writer_granted_to_runtime ? { state: 'ready', count: null, items: [] }
    : unavailableEvidence('adapter_unavailable');
}
export function correspondenceState(answer, identity) {
  const keys = ['ok', 'decision', 'reason_id', 'native_identity', 'receipts', ...CEILING_KEYS];
  if (answer?.decision === 'unavailable') keys.push('owed_seam');
  if (!exact(answer, keys) || answer.ok !== true || !ceiling(answer) || !text(answer.reason_id) ||
      !sameIdentity(answer.native_identity, identity) || !Array.isArray(answer.receipts)) return unavailableEvidence();
  if (answer.decision === 'unavailable') return unavailableEvidence('adapter_unavailable');
  if (answer.decision !== 'receipts_found' || !answer.receipts.length) return unavailableEvidence();
  const ids = new Set();
  for (const row of answer.receipts) {
    if (!exact(row, RECEIPT_KEYS) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.read_receipt_id) ||
        ids.has(row.read_receipt_id) || !sameIdentity(row.native_identity, identity) || row.consent_in_force !== true ||
        !text(row.partner_slug) || !text(row.adapter_kind) || !digest(row.account_digest) || !digest(row.metadata_digest) ||
        !instant(row.recorded_at) || !object(row.thread_metadata) || row.thread_metadata.relevance_state !== 'related') return unavailableEvidence();
    ids.add(row.read_receipt_id);
  }
  // thread_metadata is an opaque JSON object in the store contract. No subject,
  // body, inferred facts or arbitrary metadata fields are used for presentation.
  const items = answer.receipts.map(row => ({ id: row.read_receipt_id, kind: 'thread',
    title: 'Correspondence thread', when: row.recorded_at,
    source: `${row.native_identity.source_system} · ${row.adapter_kind} · ${row.partner_slug} · CARR read receipt` }));
  return { state: 'ready', count: items.length, items };
}
export function meetingEvidence(activities) {
  const meetings = Array.isArray(activities) ? activities.filter(row => row?.kind === 'meeting') : [];
  if (!meetings.length) return unavailableEvidence('meeting_coverage_unavailable');
  if (!meetings.every(row => text(row.id) && text(row.source) && text(row.summary) && instant(row.occurred_at))) return unavailableEvidence();
  return { state: 'ready', count: meetings.length, items: meetings.map(row => ({ id: row.id,
    kind: 'meeting', title: row.summary, when: row.occurred_at, source: `${row.source} · CARR deal activity` })) };
}
export function threadReferences(detail) {
  const refs = new Map();
  for (const row of Array.isArray(detail?.activities) ? detail.activities : []) {
    if (!['meeting', 'correspondence'].includes(row?.kind) || !text(row.source)) continue;
    try { const identity = threadRequest(row.detail?.native_identity); refs.set(JSON.stringify(identity), identity); } catch { /* no verified pointer */ }
  }
  return [...refs.values()];
}
