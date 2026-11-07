const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const invalid = (): never => { throw Error('Mail priorities response unavailable'); };
export const mailKinds = { file_to_deal: 'Email filing', possible_new_deal: 'Possible new deal', next_step: 'Next step', phase_move: 'Deal progress', reply_draft: 'Reply draft' };
export const mailReasons = { recorded_overdue: 'Recorded overdue', recorded_upcoming: 'Recorded upcoming', decision_date_unknown: 'Decision date unknown' };
const verbs = { file_to_deal: 'confirm-email-filing', possible_new_deal: 'confirm-email-filing', next_step: 'confirm-email-next-step', phase_move: 'confirm-email-deal-progress', reply_draft: 'submit-email-draft' };
function parseDecision(value: unknown) {
  if (!object(value) || !uuid(value.proposal_id) || !Number.isSafeInteger(value.version) || typeof value.version !== 'number' || value.version < 1 || value.status !== 'pending' || typeof value.kind !== 'string' || !(value.kind in mailKinds) || !(value.kind in verbs) || !(value.decision_date === null || day(value.decision_date)) || !Array.isArray(value.reason_codes) || value.reason_codes.length !== 1) return invalid();
  const kindEntry = Object.entries(mailKinds).find(([key]) => key === value.kind);
  const kind = kindEntry?.[0];
  const code = value.reason_codes[0];
  const reasonEntry = Object.entries(mailReasons).find(([key]) => key === code);
  const reason = reasonEntry?.[0];
  if (!kindEntry || !reasonEntry || !kind || !reason || !object(value.source) || !uuid(value.source.activity_id) || !Number.isSafeInteger(value.source.version) || typeof value.source.version !== 'number' || value.source.version < 1) return invalid();
  const source = value.source;
  if (source.instant_status === 'unknown' ? source.occurred_at !== null : source.instant_status !== 'known' || typeof source.occurred_at !== 'string' || !Number.isFinite(Date.parse(source.occurred_at)) || new Date(source.occurred_at).toISOString() !== source.occurred_at) return invalid();
  const verb = Object.entries(verbs).find(([key]) => key === kind)?.[1];
  if (!object(value.action) || value.action.verb !== verb || value.action.requires_existing_review !== true || !object(value.action.args) || value.action.args.proposal_id !== value.proposal_id || value.action.args.base_version !== value.version) return invalid();
  return { proposal_id: value.proposal_id, kindLabel: kindEntry[1], reasonLabel: reasonEntry[1], reason, decision_date: value.decision_date, occurred_at: typeof source.occurred_at === 'string' ? source.occurred_at : null };
}
export function parseMailPage(value: unknown) {
  if (!object(value) || value.schema_version !== 'mail-needs-partner.v1' || value.send !== false || !['ready', 'empty', 'unavailable'].includes(String(value.state)) || !Array.isArray(value.items) || value.items.length > 25 || typeof value.more !== 'boolean' || (value.more ? typeof value.next_cursor !== 'string' : value.next_cursor !== null) || !object(value.coverage)) return invalid();
  const coverage = value.coverage;
  if (!['joe', 'dell'].includes(String(coverage.mailbox)) || coverage.scope !== 'recorded_inbound_pending_proposals' || coverage.date_basis !== 'recorded_next_date_utc' || coverage.source !== 'email-proposals.v1' || coverage.pagination !== 'live' || !day(coverage.as_of_day)) return invalid();
  const items = value.items.map(parseDecision);
  if (new Set(items.map(row => row.proposal_id)).size !== items.length || (value.state === 'ready' ? !items.length : items.length || value.more)) return invalid();
  return { state: String(value.state), coverage: { mailbox: String(coverage.mailbox), as_of_day: coverage.as_of_day, scope: coverage.scope, date_basis: coverage.date_basis }, items, more: value.more };
}
export type MailPage = ReturnType<typeof parseMailPage>;
const sibling = (path: string) => import(/* shared session transport */ new URL(path, import.meta.url).href);
export async function readMailPriorities(signal: AbortSignal): Promise<MailPage> {
  const [{ sessionFetch }, { readWithDeadline }] = await Promise.all([sibling('./private-session.js'), sibling('./current-read.mjs')]);
  return readWithDeadline(async (bounded: AbortSignal) => {
    const response = await sessionFetch('/api/v1/intelligence/mail-needs-partner?limit=25', { signal: bounded, credentials: 'same-origin' });
    if ([401, 403].includes(response.status)) throw Object.assign(Error('Sign in to view mail priorities'), { status: response.status });
    if (!response.ok) throw Error('Mail priorities unavailable');
    return parseMailPage(await response.json());
  }, { signal, timeoutMs: 10000 });
}
