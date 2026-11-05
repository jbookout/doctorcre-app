import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { centralInstant, tomorrowCentral } from '../central-time';
import { batchRequest, transition, undoRequest, type BatchState, type BatchEvent } from './batch';
import { type InboxClient, type InboxItem, type Snapshot } from './inbox';
type Props = { client: InboxClient; picked: readonly InboxItem[]; selected: ReadonlySet<string>; locked: boolean; select(ids: Set<string>): void; snapshot(value: Snapshot): void; prepare(): Promise<void>; lock(value: boolean): void; finish(): void };
const labels = { applied: 'Applied', already: 'Already', not_found: 'Not found', not_allowed: 'Not allowed' };
export function BulkControls({ client, picked, selected, locked, select, snapshot, prepare, lock, finish }: Props) {
  const [state, setState] = useState<BatchState>({ kind: 'selection' });
  const current = useRef(state);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [notice, announce] = useState('');
  const [picker, showPicker] = useState(false);
  const [when, setWhen] = useState('');
  const [error, setError] = useState('');
  const [subset, setSubset] = useState<Set<string>>(new Set());
  const opener = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [cancelled, setCancelled] = useState(0);
  function cancelPicker() { showPicker(false); setError(''); setCancelled(value => value + 1); }
  useLayoutEffect(() => { if (cancelled) opener.current?.focus(); }, [cancelled]);
  function send(event: BatchEvent) { const next = transition(current.current, event); current.current = next; setState(next); return next; }
  const busy = state.kind === 'applying' || state.kind === 'undoing';
  const batch = 'batch' in state ? state.batch : null;
  useLayoutEffect(() => { if (state.kind === 'results' || state.kind === 'undone' || state.kind === 'undo_refused') heading.current?.focus(); }, [state]);
  async function execute(operation: Extract<BatchState, { kind: 'applying' | 'undoing' }>) {
    lock(true);
    try {
      await prepare();
      if (!mounted.current) return;
      const expected = operation.request.args.items?.map(item => item.item_id) || (operation.kind === 'undoing' ? operation.batch.items.map(item => item.item_id) : []);
      const result = await client.batch(operation.request, expected);
      if (!mounted.current) return;
      send({ kind: 'received', result });
      if (result.snapshot) snapshot(result.snapshot);
      if (operation.kind === 'applying') select(new Set(result.results.filter(row => row.status !== 'applied').map(row => row.item_id)));
      const applied = result.results.filter(row => row.status === 'applied').length;
      announce(`${operation.kind === 'undoing' ? 'Batch undo confirmed' : 'Batch confirmed'}. ${applied} applied. ${result.results.length - applied} unchanged or refused.${result.snapshot ? '' : ' Inbox refresh unavailable. Refresh before another batch.'}`);
      setSubset(new Set(operation.kind === 'undoing' ? result.results.filter(row => row.status === 'not_allowed' || row.status === 'not_found').map(row => row.item_id) : []));
    } catch (error) {
      if (!mounted.current) return;
      const message = error instanceof Error ? error.message : 'Server confirmation unavailable.';
      send({ kind: 'failed', message });
      announce('Batch result uncertain. Retry the same request.');
    } finally { lock(false); }
  }
  function apply(action: 'snooze' | 'settle', until?: string) {
    try {
      const request = batchRequest(action, picked, until);
      const next = send({ kind: 'apply', request, items: [...picked] });
      if (next.kind === 'applying') { showPicker(false); setError(''); void execute(next); }
    } catch (error) { setError(error instanceof Error ? error.message : 'Choose a valid return time.'); }
  }
  const blocked = locked || busy || state.kind !== 'selection';
  return <>
    <p className="inbox-batch-announcement" role="status" aria-live="polite" aria-atomic="true">{notice}</p>
    {picked.length > 0 && <div className="inbox-bulk" role="group" aria-label="Selected cards"><strong>{picked.length} selected</strong>
      <button disabled={blocked || picked.length > 100} onClick={() => apply('settle')}>Settle selected</button>
      <button disabled={blocked || picked.length > 100} onClick={event => { opener.current = event.currentTarget; setWhen(tomorrowCentral(new Date())); showPicker(true); }}>Snooze selected</button>
      <button disabled={locked || busy || state.kind === 'uncertain'} onClick={() => select(new Set())}>Clear selection</button>
      {picked.length > 100 && <p>Select up to 100 cards per batch.</p>}
    </div>}
    {picker && <dialog className="inbox-snooze" aria-label="Snooze selected cards" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={cancelPicker}>
      <h2>Snooze {picked.length} cards</h2><p>Return tomorrow at 9:00 AM Central, or choose a time.</p>
      <button autoFocus onClick={() => apply('snooze', centralInstant(tomorrowCentral(new Date())))}>Not now · Tomorrow 9:00 AM Central</button>
      <label>Return time · Central<input type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} /></label>
      <button onClick={() => { try { apply('snooze', centralInstant(when)); } catch (error) { setError(error instanceof Error ? error.message : 'Choose a valid Central time.'); } }}>Snooze until chosen time</button>
      {error && <p role="alert">{error}</p>}<button onClick={cancelPicker}>Cancel</button>
    </dialog>}
    {state.kind !== 'selection' && <section className="inbox-batch-results" aria-label="Batch results" data-batch-state={state.kind}>
      <h2 ref={heading} tabIndex={-1}>Batch results</h2>
      {busy && <p>Waiting for server confirmation…</p>}
      {state.kind === 'uncertain' && <><p>{state.message} Nothing else will be sent automatically.</p><button disabled={locked} onClick={() => { const next = send({ kind: 'retry' }); if (next.kind === 'applying' || next.kind === 'undoing') void execute(next); }}>Retry same batch</button></>}
      {batch && <><ul>{batch.result.results.map(row => <li key={row.item_id}>{batch.items.find(item => item.item_id === row.item_id)?.title || row.item_id} · {row.status === 'applied' && !batch.remaining.includes(row.item_id) ? 'Restored' : labels[row.status]}{row.status === 'not_allowed' ? row.error === 'version_conflict' ? '. This card changed. Refresh to review it. Nothing was overwritten.' : '. This change is not permitted. Refresh to review the card.' : row.status === 'not_found' ? '. This card is no longer available.' : row.status === 'already' ? '. No change was needed.' : ''}{row.status !== 'applied' && batch.result.snapshot && !batch.result.snapshot.items.some(item => item.item_id === row.item_id) && <label><input type="checkbox" aria-label={`Select missing card ${batch.items.find(item => item.item_id === row.item_id)?.title || row.item_id}`} checked={selected.has(row.item_id)} onChange={event => { const next = new Set(selected); if (event.target.checked) next.add(row.item_id); else next.delete(row.item_id); select(next); }} />Keep selected for review</label>}</li>)}</ul>
        {batch.remaining.length > 0 && <fieldset disabled={busy || locked}><legend>Undo applied cards</legend>{batch.items.filter(item => batch.remaining.includes(item.item_id)).map(item => <label key={item.item_id}><input type="checkbox" checked={subset.has(item.item_id)} onChange={event => setSubset(before => { const next = new Set(before); if (event.target.checked) next.add(item.item_id); else next.delete(item.item_id); return next; })} />Undo {item.title}</label>)}
          <button onClick={() => { const next = send({ kind: 'undo', request: undoRequest(batch) }); if (next.kind === 'undoing') void execute(next); }}>Undo whole batch</button>
          <button disabled={!subset.size} onClick={() => { const next = send({ kind: 'undo', request: undoRequest(batch, [...subset]) }); if (next.kind === 'undoing') void execute(next); }}>Undo selected results</button>
        </fieldset>}
        {!busy && <button onClick={() => { send({ kind: 'reset' }); announce('Batch review finished.'); finish(); }}>Finish reviewing batch</button>}
      </>}
    </section>}
    {!picker && error && <p role="alert">{error}</p>}
  </>;
}
