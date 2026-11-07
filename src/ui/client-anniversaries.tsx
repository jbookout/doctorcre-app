import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Row = { client_id:string; client_name:string; deal_id:string; deal_name:string; closed_on:string; anniversary_on:string; days_until:number; years:number; evidence_ref:string };
type Snapshot = { schema_version:'client-anniversary-read.v1'; state:'ready'|'empty'|'unavailable'|'needs_input'; as_of:string; timezone:'America/Chicago'; rows:Row[]; coverage:{scanned:number; skipped_invalid:number; complete:boolean}; next_offset:number|null };
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
