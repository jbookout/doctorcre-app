import { Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Assessment = { review_required: boolean; reason?: string; action: { id: string; description: string }; update: string; quote?: string | null };
type Proposal = { assessment_id: string; deal_id: string; deal_name: string; confirm_verb: string; assessment: Assessment; automatic?: false };
type Automatic = { assessment_id: string; deal_id: string; deal_name: string; action_title: string; quote: string; resolved_at: string; undo_possible: boolean; automatic: true };
type Row = Proposal | Automatic;
type Response = { schema_version: string; proposals: Proposal[]; automatic_resolutions?: Omit<Automatic, 'automatic'>[] };
type Request = { assessment_id: string; decision: string; reason: string; idempotency_key: string };
type Decision = { state: 'submitting' | 'unknown' | 'done' | 'refused' | 'not-owner'; request?: Request; message?: string };
type RpcError = { status?: number; code?: string; payload?: { error?: string } };
type Options = {
  container: HTMLElement;
  client: { readDealUpdateReviews(): Promise<Response>; reviewDealUpdate(request: Request): Promise<{ ok: boolean; decision: string; action_id: string }> };
  initialResult?: Response;
  onChange?: () => void;
  sourceTime(value: string, now: undefined, fallback: string): string;
  readWithDeadline<T>(read: () => Promise<T>, options: { timeoutMs: number }): Promise<T>;
  uuidv4(): string;
};

export function mountDealUpdateReviews({ container, client, initialResult, onChange = () => {}, sourceTime, readWithDeadline, uuidv4 }: Options) {
  let rows: Row[] = [], state: 'loading' | 'ready' | 'error' | 'denied' = 'loading', epoch = 0, disposed = false;
  const decisions = new Map<string, Decision>();
  const win = container.ownerDocument.defaultView;
  let count = win?.matchMedia?.('(max-width: 700px)').matches ? 1 : 2;
  const refusals: Record<string, string> = { overdue_action_changed: 'The task changed. Refresh overdue reviews before deciding again.', assessment_already_reviewed: 'This was already reviewed by the other partner.', partner_required: 'A partner is required to review this task.', newer_change_exists: "A newer change was made to this task, so this can't be undone here.", assessment_not_found: 'This update is no longer waiting for review.', not_action_owner: 'Only the task owner can review this task.' };
  const root = createRoot(container);
  const button = (action: string, label: string, disabled = false) => <button type="button" className="btn home-outline" data-update-action={action} disabled={disabled}>{label}</button>;
  function render() {
    const active = container.ownerDocument.activeElement;
    const focused = active instanceof (win?.HTMLElement || HTMLElement) && container.contains(active) ? active : null;
    const focusId = focused?.closest<HTMLElement>('[data-update-id]')?.dataset.updateId, focusAction = focused?.dataset.updateAction;
    container.setAttribute('aria-busy', String(state === 'loading'));
    flushSync(() => root.render(<>
      <header className="home-panel-head"><h2>Overdue tasks to review</h2>{rows.length > count && <span className="home-list-count">Showing {Math.min(count, rows.length)} of {rows.length}</span>}</header>
      {state === 'denied' ? <p role="status">Sign in to review overdue tasks.</p> : state === 'error' ? <><p role="status">Could not load overdue reviews.</p>{button('refresh', 'Retry overdue reviews')}</> : state === 'loading' ? <p role="status">Loading overdue reviews…</p> : !rows.some(row => !row.automatic) ? <p className="home-empty">No overdue reviews.</p> : null}
      {rows.slice(0, count).map((row, index) => {
        const decision = decisions.get(row.assessment_id), pending = decision?.state === 'submitting', unknown = decision?.state === 'unknown';
        const disabled = state !== 'ready' || pending;
        const automatic = row.automatic;
        const assessing = !automatic && ['awaiting_assessment', 'assessment_in_progress', 'interrupted'].includes(row.assessment.reason || '');
        return <Fragment key={row.assessment_id}>{automatic && (index === 0 || !rows[index - 1]?.automatic) && <div className="detail-section"><h3>Closed automatically</h3></div>}<article className="work-card work-card--stack email-proposal" data-update-id={row.assessment_id}>
          <h3 className="work-card-title"><a href={`/deals?deal=${encodeURIComponent(row.deal_id)}`}>{row.deal_name}</a></h3>
          <div className="work-card-meta">{automatic ? <><p>Task · {row.action_title}</p><p>Closed · {sourceTime(row.resolved_at, undefined, 'Date unavailable')}</p></> : <p>Overdue task · {row.assessment.action.description}</p>}</div>
          <div className="work-card-body"><q>{automatic ? row.quote : row.assessment.quote || row.assessment.update}</q>{!automatic && <p className="email-change">{assessing ? 'Still assessing this update.' : 'Mark this overdue task as done.'}</p>}{decision?.message && <p role="status">{decision.message}</p>}</div>
          <div className="work-card-actions"><div className="email-controls">{assessing || decision?.state === 'done' || decision?.state === 'not-owner' ? null : decision?.state === 'refused' ? button('refresh', 'Refresh overdue reviews') : unknown ? button('replay', 'Check outcome', disabled) : automatic ? row.undo_possible ? button('undo', pending ? 'Saving…' : 'Undo', disabled) : null : <>{button('resolve', pending ? 'Saving…' : 'Confirm', disabled)}{button('dismiss', 'Dismiss', disabled)}</>}</div></div>
        </article></Fragment>;
      })}
      {rows.length > count && button('show', `Show ${rows.length - count} more`)}
    </>));
    if (focused) {
      const article = [...container.querySelectorAll<HTMLElement>('[data-update-id]')].find(node => node.dataset.updateId === focusId);
      const target = [...(article || container).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].find(node => node.dataset.updateAction === focusAction) || article?.querySelector<HTMLElement>('button:not(:disabled), a') || container.querySelector<HTMLElement>('button:not(:disabled)');
      target?.focus();
    }
  }
  const retired = () => disposed || state === 'denied';
  function retire() { epoch++; rows = []; decisions.clear(); state = 'denied'; render(); }
  async function refresh() {
    if (disposed || state === 'denied') return;
    const ticket = ++epoch;
    state = 'loading'; render();
    try {
      const result = initialResult ?? await readWithDeadline(() => client.readDealUpdateReviews(), { timeoutMs: 10_000 });
      initialResult = undefined;
      if (disposed || ticket !== epoch) return;
      const ids = new Set<string>();
      if (result?.schema_version !== 'deal-update-reviews.v1' || !Array.isArray(result.proposals) || result.proposals.length > 200) throw Error('Invalid overdue reviews');
      const next: Row[] = result.proposals.filter(row => {
        const valid = row?.assessment_id && !ids.has(row.assessment_id) && row.deal_id && row.deal_name
          && row.confirm_verb === 'review-deal-update' && row.assessment?.review_required === true
          && row.assessment.action?.id && typeof row.assessment.action.description === 'string'
          && typeof row.assessment.update === 'string' && (row.assessment.quote == null || typeof row.assessment.quote === 'string');
        if (valid) ids.add(row.assessment_id);
        return valid;
      });
      if (result.automatic_resolutions != null && !Array.isArray(result.automatic_resolutions)) throw Error('Invalid automatic resolutions');
      for (const row of result.automatic_resolutions || []) {
        if (row?.assessment_id && !ids.has(row.assessment_id) && row.deal_id && row.deal_name && (['action_title', 'quote', 'resolved_at'] as const).every(key => typeof row[key] === 'string') && typeof row.undo_possible === 'boolean') {
          ids.add(row.assessment_id); next.push({ ...row, automatic: true });
        }
      }
      for (const row of rows) if (!ids.has(row.assessment_id) && ['unknown', 'submitting'].includes(decisions.get(row.assessment_id)?.state || '')) next.push(row);
      next.sort((a, b) => (a.automatic ? 1 : 0) - (b.automatic ? 1 : 0));
      for (const [id, decision] of decisions) if (decision.state === 'refused') decisions.delete(id);
      rows = next; state = 'ready';
    } catch (caught) {
      const error = caught as RpcError;
      if (disposed || ticket !== epoch) return;
      if ([401, 403].includes(error.status || 0) || error.code === 'session_changed') return retire();
      state = 'error';
    }
    render();
  }
  async function click(event: { target: EventTarget | null }) {
    const target = event.target;
    const control = target instanceof (win?.Element || Element) ? target.closest<HTMLButtonElement>('[data-update-action]') : null;
    if (!control || control.disabled || disposed || state === 'denied') return;
    if (control.dataset.updateAction === 'refresh') return refresh();
    if (control.dataset.updateAction === 'show') { count = rows.length; render(); return; }
    if (state !== 'ready') return;
    const row = rows.find(item => item.assessment_id === control.closest<HTMLElement>('[data-update-id]')?.dataset.updateId);
    if (!row) return;
    const prior = decisions.get(row.assessment_id), action = control.dataset.updateAction;
    if (prior?.state === 'submitting' || prior?.state === 'done' || prior?.state === 'unknown' && action !== 'replay') return;
    const request: Request = prior?.request || { assessment_id: row.assessment_id, decision: action || '',
      reason: action === 'undo' ? 'This task should remain open.' : action === 'resolve' ? 'The quoted update shows this task was handled.' : 'This update does not establish that the task was handled.', idempotency_key: uuidv4() };
    decisions.set(row.assessment_id, { state: 'submitting', request }); render();
    try {
      const result = await client.reviewDealUpdate(request);
      if (retired()) return;
      if (result?.ok !== true || result.decision !== request.decision || (row.automatic ? !result.action_id : result.action_id !== row.assessment.action.id)) throw Error('Unverified review outcome');
      decisions.set(row.assessment_id, { state: 'done', message: request.decision === 'undo' ? 'Task reopened.' : request.decision === 'resolve' ? 'Task marked done.' : 'Dismissed. Task remains open.' });
      render(); onChange();
    } catch (caught) {
      const error = caught as RpcError;
      if (retired()) return;
      if (error.code === 'session_changed' || error.status === 401 || (error.status === 403 && !['partner_required', 'not_action_owner'].includes(error.payload?.error || ''))) return retire();
      if (error.payload?.error && error.payload.error !== 'offline') {
        const code = error.payload.error;
        decisions.set(row.assessment_id, { state: code === 'not_action_owner' ? 'not-owner' : 'refused', message: refusals[code] || 'Review was refused. Refresh overdue reviews before deciding again.' });
        render(); return;
      }
      decisions.set(row.assessment_id, { state: 'unknown', request, message: 'Review outcome unconfirmed. Check outcome to retry the original decision.' });
      render();
    }
  }
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  render();
  return { refresh, click, dispose() { disposed = true; epoch++; rows = []; decisions.clear(); flushSync(() => root.unmount()); container.removeEventListener('click', click); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
