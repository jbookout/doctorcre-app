export type ReviewKind = 'action' | 'reply_draft' | 'fact_review';
const supported = {
  action: ['complete-one-action'],
  reply_draft: ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'],
  fact_review: ['resolve-fact-review'],
} satisfies Record<ReviewKind, string[]>;
export type ReviewReference = { kind: ReviewKind; item_id: string; source_version: string; operations: string[] };
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const version = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const uuid = (v: unknown): v is string => text(v) && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
export function parseReference(v: unknown): ReviewReference | null {
  if (!object(v) || (v.kind !== 'action' && v.kind !== 'reply_draft' && v.kind !== 'fact_review') || !text(v.item_id) || !text(v.source_version) || !strings(v.operations) || !v.operations.length || new Set(v.operations).size !== v.operations.length) return null;
  const allowed = supported[v.kind];
  if (v.operations.some(op => !allowed.includes(op))) return null;
  return { kind: v.kind, item_id: v.item_id, source_version: v.source_version, operations: v.operations };
}
type ActionOperation = { verb: 'complete-one-action'; args: { action_id: string; base_version: number } };
type ReplyOperation = { verb: 'edit-email-draft' | 'dismiss-email-proposal'; args: { proposal_id: string; base_version: number } } | { verb: 'submit-email-draft'; args: { proposal_id: string; base_version: number; subject: string; body: string; to: string[]; cc: string[] } };
type FactOperation = { verb: 'resolve-fact-review'; args: { entity_ref: string; fact_key: string; base_version: number; review_version: string }; decisions: string[] };
export type Operation = ActionOperation | ReplyOperation | FactOperation;
export type Observation = { id: string; value: string; unit: string; source: { document_ref: string; page_start: number; page_end: number; cited_text: string | null } };
type Common = { reference: ReviewReference };
export type Review = Common & ({ kind: 'action'; operations: ActionOperation[]; title: string } | { kind: 'reply_draft'; operations: ReplyOperation[]; subject: string; body: string; to: string[]; cc: string[] } | { kind: 'fact_review'; operations: FactOperation[]; observations: Observation[]; canonical: string });
function unreadable(): never { throw Error('This review is not supported safely. Open its source record.'); }
function parseOperation(v: unknown): Operation {
  if (!object(v) || !object(v.args)) return unreadable();
  const a = v.args;
  if (!version(a.base_version)) return unreadable();
  if (v.verb === 'complete-one-action' && uuid(a.action_id) && a.base_version > 0) return { verb: v.verb, args: { action_id: a.action_id, base_version: a.base_version } };
  if ((v.verb === 'edit-email-draft' || v.verb === 'dismiss-email-proposal') && uuid(a.proposal_id) && a.base_version > 0) return { verb: v.verb, args: { proposal_id: a.proposal_id, base_version: a.base_version } };
  if (v.verb === 'submit-email-draft' && uuid(a.proposal_id) && a.base_version > 0 && text(a.subject) && typeof a.body === 'string' && strings(a.to) && a.to.length === 1 && strings(a.cc) && a.cc.length === 1) return { verb: v.verb, args: { proposal_id: a.proposal_id, base_version: a.base_version, subject: a.subject, body: a.body, to: a.to, cc: a.cc } };
  if (v.verb === 'resolve-fact-review' && uuid(a.entity_ref) && text(a.fact_key) && text(a.review_version) && strings(v.decisions) && v.decisions.length > 0 && v.decisions.every(d => ['approve', 'correct', 'reject'].includes(d))) return { verb: v.verb, args: { entity_ref: a.entity_ref, fact_key: a.fact_key, base_version: a.base_version, review_version: a.review_version }, decisions: v.decisions };
  return unreadable();
}
export function parseReview(v: unknown, expected: ReviewReference): Review {
  if (!object(v) || v.ok !== true || v.schema_version !== 'home-review.v1' || !object(v.detail) || !Array.isArray(v.operations) || !v.operations.length) return unreadable();
  const reference = parseReference(v.reference);
  if (!reference || reference.item_id !== expected.item_id || reference.source_version !== expected.source_version || reference.kind !== expected.kind) return unreadable();
  const operations = v.operations.map(parseOperation);
  if (new Set(operations.map(o => o.verb)).size !== operations.length || operations.some(o => !reference.operations.includes(o.verb) || !expected.operations.includes(o.verb))) return unreadable();
  const d = v.detail;
  if (reference.kind === 'action' && text(d.title) && operations.every((o): o is ActionOperation => o.verb === 'complete-one-action')) return { kind: 'action', reference, title: d.title, operations };
  if (reference.kind === 'reply_draft' && object(d.reply_draft)) {
    const r = d.reply_draft;
    if (text(r.subject) && typeof r.body === 'string' && strings(r.to) && r.to.length === 1 && strings(r.cc) && r.cc.length === 1 && operations.every((o): o is ReplyOperation => ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'].includes(o.verb))) {
      if (operations.some(o => o.args.proposal_id !== operations[0]?.args.proposal_id || o.args.base_version !== operations[0]?.args.base_version || o.verb === 'submit-email-draft' && (o.args.subject !== r.subject || o.args.body !== r.body || JSON.stringify(o.args.to) !== JSON.stringify(r.to) || JSON.stringify(o.args.cc) !== JSON.stringify(r.cc)))) return unreadable();
      return { kind: 'reply_draft', reference, subject: r.subject, body: r.body, to: r.to, cc: r.cc, operations };
    }
  }
  if (reference.kind === 'fact_review' && Array.isArray(d.observations) && operations.every((o): o is FactOperation => o.verb === 'resolve-fact-review')) {
    const observations = d.observations.map((o: unknown): Observation => {
      if (!object(o) || !uuid(o.id) || !text(o.unit) || !object(o.source) || !uuid(o.source.document_ref) || !version(o.source.page_start) || !version(o.source.page_end) || !(o.source.cited_text === null || typeof o.source.cited_text === 'string')) return unreadable();
      return { id: o.id, value: typeof o.value === 'string' ? o.value : JSON.stringify(o.value), unit: o.unit, source: { document_ref: o.source.document_ref, page_start: o.source.page_start, page_end: o.source.page_end, cited_text: o.source.cited_text } };
    });
    return { kind: 'fact_review', reference, observations, canonical: object(d.canonical_fact) ? `${d.canonical_fact.normalized_value ?? 'Schedule'} ${d.canonical_fact.canonical_unit ?? ''}` : 'No canonical value recorded', operations };
  }
  return unreadable();
}
export type ReviewRequest = { verb: Operation['verb']; args: Record<string, unknown> & { idempotency_key: string } };
export function reviewError(error: unknown): { kind: 'conflict' | 'refused' | 'uncertain'; message: string } {
  const code = object(error) && object(error.payload) ? error.payload.error : object(error) ? error.error : null;
  if (code === 'version_conflict' || code === 'home_review_stale') return { kind: 'conflict', message: 'This card changed. Your edits are kept. Review the updated card before submitting again.' };
  if (['human_only_verb_requires_verified_partner', 'partner_required', 'email_draft_not_owner', 'partner_dismissal_required'].includes(String(code))) return { kind: 'refused', message: 'Sign in as the owning verified partner to review this card.' };
  if (['home_review_resolved', 'action_not_open', 'email_draft_already_submitted', 'email_draft_not_pending', 'email_proposal_not_pending'].includes(String(code))) return { kind: 'refused', message: 'This card is already resolved. Refresh the inbox to see its current state.' };
  if (['home_review_not_found', 'home_review_unsupported', 'unknown_tool'].includes(String(code))) return { kind: 'refused', message: 'This card cannot be reviewed here. Open its source record.' };
  return { kind: 'uncertain', message: 'The server did not confirm the result. Retry the same request to check it safely.' };
}
