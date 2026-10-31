import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Proposal = { assessment_id: string; deal_id: string; deal_name: string; confirm_verb: string; assessment: { action: { id: string; description: string }; update: string; quote?: string | null; reason?: string; review_required: boolean } };
type Request = { assessment_id: string; decision: string; reason: string; idempotency_key: string };
type Decision = { state: 'submitting' | 'unknown' | 'done' | 'refused' | 'not-owner'; request?: Request; message?: string };
type Client = { readDealUpdateReviews: () => Promise<unknown>; reviewDealUpdate: (request: Request) => Promise<unknown> };
type Fault = { status?: number; code?: string; payload?: { error?: string } };
const refusals: Record<string, string> = { overdue_action_changed: 'The task changed. Refresh overdue reviews before deciding again.', assessment_already_reviewed: 'This was already reviewed by the other partner.', partner_required: 'A partner is required to review this task.', assessment_not_found: 'This update is no longer waiting for review.', not_action_owner: 'Only the task owner can review this task.' };

export function mountDealUpdateReviews({ container, client, initialResult, onChange = () => {} }: { container: HTMLElement; client: Client; initialResult?: unknown; onChange?: () => void }) {
  let rows: Proposal[] = [], state: 'loading' | 'ready' | 'error' | 'denied' = 'loading', epoch = 0, disposed = false;
  const decisions = new Map<string, Decision>();
  const win = container.ownerDocument.defaultView;
  let count = win?.matchMedia?.('(max-width: 700px)').matches ? 1 : 2;
  const root = createRoot(container);
  const button = (action: string, label: string, disabled = false) => <button type="button" className="btn home-outline" data-update-action={action} disabled={disabled}>{label}</button>;
  function render() {
    const focused = container.contains(container.ownerDocument.activeElement) ? container.ownerDocument.activeElement as HTMLElement : null;
    const focusId = focused?.closest<HTMLElement>('[data-update-id]')?.dataset.updateId, focusAction = focused?.dataset.updateAction;
    container.setAttribute('aria-busy', String(state === 'loading'));
    flushSync(() => root.render(<>
      <header className="home-panel-head"><h2>Overdue tasks to review</h2>{rows.length > count && <span className="home-list-count">Showing {Math.min(count, rows.length)} of {rows.length}</span>}</header>
      {state === 'denied' ? <p role="status">Sign in to review overdue tasks.</p> : state === 'error' ? <><p role="status">Could not load overdue reviews.</p>{button('refresh', 'Retry overdue reviews')}</> : state === 'loading' ? <p role="status">Loading overdue reviews…</p> : !rows.length ? <p className="home-empty">No overdue reviews.</p> : null}
      {rows.slice(0, count).map(row => {
        const decision = decisions.get(row.assessment_id), pending = decision?.state === 'submitting', unknown = decision?.state === 'unknown';
        const disabled = state !== 'ready' || pending;
        const assessing = ['awaiting_assessment', 'assessment_in_progress', 'interrupted'].includes(row.assessment.reason || '');
        return <article key={row.assessment_id} className="work-card work-card--stack email-proposal" data-update-id={row.assessment_id}>
          <h3 className="work-card-title"><a href={`/deals?deal=${encodeURIComponent(row.deal_id)}`}>{row.deal_name}</a></h3>
          <div className="work-card-meta"><p>Overdue task · {row.assessment.action.description}</p></div>
          <div className="work-card-body"><q>{row.assessment.quote || row.assessment.update}</q><p className="email-change">{assessing ? 'Still assessing this update.' : 'Mark this overdue task as done.'}</p>{decision?.message && <p role="status">{decision.message}</p>}</div>
          <div className="work-card-actions"><div className="email-controls">{assessing || decision?.state === 'done' || decision?.state === 'not-owner' ? null : decision?.state === 'refused' ? button('refresh', 'Refresh overdue reviews') : unknown ? button('replay', 'Check outcome', disabled) : <>{button('resolve', pending ? 'Saving…' : 'Confirm', disabled)}{button('dismiss', 'Dismiss', disabled)}</>}</div></div>
        </article>;
      })}
      {rows.length > count && button('show', `Show ${rows.length - count} more`)}
    </>));
    if (focused) {
      const article = [...container.querySelectorAll<HTMLElement>('[data-update-id]')].find(node => node.dataset.updateId === focusId);
      const target = [...(article || container).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].find(node => node.dataset.updateAction === focusAction) || article?.querySelector<HTMLElement>('button:not(:disabled), a') || container.querySelector<HTMLElement>('button:not(:disabled)');
      target?.focus();
    }
  }
  function retire() { epoch++; rows = []; decisions.clear(); state = 'denied'; render(); }
  async function refresh() {
    if (disposed || state === 'denied') return;
    const ticket = ++epoch; state = 'loading'; render();
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = initialResult ?? await Promise.race([client.readDealUpdateReviews(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Read timed out')), 10_000); })]).finally(() => clearTimeout(timer));
      initialResult = undefined;
      if (disposed || ticket !== epoch) return;
      const data = result as { schema_version?: string; proposals?: unknown } | null;
      const ids = new Set<string>();
      if (data?.schema_version !== 'deal-update-reviews.v1' || !Array.isArray(data.proposals) || data.proposals.length > 200) throw Error('Invalid overdue reviews');
      const next = data.proposals.filter((value: unknown): value is Proposal => {
        const row = value as Proposal | null;
        const valid = row?.assessment_id && !ids.has(row.assessment_id) && row.deal_id && row.deal_name && row.confirm_verb === 'review-deal-update' && row.assessment?.review_required === true && row.assessment.action?.id && typeof row.assessment.action.description === 'string' && typeof row.assessment.update === 'string' && (row.assessment.quote == null || typeof row.assessment.quote === 'string');
        if (valid && row) ids.add(row.assessment_id);
        return Boolean(valid);
      });
      for (const row of rows) if (!ids.has(row.assessment_id) && ['unknown', 'submitting'].includes(decisions.get(row.assessment_id)?.state || '')) next.push(row);
      for (const [id, decision] of decisions) if (decision.state === 'refused') decisions.delete(id);
      rows = next; state = 'ready';
    } catch (error) {
      if (disposed || ticket !== epoch) return;
      const fault = error as Fault;
      if ([401, 403].includes(fault.status || 0) || fault.code === 'session_changed') return retire();
      state = 'error';
    }
    render();
  }
  async function click(event: { target: EventTarget | null }) {
    const control = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-update-action]');
    if (!control || control.disabled || disposed || state === 'denied') return;
    if (control.dataset.updateAction === 'refresh') return refresh();
    if (control.dataset.updateAction === 'show') { count = rows.length; render(); return; }
    if (state !== 'ready') return;
    const row = rows.find(item => item.assessment_id === control.closest<HTMLElement>('[data-update-id]')?.dataset.updateId);
    if (!row) return;
    const prior = decisions.get(row.assessment_id), action = control.dataset.updateAction;
    if (prior?.state === 'submitting' || prior?.state === 'done' || prior?.state === 'unknown' && action !== 'replay') return;
    const request = prior?.request || { assessment_id: row.assessment_id, decision: action || '', reason: action === 'resolve' ? 'The quoted update shows this task was handled.' : 'This update does not establish that the task was handled.', idempotency_key: crypto.randomUUID() };
    decisions.set(row.assessment_id, { state: 'submitting', request }); render();
    try {
      const result = await client.reviewDealUpdate(request) as { ok?: boolean; decision?: string; action_id?: string } | null;
      if (disposed || (state as string) === 'denied') return;
      if (result?.ok !== true || result.decision !== request.decision || result.action_id !== row.assessment.action.id) throw Error('Unverified review outcome');
      decisions.set(row.assessment_id, { state: 'done', message: request.decision === 'resolve' ? 'Task marked done.' : 'Dismissed. Task remains open.' }); render(); onChange();
    } catch (error) {
      if (disposed || (state as string) === 'denied') return;
      const fault = error as Fault;
      if (fault.code === 'session_changed' || fault.status === 401 || (fault.status === 403 && !['partner_required', 'not_action_owner'].includes(fault.payload?.error || ''))) return retire();
      if (fault.payload?.error && fault.payload.error !== 'offline') {
        const code = fault.payload.error;
        decisions.set(row.assessment_id, { state: code === 'not_action_owner' ? 'not-owner' : 'refused', message: refusals[code] || 'Review was refused. Refresh overdue reviews before deciding again.' }); render(); return;
      }
      decisions.set(row.assessment_id, { state: 'unknown', request, message: 'Review outcome unconfirmed. Check outcome to retry the original decision.' }); render();
    }
  }
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  render();
  return { refresh, click, dispose() { disposed = true; epoch++; rows = []; decisions.clear(); flushSync(() => root.unmount()); container.removeEventListener('click', click); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
