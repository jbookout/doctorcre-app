import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Row = { client_id:string; client_name:string; deal_id:string; deal_name:string; closed_on:string; anniversary_on:string; days_until:number; years:number; evidence_ref:string };
type Snapshot = { schema_version:'client-anniversary-read.v1'; state:'ready'|'empty'|'unavailable'|'needs_input'; as_of:string; timezone:'America/Chicago'; rows:Row[]; coverage:{scanned:number; skipped_invalid:number; complete:boolean}; next_offset:number|null };
const sibling = (path: string) => import(new URL(path, import.meta.url).href);

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z")) && (new Date(v + "T00:00:00Z")).toISOString().slice(0, 10) === v;
const label = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function parseClientAnniversaries(v: unknown): Snapshot {
  if (!object(v) || v.schema_version !== "client-anniversary-read.v1" || v.timezone !== "America/Chicago" || !date(v.as_of) || !object(v.query) || v.query.horizon_days !== 30 || v.query.limit !== 20 || v.query.offset !== 0 || !Array.isArray(v.rows) || v.rows.length > 20 || !object(v.coverage)) throw Error("Anniversary response unavailable");
  const { scanned, skipped_invalid, complete } = v.coverage;
  const state = v.state;
  if (state !== "ready" && state !== "empty" && state !== "unavailable" && state !== "needs_input") throw Error("Anniversary state unavailable");
  if (!integer(scanned) || scanned > 1001 || !integer(skipped_invalid) || skipped_invalid > scanned || complete !== (state === "ready" || state === "empty") || state === "ready" !== v.rows.length > 0 || !(v.next_offset === null || v.next_offset === 20 && v.rows.length === 20)) throw Error("Anniversary coverage unavailable");
  const rows = v.rows.map((r: unknown) => {
    if (!object(r) || !label(r.client_id) || !label(r.client_name) || !label(r.deal_id) || !label(r.deal_name) || !date(r.closed_on) || r.closed_on > String(v.as_of) || !date(r.anniversary_on) || !integer(r.days_until) || r.days_until > 30 || !integer(r.years) || r.years < 1 || !integer(r.deal_version) || r.deal_version < 1 || !integer(r.client_version) || r.client_version < 1 || !integer(r.party_version) || r.party_version < 1 || !["closed", "invoiced"].includes(String(r.phase)) || r.outcome !== "won" || r.evidence_ref !== `deal:${r.deal_id}@${r.deal_version}#closed_on`) throw Error("Anniversary row unavailable");
    return { client_id: r.client_id, client_name: r.client_name, deal_id: r.deal_id, deal_name: r.deal_name, closed_on: r.closed_on, anniversary_on: r.anniversary_on, days_until: r.days_until, years: r.years, evidence_ref: r.evidence_ref };
  });
  const keys = rows.map((r) => `${r.anniversary_on}/${r.client_id}/${r.deal_id}/${r.closed_on}`);
  if (new Set(keys).size !== keys.length || keys.join() !== [...keys].sort().join()) throw Error("Anniversary order unavailable");
  return { schema_version: v.schema_version, state, as_of: v.as_of, timezone: v.timezone, rows, coverage: { scanned, skipped_invalid, complete }, next_offset: v.next_offset };
}

export { parseClientAnniversaries };
export function createClientAnniversariesClient({fetchImpl}: {fetchImpl?: typeof fetch} = {}) {
  return { async read({signal}: {signal?: AbortSignal} = {}): Promise<Snapshot> {
    const {fetchRead} = await sibling('./auto-refresh.mjs');
    const request = fetchImpl ?? (await sibling('./private-session.js')).sessionFetch;
    const response = await fetchRead('/api/v1/intelligence/client-anniversary-read?horizon_days=30&limit=20&offset=0', {credentials:'same-origin',cache:'no-store',signal,headers:{accept:'application/json'}}, {fetchImpl: request});
    if (!response.ok && response.status !== 503) throw Error('Closing anniversaries unavailable');
    const payload: unknown = await response.json();
    if (!response.ok && (!object(payload) || payload.state !== 'unavailable')) throw Error('Closing anniversaries unavailable');
    parseClientAnniversaries(payload);
    return payload as Snapshot;
  }};
}

type State = {kind:'idle'|'loading'} | {kind:'refusal'; message:string} | {kind:'snapshot'; value:Snapshot};
export function mountClientAnniversaries(host:HTMLElement, {load}:{load:(signal:AbortSignal)=>Promise<Snapshot>}) {
  const root = createRoot(host), win = host.ownerDocument.defaultView;
  let terminal = false, generation = 0, controller:AbortController|undefined;
  let reset = () => {};
  function invalidate() { generation++; controller?.abort(); reset(); }
  function Panel() {
    const [state,setState] = useState<State>({kind:'idle'});
    reset = () => setState({kind:'idle'});
    async function open() {
      if (terminal || state.kind === 'loading') return;
      const ticket = ++generation;
      controller = new AbortController();
      setState({kind:'loading'});
      try {
        const value = await load(controller.signal);
        if (terminal || ticket !== generation) return;
        setState({kind:'snapshot',value});
      } catch {
        if (!terminal && ticket === generation) setState({kind:'refusal',message:'Closing anniversaries could not be loaded. Try again.'});
      }
    }
    useEffect(() => { void open(); }, []);
    return <section aria-label="Closing anniversaries" style={{overflowWrap:'anywhere'}}>
      <h2>Closing anniversaries</h2>
      <button type="button" className="action" aria-expanded={state.kind !== 'idle'} aria-controls="anniversaryContent" onClick={()=>{if(state.kind === 'idle') void open(); else invalidate();}}>{state.kind === 'idle' ? 'Show closing anniversaries' : 'Hide closing anniversaries'}</button>
      <div id="anniversaryContent" hidden={state.kind === 'idle'} aria-live="polite" aria-busy={state.kind === 'loading'}>
        {state.kind !== 'idle' && <p>Next 30 days · America/Chicago calendar · First slice of at most 20. This is not a complete client census.</p>}
        {state.kind === 'loading' && <p role="status">Loading closing anniversaries…</p>}
        {state.kind === 'refusal' && <><p role="alert">{state.message}</p><button type="button" className="action" onClick={()=>void open()}>Retry closing anniversaries</button></>}
        {state.kind === 'snapshot' && <>
          {state.value.state === 'empty' && <p>No closing anniversaries in this slice.</p>}
          {state.value.state === 'unavailable' && <p role="alert">Closing anniversaries are unavailable.</p>}
          {state.value.state === 'needs_input' && <p role="alert">Closing anniversaries need input.</p>}
          {(state.value.state === 'unavailable' || state.value.state === 'needs_input') && <button type="button" className="action" onClick={()=>void open()}>Retry closing anniversaries</button>}
          <p>As of {state.value.as_of}. Scanned {state.value.coverage.scanned}. Skipped invalid {state.value.coverage.skipped_invalid}.</p>
          {state.value.next_offset !== null && <p>More anniversary rows exist. This first slice shows at most 20.</p>}
          <ol>{state.value.rows.map(r=><li key={r.evidence_ref}>
            <a href={`/clients?record=${encodeURIComponent(r.client_id)}`}>{r.client_name}</a>{' · '}<a href={`/deals?deal=${encodeURIComponent(r.deal_id)}`}>{r.deal_name}</a>
            <p>Closed <time dateTime={r.closed_on}>{r.closed_on}</time>{' · '}Anniversary <time dateTime={r.anniversary_on}>{r.anniversary_on}</time>{' · '}{r.years} years{' · '}{r.days_until} days until</p>
          </li>)}</ol>
        </>}
      </div>
    </section>;
  }
  const dispose = () => {
    if (terminal) return;
    terminal = true; invalidate();
    win?.removeEventListener('pagehide',onPagehide);
    win?.removeEventListener('doctorcre-session-invalidated',dispose);
    flushSync(()=>root.unmount());
  };
  const onPagehide = (event:PageTransitionEvent) => {
    if (event.persisted) flushSync(() => invalidate()); else dispose();
  };
  win?.addEventListener('pagehide',onPagehide);
  win?.addEventListener('doctorcre-session-invalidated',dispose);
  flushSync(()=>root.render(<Panel/>));
  return {dispose};
}
