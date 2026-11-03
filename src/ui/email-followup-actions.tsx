import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';

type Row = { id: string; version: number; kind: string; deal: string | null; source: { activity_id: string; evidence_quote: string }; suggested_deals?: { deal: string; name: string; reasons: string[] }[] };
type Request = { proposal_id: string; base_version: number; idempotency_key: string; note: string; deal?: string; proposal_digest?: string; correction_reason?: string; disposition?: string; deferred_until?: string };
type Client = {
  getBoard(): Promise<{ deals: { id: string; name: string }[] }>;
  previewEmailFiling(args: { proposal_id: string; deal: string; correction_reason?: string }): Promise<unknown>;
  confirmEmailFiling(args: Request): Promise<unknown>;
  snoozeEmailProposal(args: Request): Promise<unknown>;
  handleEmailProposal(args: Request): Promise<unknown>;
  createDeal(args: { name: string; client: string; idempotency_key: string }): Promise<{ deal_id: string }>;
};
type Method = 'confirmEmailFiling' | 'snoozeEmailProposal' | 'handleEmailProposal';
type Draft = { baseVersion: number; action: 'file' | 'handled' | 'new' | 'defer'; deal: string; dealName: string; note: string; reason: string; when: string; name: string; client: string };
type State = { kind: 'idle' } | { kind: 'editing'; draft: Draft } | { kind: 'preview'; draft: Draft; request: Request }
  | { kind: 'busy' } | { kind: 'unknown'; method: Method; request: Request; createdDraft?: Draft }
  | { kind: 'creation-unknown'; draft: Draft; request: { name: string; client: string; idempotency_key: string } }
  | { kind: 'created'; draft: Draft; message: string }
  | { kind: 'done'; message: string } | { kind: 'refused'; message: string };
export type ActionModel = { state: State };
export const actionModel = (): ActionModel => ({ state: { kind: 'idle' } });
const zone = 'America/Chicago';
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
function localParts(date: Date) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function tomorrowCentral(now: Date) {
  const date = new Date(`${localParts(now).slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.toISOString().slice(0, 10)}T09:00`;
}
export function centralInstant(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error('Choose a valid return time.');
  const wall = Date.parse(`${value}:00Z`);
  const candidates = [5, 6].map(offset => new Date(wall + offset * 3600000)).filter(date => localParts(date) === value);
  if (candidates.length !== 1) throw Error('Choose an unambiguous Central time outside the daylight-saving clock change.');
  const chosen = candidates[0];
  if (!chosen) throw Error('Choose a valid return time.');
  return chosen.toISOString();
}
const returnTime = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) + ' America/Chicago';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw Error('Unconfirmed response');
  return Object.fromEntries(Object.entries(value));
}
export function mountEmailActions(host: HTMLElement, row: Row, client: Client, model: ActionModel, changed: (message?: string) => void, denied: () => void, now = () => new Date()) {
  const root = createRoot(host);
  let disposed = false, enabled = true;
  const current = () => !disposed;
  const button = (action: string, label: string) => <button type="button" className="btn home-outline" data-followup={action}>{label}</button>;
  const locked = () => !['idle', 'refused'].includes(model.state.kind);
  const pending = () => ['busy', 'unknown', 'creation-unknown', 'created'].includes(model.state.kind);
  const parentButtons = new Map<HTMLButtonElement, boolean>();
  function syncControls() {
    for (const [button, disabled] of parentButtons) {
      if (!locked()) button.disabled = disabled;
      if (!locked() || !button.isConnected) parentButtons.delete(button);
    }
    if (locked()) host.closest('article')?.querySelectorAll<HTMLButtonElement>('[data-email-action]').forEach(button => {
      if (!parentButtons.has(button)) parentButtons.set(button, button.disabled);
      button.disabled = true;
    });
  }
  function render() {
    if (!current()) return;
    const state = model.state;
    let content: ReactNode;
    if (state.kind === 'idle') content = <>
      {['file_to_deal', 'possible_new_deal'].includes(row.kind) && <>{button('file', 'File to existing deal')}{button('new', 'New deal')}</>}
      {['file_to_deal', 'possible_new_deal', 'next_step', 'reply_draft'].includes(row.kind) && button('handled', 'Already handled')}
      {button('defer', 'Not now')}
    </>;
    else if (state.kind === 'editing') {
      const draft = state.draft, matching = ['file_to_deal', 'possible_new_deal'].includes(row.kind);
      const field = (key: string, label: string, value: string, type = 'text') => <label>{label}<input data-field={key} type={type} maxLength={key === 'reason' ? 500 : undefined} defaultValue={value}/></label>;
      content = <form className="email-action-form">
        <h3>{({ file: 'File to existing deal', new: 'New deal', handled: 'Already handled', defer: 'Not now' })[draft.action]}</h3>
        {draft.action === 'defer' ? <>{field('when', 'Return time in America/Chicago', draft.when, 'datetime-local')}<p data-return-time=""/></>
          : draft.action === 'new' ? <>{field('name', 'Deal name', draft.name)}{field('client', 'Existing client reference or exact name', draft.client)}</>
            : matching ? <>
              <label>Search existing deals<input type="search" data-deal-search=""/></label>
              <label>Selected deal<select aria-label="Selected deal" data-field="deal" defaultValue=""><option value="">Choose a deal</option></select></label>
              <div data-deal-reasons=""/>
            </> : <p>Mark this follow-up handled. Nothing will be sent.</p>}
        {matching && draft.action !== 'defer' && field('reason', 'Reason for changing the client or filed deal, if needed', draft.reason)}
        <label>Optional note<textarea data-field="note" maxLength={2000} defaultValue={draft.note}/></label>
        <button className="btn home-outline" type="submit">{draft.action === 'defer' ? 'Defer follow-up' : matching ? 'Review selected deal' : 'Confirm handled'}</button>
        {button('cancel', 'Cancel')}<p role="status" data-action-message=""/>
      </form>;
    } else if (state.kind === 'preview') content = <>
      <p>Selected deal: <a href={`/deals?deal=${encodeURIComponent(state.request.deal || '')}`}>{state.draft.dealName || state.request.deal}</a></p>
      <p>{state.draft.note}</p><p>Confirm {state.draft.action === 'handled' ? 'handled and file' : 'filing'} to this selected deal.</p>
      {button('confirm', 'Confirm filing')}{button('cancel', 'Cancel')}
    </>;
    else if (state.kind === 'created') content = <><p role="status">{state.message}</p><a href={`/deals?deal=${encodeURIComponent(state.draft.deal)}`}>Open created deal</a>{button('preview-created', 'Review created deal')}</>;
    else if (state.kind === 'busy') content = <p role="status">Saving…</p>;
    else if (state.kind === 'unknown' || state.kind === 'creation-unknown') content = <><p role="status">Outcome unknown. Check outcome to recover the original request.</p>{button('replay', 'Check outcome')}</>;
    else content = <><p role="status">{state.message}</p>{state.kind === 'refused' && button('refresh', 'Refresh and review')}</>;
    flushSync(() => root.render(content));
    if (state.kind === 'editing') {
      if (['file_to_deal', 'possible_new_deal'].includes(row.kind) && ['file', 'handled'].includes(state.draft.action)) void loadDeals(state.draft);
      updateTime(state.draft);
    }
    syncControls();
  }
  function message(text: string) { const node = host.querySelector('[data-action-message]'); if (node) node.textContent = text; }
  function updateTime(draft: Draft) {
    const node = host.querySelector('[data-return-time]');
    if (node) { try { node.textContent = `Returns ${returnTime(centralInstant(draft.when))}`; } catch (error) { node.textContent = error instanceof Error ? error.message : 'Choose a valid return time.'; } }
  }
  async function loadDeals(draft: Draft) {
    try {
      const board = await client.getBoard();
      if (!current() || model.state.kind !== 'editing' || model.state.draft !== draft) return;
      const select = host.querySelector('select'), search = host.querySelector<HTMLInputElement>('[data-deal-search]');
      if (!select || !search) return;
      const suggested = row.suggested_deals || [];
      const choices = [...suggested.map(item => ({ id: item.deal, name: item.name })), ...board.deals].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
      function options() {
        if (!select || !search) return;
        select.innerHTML = '<option value="">Choose a deal</option>' + choices.filter(item => item.id === draft.deal || item.name.toLowerCase().includes(search.value.toLowerCase())).map(item => `<option value="${escape(item.id)}"${item.id === draft.deal ? ' selected' : ''}>${escape(item.name)}</option>`).join('');
      }
      options(); search.addEventListener('input', options);
      draft.dealName = choices.find(item => item.id === draft.deal)?.name || '';
      select.addEventListener('change', () => { draft.dealName = choices.find(item => item.id === select.value)?.name || ''; });
      const reasons = host.querySelector('[data-deal-reasons]');
      if (reasons) reasons.innerHTML = suggested.map(item => `<p><a href="/deals?deal=${encodeURIComponent(item.deal)}">${escape(item.name)}</a> · ${escape(item.reasons.join('; '))}</p>`).join('') || '<p>No suggested deals. Search all accessible deals.</p>';
    } catch { if (current()) message('Could not load deals. Cancel and try again.'); }
  }
  async function failure(error: unknown, fallback: State, createdDraft?: Draft) {
    if (!current()) return;
    const value = error && typeof error === 'object' ? record(error) : {};
    if ([401, 403].includes(Number(value.status)) || value.code === 'session_changed') { denied(); return; }
    const payload = value.payload && typeof value.payload === 'object' ? record(value.payload) : {};
    model.state = typeof payload.error === 'string' && !value.pendingRequest ? createdDraft ? { kind: 'created', draft: createdDraft, message: `Deal created. Filing refused (${payload.error}). Review the created deal before continuing.` } : { kind: 'refused', message: `Action refused (${payload.error}). Refresh and review before trying again.` } : fallback;
    render();
  }
  async function write(method: Method, request: Request, createdDraft?: Draft) {
    model.state = { kind: 'busy' }; render();
    try {
      const receipt = record(await client[method](request));
      if (!current()) return;
      if (receipt.ok !== true || receipt.proposal_id !== row.id || receipt.version !== request.base_version + 1 || receipt.note !== request.note) throw Error('Unconfirmed action receipt');
      if (method === 'snoozeEmailProposal') {
        if (receipt.status !== 'pending' || receipt.disposition !== 'deferred' || typeof receipt.deferred_until !== 'string' || Date.parse(receipt.deferred_until) !== Date.parse(request.deferred_until || '')) throw Error('Unconfirmed deferral receipt');
        model.state = { kind: 'done', message: `Returns ${returnTime(receipt.deferred_until)}.` };
      } else {
        if (receipt.status !== 'confirmed' || receipt.disposition !== (request.disposition || 'handled') || (method === 'confirmEmailFiling' && (receipt.deal !== request.deal || receipt.activity_id !== row.source.activity_id))) throw Error('Unconfirmed filing receipt');
        model.state = { kind: 'done', message: request.disposition === 'filed' ? 'Filed to the selected deal.' : 'Marked handled.' };
      }
      render(); changed(model.state.message);
    } catch (error) { await failure(error, { kind: 'unknown', method, request, ...(createdDraft ? { createdDraft } : {}) }, createdDraft); }
  }
  async function preview(draft: Draft) {
    const request = { proposal_id: row.id, base_version: draft.baseVersion, deal: draft.deal, note: draft.note, disposition: draft.action === 'handled' ? 'handled' : 'filed', ...(draft.reason.trim() ? { correction_reason: draft.reason.trim() } : {}), idempotency_key: crypto.randomUUID() };
    model.state = { kind: 'busy' }; render();
    try {
      const shown = record(await client.previewEmailFiling({ proposal_id: row.id, deal: draft.deal, ...(draft.reason.trim() ? { correction_reason: draft.reason.trim() } : {}) }));
      if (!current()) return;
      if (shown.contract !== 'email-followups.v2' || shown.proposal_id !== row.id || shown.deal !== draft.deal || shown.base_version !== draft.baseVersion || shown.activity_id !== row.source.activity_id || shown.evidence_quote !== row.source.evidence_quote || shown.requires_confirmation !== true || typeof shown.proposal_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(shown.proposal_digest)) throw Error('Invalid exact-target preview');
      model.state = { kind: 'preview', draft, request: { ...request, proposal_digest: shown.proposal_digest } }; render();
    } catch (error) {
      if (draft.action === 'new' && current()) { model.state = { kind: 'created', draft, message: 'Deal created. Filing was not confirmed. Review the created deal before continuing.' }; render(); }
      else await failure(error, { kind: 'refused', message: 'Could not preview the selected deal. Refresh and review again.' });
    }
  }
  async function create(draft: Draft, request: { name: string; client: string; idempotency_key: string }) {
    model.state = { kind: 'busy' }; render();
    try {
      const result = await client.createDeal(request);
      if (!current()) return;
      if (!result.deal_id) throw Error('Unconfirmed deal creation');
      await preview({ ...draft, deal: result.deal_id, dealName: draft.name });
    } catch (error) { await failure(error, { kind: 'creation-unknown', draft, request }); }
  }
  const click = (event: Event) => {
    if (!(event.target instanceof host.ownerDocument.defaultView!.Element)) return;
    const action = event.target.closest<HTMLElement>('[data-followup]')?.dataset.followup;
    if (!enabled) return;
    const state = model.state;
    if (action === 'refresh') { model.state = { kind: 'idle' }; changed(); render(); }
    if (action === 'cancel') { model.state = state.kind === 'preview' && state.draft.action === 'new' ? { kind: 'created', draft: state.draft, message: 'Deal created. Filing cancelled. Review the created deal before continuing.' } : { kind: 'idle' }; render(); }
    if (action === 'preview-created' && state.kind === 'created') void preview(state.draft);
    if (action === 'confirm' && state.kind === 'preview') void write('confirmEmailFiling', state.request, state.draft.action === 'new' ? state.draft : undefined);
    if (action === 'replay' && state.kind === 'unknown') void write(state.method, state.request, state.createdDraft);
    if (action === 'replay' && state.kind === 'creation-unknown') void create(state.draft, state.request);
    if (state.kind === 'idle' && ['file', 'new', 'handled', 'defer'].includes(action || '')) {
      if (action !== 'file' && action !== 'new' && action !== 'handled' && action !== 'defer') return;
      model.state = { kind: 'editing', draft: { baseVersion: row.version, action, deal: row.deal || '', dealName: '', note: '', reason: '', when: tomorrowCentral(now()), name: '', client: '' } }; render();
      host.querySelector<HTMLElement>('input,textarea')?.focus();
    }
  };
  const input = (event: Event) => {
    const target = event.target;
    if (!(target instanceof host.ownerDocument.defaultView!.HTMLElement) || model.state.kind !== 'editing') return;
    if (!(target instanceof host.ownerDocument.defaultView!.HTMLInputElement || target instanceof host.ownerDocument.defaultView!.HTMLTextAreaElement || target instanceof host.ownerDocument.defaultView!.HTMLSelectElement)) return;
    const key = target.dataset.field, draft = model.state.draft;
    if (key === 'deal' || key === 'note' || key === 'reason' || key === 'when' || key === 'name' || key === 'client') draft[key] = target.value;
    updateTime(draft);
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (!enabled || model.state.kind !== 'editing') return;
    const draft = model.state.draft;
    const request = { proposal_id: row.id, base_version: draft.baseVersion, note: draft.note, idempotency_key: crypto.randomUUID() };
    if (draft.action === 'defer') {
      try { const until = centralInstant(draft.when); if (Date.parse(until) <= now().getTime()) throw Error('Choose a future return time.'); void write('snoozeEmailProposal', { ...request, deferred_until: until }); }
      catch (error) { message(error instanceof Error ? error.message : 'Choose a valid return time.'); }
    } else if (draft.action === 'new') {
      if (!draft.name.trim() || !draft.client.trim()) { message('Enter a deal name and existing client.'); return; }
      void create(draft, { name: draft.name.trim(), client: draft.client.trim(), idempotency_key: crypto.randomUUID() });
    } else if (['file_to_deal', 'possible_new_deal'].includes(row.kind)) {
      if (!draft.deal) { message('Choose the deal before continuing.'); return; }
      void preview(draft);
    } else void write('handleEmailProposal', request);
  };
  host.addEventListener('click', click); host.addEventListener('input', input); host.addEventListener('change', input); host.addEventListener('submit', submit);
  render();
  return { locked, pending, done: () => model.state.kind === 'done', update(next: Row, ready: boolean) { row = next; enabled = ready; host.inert = !ready; syncControls(); }, dispose() { disposed = true; flushSync(() => root.unmount()); host.removeEventListener('click', click); host.removeEventListener('input', input); host.removeEventListener('change', input); host.removeEventListener('submit', submit); } };
}
