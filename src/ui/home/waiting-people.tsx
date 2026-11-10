import { useEffect, useRef, useState } from 'react';
import type { InboxClient, PartyCursor, WaitingChoice } from './inbox';

type Search = { kind: 'idle' | 'debouncing' | 'loading' } | { kind: 'failed'; query: string; cursor: PartyCursor | undefined } | { kind: 'ready'; cursor: PartyCursor | null };
export function WaitingPeople({ client, id, selected, select }: { client: InboxClient; id: string; selected: WaitingChoice | null; select: (choice: WaitingChoice | null) => void }) {
  const [actors, setActors] = useState<WaitingChoice[]>([]);
  const [parties, setParties] = useState<WaitingChoice[]>([]);
  const [query, setQuery] = useState('');
  const [fallback, setFallback] = useState(false);
  const [roster, setRoster] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [search, setSearch] = useState<Search>({ kind: 'idle' });
  const generation = useRef(0);
  const tail = useRef(Promise.resolve());
  const mounted = useRef(true);
  const rosterBusy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  async function contacts() {
    const choices = await client.choices?.();
    if (mounted.current) { setFallback(true); setParties(choices || []); setSearch({ kind: 'idle' }); }
  }
  async function load() {
    if (rosterBusy.current) return;
    rosterBusy.current = true; setRoster('loading');
    try {
      const choices = await client.actors?.();
      if (!mounted.current) return;
      if (choices == null || !client.search) await contacts();
      else setActors(choices);
      if (mounted.current) setRoster('ready');
    } catch { if (mounted.current) setRoster('failed'); }
    finally { rosterBusy.current = false; }
  }
  useEffect(() => { void load(); }, [client]);
  function request(value: string, token: number, cursor?: PartyCursor) {
    tail.current = tail.current.then(async () => {
      if (!mounted.current || token !== generation.current) return;
      setSearch({ kind: 'loading' });
      try {
        const page = await client.search?.(value, cursor);
        if (!mounted.current || token !== generation.current) return;
        if (page == null) { await contacts(); return; }
        setParties(previous => cursor ? [...new Map([...previous, ...page.choices].map(choice => [choice.id, choice])).values()] : page.choices);
        setSearch({ kind: 'ready', cursor: page.next_cursor });
      } catch { if (mounted.current && token === generation.current) setSearch({ kind: 'failed', query: value, cursor }); }
    });
  }
  useEffect(() => {
    const token = ++generation.current;
    if (!fallback) setParties([]);
    if (fallback || !query.trim()) { setSearch({ kind: 'idle' }); return; }
    setSearch({ kind: 'debouncing' });
    // eslint-disable-next-line no-restricted-syntax -- One 300 ms search debounce per picker, cleared on query change or unmount.
    const timer = setTimeout(() => request(query.trim(), token), 300);
    return () => clearTimeout(timer);
  }, [query, fallback]);
  const choices = [...new Map([...actors, ...parties, ...(selected ? [selected] : [])].map(choice => [choice.id, choice])).values()];
  return <>
    <button type="button" disabled={roster === 'loading'} onClick={() => void load()}>Load people</button>
    {roster === 'loading' && <p role="status">Loading human actors…</p>}
    {roster === 'failed' && <p role="status">Human actors unavailable. Load people again to retry.</p>}
    {fallback ? <p role="status">Name search is unavailable on this server. Showing existing contact choices.</p> : <>
      <label htmlFor={`${id}-search`} style={{ display: 'block' }}>Search people by name</label>
      <input id={`${id}-search`} type="search" maxLength={100} value={query} onChange={event => { generation.current++; setQuery(event.target.value); }} style={{ width: '100%', boxSizing: 'border-box', minHeight: 44, font: 'inherit' }} />
      <p role="status">{search.kind === 'loading' ? 'Searching people…' : search.kind === 'debouncing' ? 'Waiting to search…' : search.kind === 'failed' ? 'People search failed. Retry search or enter another name.' : search.kind === 'ready' ? parties.length ? 'Select a recorded person.' : 'No people found for this name prefix.' : 'Enter a name prefix to search CARR people.'}</p>
      {search.kind === 'failed' && <button type="button" onClick={() => { const token = ++generation.current; setSearch({ kind: 'loading' }); request(search.query, token, search.cursor); }}>Retry search</button>}
      {search.kind === 'ready' && search.cursor && <button type="button" onClick={() => { if (search.kind !== 'ready' || !search.cursor) return; const token = ++generation.current; setSearch({ kind: 'loading' }); request(query.trim(), token, search.cursor); }}>More results</button>}
    </>}
    <label htmlFor={id} style={{ display: 'block' }}>Person</label>
    <select id={id} value={selected?.id || ''} onChange={event => select(choices.find(choice => choice.id === event.target.value) || null)} style={{ width: '100%', minHeight: 44, font: 'inherit' }}>
      <option value="">Choose a recorded person</option>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}{choice.kind === 'actor' ? ' · Team' : ''}</option>)}
    </select>
  </>;
}
