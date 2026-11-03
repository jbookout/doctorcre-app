import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const conditions = ['soft', 'balanced', 'tight', 'unknown', 'conflicting'] as const;
type Condition = typeof conditions[number];
type Evidence = { flag_id: string; condition: Condition; source: string; observed_at: string; expires_on: string | null; expired: boolean; current: boolean };
type Market = { city: string; state: string; condition: Condition; evidence: Evidence[] };
type Filters = { city?: string; state?: string; vertical?: string };
type Client = { getTerritoryStateBoard(filters: Filters): Promise<unknown> };
type View = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; rows: Market[] };
const labels: Record<Condition, string> = { soft: 'Soft', balanced: 'Balanced', tight: 'Tight', unknown: 'Unknown', conflicting: 'Conflicting' };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid territory evidence');
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid territory evidence');
  return value;
}
function condition(value: unknown): Condition {
  for (const entry of conditions) if (value === entry) return entry;
  throw new Error('Invalid territory condition');
}
function parse(value: unknown): Market[] {
  const board = object(value);
  if (board.schema_version !== 'territory-state-board.v1' || board.coverage !== 'recorded_geographies_only' || !Array.isArray(board.submarkets) || board.submarkets.length > 1000) throw new Error('Invalid territory board');
  return board.submarkets.map(value => {
    const row = object(value);
    if (!Array.isArray(row.evidence)) throw new Error('Invalid territory evidence');
    return { city: text(row.city), state: text(row.state), condition: condition(row.condition), evidence: row.evidence.map(value => {
      const entry = object(value);
      if (typeof entry.current !== 'boolean' || typeof entry.expired !== 'boolean') throw new Error('Invalid evidence status');
      return { flag_id: text(entry.flag_id), condition: condition(entry.condition), source: text(entry.source), observed_at: text(entry.observed_at),
        expires_on: entry.expires_on === null ? null : text(entry.expires_on), expired: entry.expired, current: entry.current };
    }) };
  });
}
export function mountTerritoryEvidence(host: HTMLElement, client: Client, onAuthorizationFailure: (error: unknown) => void) {
  const root = createRoot(host);
  let view: View = { kind: 'idle' }, filters: Filters = {}, epoch = 0, generation = 0, opened = false, disposed = false;
  async function load() {
    const request = ++epoch;
    view = { kind: 'loading' }; render();
    try {
      const rows = parse(await client.getTerritoryStateBoard(filters));
      if (disposed || request !== epoch) return;
      view = { kind: 'ready', rows };
    } catch (error) {
      if (disposed || request !== epoch) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (['unauthorized', 'not_authenticated', 'forbidden'].includes(String(code))) {
        clear(); onAuthorizationFailure(error); return;
      }
      view = { kind: 'error', message: code === 'territory_board_limit_exceeded'
        ? 'Narrow city or state filters. The server refused more than 1000 areas; no partial results are shown.'
        : 'Territory evidence unavailable. Refresh to try again.' };
    }
    render();
  }
  function clear() {
    ++epoch; ++generation; opened = false; filters = {}; view = { kind: 'idle' }; render();
  }
  function render() {
    if (disposed) return;
    flushSync(() => root.render(<section className="territory-evidence" aria-label="Recorded territory conditions">
      <details key={generation} onToggle={event => {
        opened = event.currentTarget.open;
        if (opened && view.kind === 'idle') void load();
      }}><summary>Recorded territory conditions</summary>
        <p>Recorded city and state evidence only. Lead counts do not establish market conditions. Unknown means no current evidence; conflicting means current sources disagree.</p>
        <form onSubmit={event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          filters = {};
          for (const key of ['city', 'state', 'vertical'] as const) {
            const value = String(data.get(key) || '');
            if (value) filters[key] = value;
          }
          void load();
        }}>
          <label>City<input name="city" maxLength={200} /></label>
          <label>State<input name="state" pattern="[A-Z]{2}" maxLength={2} title="Two uppercase state letters" /></label>
          <label>Vertical<input name="vertical" maxLength={200} /></label>
          <button type="submit">Apply filters</button>
          <button type="button" onClick={() => void load()}>Refresh evidence</button>
        </form>
        {view.kind === 'loading' && <p role="status">Loading territory evidence…</p>}
        {view.kind === 'error' && <p role="alert">{view.message}</p>}
        {view.kind === 'ready' && (view.rows.length ? <table><caption>Server-recorded conditions by city and state</caption>
          <thead><tr><th scope="col">Area</th><th scope="col">Condition</th><th scope="col">Sources</th></tr></thead>
          <tbody>{view.rows.map(row => <tr key={JSON.stringify([row.city, row.state])}>
            <th scope="row">{row.city}, {row.state}</th><td>{labels[row.condition]}</td>
            <td>{row.evidence.length ? <details><summary>Evidence ({row.evidence.length})</summary>
              <ul>{row.evidence.map(entry => <li key={entry.flag_id}>
                <strong>{labels[entry.condition]} · {entry.current ? 'Current' : entry.expired ? 'Historical · expired' : 'Historical · not current'}</strong>
                <p>Source: {entry.source}</p><p>Observed: {entry.observed_at}</p><p>Expires: {entry.expires_on || 'Unrecorded'}</p>
              </li>)}</ul></details> : 'No current evidence recorded.'}</td>
          </tr>)}</tbody></table> : <p>No recorded areas match these filters. No market condition can be inferred.</p>)}
      </details>
    </section>));
  }
  render();
  return { clear, refresh() { if (opened && view.kind !== 'idle') return load(); }, dispose() { disposed = true; ++epoch; flushSync(() => root.unmount()); } };
}
