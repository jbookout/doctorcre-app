// Synthetic store responses. Key sets follow governed-correspondence-store.v5.js.
export const identity = { source_system: 'demo-mail', native_id: 'demo-thread-1', native_id_epoch: 0 };
export const effects = { creates_effect: false, database_writes: 0, network_calls: 0,
  provider_actions: 0, notifications: 0, schedules: 0, deployments: 0, activations: 0, acceptances: 0 };
export const ceiling = { dispatchable: false, provider_operation: null,
  send_authority_holder: 'human', send_authority_seam: 'demo-human-seam', automatic_internal_update: false, effects };
export const unavailable = { ok: true, decision: 'unavailable', reason_id: 'j103.store.no_read_receipt',
  owed_seam: 'step:demo-adapter-read-receipt', native_identity: identity, receipts: [], ...ceiling };
export const receipt = { read_receipt_id: '10000000-0000-4000-8000-000000000001',
  partner_slug: 'demo-partner', adapter_kind: 'v5_f10_partner_mail_calendar_adapter',
  account_digest: `sha256:${'a'.repeat(64)}`, native_identity: identity,
  thread_metadata: { relevance_state: 'related' }, metadata_digest: `sha256:${'b'.repeat(64)}`,
  consent_in_force: true, recorded_at: '2026-09-30T12:00:00Z' };
export const found = { ok: true, decision: 'receipts_found', reason_id: 'j103.store.receipts_with_provenance',
  native_identity: identity, receipts: [receipt], ...ceiling };
export const readiness = { ok: true, schema_version: 'doctorcre-v5-j103-correspondence-store.v1',
  readiness: { server_instant: '2026-09-30T12:00:00Z', partners: [{ partner_slug: 'demo-partner',
    consents_in_force: 0, consents_revoked: 0, read_receipts: 0, drafts: 0 }], read_receipt_writer_granted_to_runtime: false },
  mailbox_reads_possible: false, activation: { human_step: { step: 'demo', owner: 'demo', what: 'demo' },
    status: 'consent_not_recorded', note: 'demo' }, owed: [], kernel_gaps: {},
  policy: { correspondence: 'demo', journey: 'demo' }, consentable_operations: [], never_consentable_operations: [], ...ceiling };
export const meeting = { id: 'demo-meeting', occurred_at: '2026-09-30T11:00:00Z',
  actor: 'demo-partner', kind: 'meeting', summary: 'Demo discovery meeting', detail: {}, source: 'Demo calendar fixture' };
