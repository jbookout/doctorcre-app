import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Filters = { vertical?: string; city?: string; state?: string };
type Client = { getIdealClientProfile(filters: Filters): Promise<unknown> };
type Profile = { vertical: string | null; deal_type: string | null; city: string | null; state: string | null;
  won_deals: number; clients: number; hypothesis: string; evidence: { deal_id: string; closed_on: string; deal_name: string | null }[] };
type CloseWindow = { from: string; through: string };
function calendarDate(value: string): boolean {
  const date = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value;
}
type View = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; profiles: Profile[] } | { kind: 'error'; message: string };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid historical fit');
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid historical fit');
  return value;
}
function dimension(value: unknown): string | null { return value === null || value === '' ? null : text(value); }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid historical count');
  return value;
}
function parse(value: unknown): Profile[] {
  const payload = object(value);
  if (payload.schema_version !== 'ideal-client-profile.v1' || payload.coverage !== 'recorded_closed_won_only' || !Array.isArray(payload.profiles) || payload.profiles.length > 1000) throw new Error('Invalid historical coverage');
  return payload.profiles.map(value => {
    const row = object(value);
    const won_deals = count(row.won_deals), clients = count(row.clients);
    if (clients > won_deals || !Array.isArray(row.evidence) || row.evidence.length !== won_deals) throw new Error('Invalid historical evidence');
    const evidence = row.evidence.map(value => {
      const entry = object(value), deal_id = text(entry.deal_id), closed_on = text(entry.closed_on);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deal_id) || !calendarDate(closed_on)) throw new Error('Invalid completed deal');
      if (entry.deal_name != null && typeof entry.deal_name !== 'string') throw new Error('Invalid deal name');
      const deal_name = typeof entry.deal_name === 'string' ? entry.deal_name.trim() || null : null;
      return { deal_id, closed_on, deal_name };
    });
    if (new Set(evidence.map(entry => entry.deal_id)).size !== won_deals) throw new Error('Duplicate historical evidence');
    return { vertical: dimension(row.vertical), deal_type: dimension(row.deal_type), city: dimension(row.city), state: dimension(row.state),
      won_deals, clients, evidence, hypothesis: text(row.hypothesis) };
  });
}
export function mountIdealClientProfile(host: HTMLElement, client: Client) {
  const root = createRoot(host);
  let view: View = { kind: 'idle' }, filters: Filters = {}, epoch = 0, generation = 0;
  let selectedType: string | null | undefined;
  let selectionReset = false;
  let window: CloseWindow = { from: '', through: '' }, draft: CloseWindow = { ...window }, windowError = '';
  function resetWindow() { window = { from: '', through: '' }; draft = { ...window }; windowError = ''; }
  let lifecycle: 'active' | 'retired' | 'disposed' = 'active';
  async function load() {
    if (lifecycle !== 'active') return;
    const request = ++epoch;
    view = { kind: 'loading' }; render();
    try {
      const profiles = parse(await client.getIdealClientProfile(filters));
      if (lifecycle !== 'active' || request !== epoch) return;
      selectionReset = selectedType !== undefined && !profiles.some(row => row.deal_type === selectedType);
      if (selectionReset) selectedType = undefined;
      view = { kind: 'ready', profiles };
    } catch (error) {
      if (lifecycle !== 'active' || request !== epoch) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      view = { kind: 'error', message: code === 'client_profile_limit_exceeded'
        ? 'Narrow vertical, city or state filters. The server refused more than 1000 groups; no partial history is shown.'
        : ['not_authenticated', 'forbidden', 'unauthorized'].includes(String(code))
          ? 'Historical client fit was refused. Sign in again to read history.'
          : 'Historical client fit unavailable. Refresh to try again.' };
    }
    render();
  }
  function clear() { if (lifecycle !== 'active') return; ++epoch; ++generation; filters = {}; resetWindow(); selectedType = undefined; selectionReset = false; view = { kind: 'idle' }; render(); }
  function retire() {
    if (lifecycle !== 'active') return;
    lifecycle = 'retired'; ++epoch; filters = {}; resetWindow(); selectedType = undefined; selectionReset = false; view = { kind: 'idle' }; render();
  }
  function render() {
    if (lifecycle === 'disposed') return;
    const profiles = view.kind === 'ready' ? view.profiles : [];
    const types = [...new Set(profiles.map(row => row.deal_type))];
    const matching = profiles.filter(row => selectedType === undefined || row.deal_type === selectedType).map(row => ({
      ...row, evidence: row.evidence.filter(entry => (!window.from || entry.closed_on >= window.from) && (!window.through || entry.closed_on <= window.through))
    })).filter(row => row.evidence.length > 0);
    flushSync(() => root.render(<section className="card glass historical-fit" aria-label="Historical client fit">
      {lifecycle === 'retired' ? <p role="status">Historical client fit unavailable. Sign in again to read history.</p> : <details key={generation} onToggle={event => { if (event.currentTarget.open && view.kind === 'idle') void load(); }}>
        <summary>Historical client fit</summary>
        <p>Loaded recorded completed wins only, grouped by vertical, deal type, transaction city and client state. Missing dimensions are unrecorded.</p>
        <p>Historical fit, not a prediction or qualification rule.</p>
        <form onSubmit={event => {
          event.preventDefault(); if (lifecycle !== 'active') return; const data = new FormData(event.currentTarget); filters = {};
          for (const key of ['vertical', 'city', 'state'] as const) { const value = String(data.get(key) || ''); if (value) filters[key] = value; }
          void load();
        }}>
          <label>Vertical<input name="vertical" maxLength={200} /></label>
          <label>City<input name="city" maxLength={200} /></label>
          <label>State<input name="state" pattern="[A-Z]{2}" maxLength={2} title="Two uppercase state letters" /></label>
          <button type="submit">Apply filters</button><button type="button" onClick={() => void load()}>Refresh history</button>
        </form>
        {view.kind === 'loading' && <p role="status">Loading completed wins…</p>}
        {view.kind === 'error' && <p role="alert">{view.message}</p>}
        {view.kind === 'ready' && <>
          <label>Deal type<select aria-label="Deal type" value={selectedType === undefined ? '' : JSON.stringify(selectedType)} onChange={event => {
            if (lifecycle !== 'active') return;
            selectedType = types.find(type => JSON.stringify(type) === event.currentTarget.value);
            selectionReset = false; render();
          }}>
            <option value="">All deal types</option>
            {types.map(type => <option key={JSON.stringify(type)} value={JSON.stringify(type)}>{type ?? 'Unrecorded'}</option>)}
          </select></label>
          <form noValidate onSubmit={event => {
            event.preventDefault(); if (lifecycle !== 'active') return;
            const inputs = event.currentTarget.querySelectorAll('input');
            if ([...inputs].some(input => input.validity.badInput) || [draft.from, draft.through].some(value => value && !calendarDate(value))) {
              windowError = 'Enter real calendar dates. The last valid window is still shown.';
            } else if (draft.from && draft.through && draft.from > draft.through) {
              windowError = 'Closed from must be on or before Closed through. The last valid window is still shown.';
            } else { window = { ...draft }; windowError = ''; }
            render();
          }}>
            <label>Closed from<input type="date" value={draft.from} onChange={event => { draft = { ...draft, from: event.currentTarget.value }; }} /></label>
            <label>Closed through<input type="date" value={draft.through} onChange={event => { draft = { ...draft, through: event.currentTarget.value }; }} /></label>
            <button type="submit">Apply date window</button>
            <button type="button" onClick={() => { if (lifecycle !== 'active') return; resetWindow(); render(); }}>Clear date window</button>
          </form>
          {windowError && <p role="alert">{windowError}</p>}
          <p>Closing date window applies to loaded recorded wins only. Full-history counts are unchanged. Per-win client identities are unavailable.</p>
          <p role="status">{matching.length} of {profiles.length} loaded historical groups match. {selectionReset && 'The selected deal type is no longer available. Showing All deal types.'}</p>
        </>}
        {view.kind === 'ready' && (matching.length ? <div className="chart-scroll" tabIndex={0} role="region" aria-label="Historical client fit table">
          <table><caption>Completed wins and distinct clients in each historical group</caption>
            <thead><tr><th scope="col">Vertical</th><th scope="col">Deal type</th><th scope="col">Transaction city / client state</th><th scope="col">Full-history wins</th><th scope="col">Full-history distinct clients</th><th scope="col">Matching evidence</th><th scope="col">Completed deal evidence</th></tr></thead>
            <tbody>{matching.map(row => <tr key={JSON.stringify([row.vertical, row.deal_type, row.city, row.state])}>
              <td data-label="Vertical">{row.vertical || 'Unrecorded'}</td><td data-label="Deal type">{row.deal_type || 'Unrecorded'}</td><td data-label="Transaction city / client state">{row.city || 'Unrecorded'} / {row.state || 'Unrecorded'}</td>
              <td data-label="Full-history wins">{row.won_deals} {row.won_deals === 1 ? 'deal' : 'deals'}</td><td data-label="Full-history distinct clients">{row.clients} {row.clients === 1 ? 'client' : 'clients'}</td>
              <td data-label="Matching evidence">{row.evidence.length}</td>
              <td data-label="Completed deal evidence"><details><summary>Wins ({row.evidence.length})</summary><ul>{row.evidence.map(entry => <li key={entry.deal_id}>
                <a href={`/deals?deal=${encodeURIComponent(entry.deal_id)}`} title={`Deal ${entry.deal_id}`}>{entry.deal_name || 'Won deal'} · <time dateTime={entry.closed_on}>{entry.closed_on}</time></a>
              </li>)}</ul><p>{row.hypothesis}</p></details></td>
            </tr>)}</tbody>
          </table></div> : <p>No completed wins match these filters. No historical client profile can be inferred.</p>)}
      </details>}
    </section>));
  }
  const win = host.ownerDocument.defaultView;
  win?.addEventListener('doctorcre-session-invalidated', retire);
  win?.addEventListener('pagehide', clear);
  render();
  return { clear, dispose() { if (lifecycle === 'disposed') return; lifecycle = 'disposed'; filters = {}; resetWindow(); selectedType = undefined; selectionReset = false; view = { kind: 'idle' }; ++epoch; win?.removeEventListener('doctorcre-session-invalidated', retire); win?.removeEventListener('pagehide', clear); flushSync(() => root.unmount()); } };
}
