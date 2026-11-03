import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { recentIds, rememberDestination as remember, clearRecents } from './switcher-history';

type Destination = { id: string; label: string; kind: 'Deal' | 'Contact' | 'Task' | 'Page'; href: string };
type ReadState = { kind: 'loading' } | { kind: 'ready'; items: Destination[] } | { kind: 'error' };
type Options = {
  opener: HTMLElement;
  pages: { label: string; href: string }[];
  read: () => Promise<{ board: unknown; network: unknown }>;
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function destinations({ board, network }: { board: unknown; network: unknown }): Destination[] {
  if (!record(board) || !Array.isArray(board.deals) || !record(network) || !Array.isArray(network.nodes)) throw Error('Unavailable');
  const result: Destination[] = [];
  const seen = new Set<string>();
  const deals = [...board.deals];
  for (const key of ['closed_deals', 'lost_deals']) {
    if (board[key] === undefined) continue;
    if (!Array.isArray(board[key])) throw Error('Invalid deals');
    deals.push(...board[key]);
  }
  for (const deal of deals) {
    if (!record(deal) || !text(deal.id) || !text(deal.name)) throw Error('Invalid deal');
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    const href = `/deals?deal=${encodeURIComponent(deal.id)}`;
    result.push({ id: `deal:${deal.id}`, label: deal.name, kind: 'Deal', href });
    if (Array.isArray(deal.open_actions)) for (const action of deal.open_actions) {
      if (record(action) && text(action.id) && text(action.description)) result.push({
        id: `task:${action.id}`, label: `${action.description} · ${deal.name}`, kind: 'Task', href,
      });
    }
  }
  for (const node of network.nodes) {
    if (!record(node) || !text(node.id) || !text(node.name) || !['vendor', 'client', 'lead', 'contact', 'deal'].includes(String(node.kind))) throw Error('Invalid contact');
    if (node.kind === 'deal' || node.contact_state === 'retired') continue;
    result.push({ id: node.id, label: node.name, kind: 'Contact', href: `/relationships?node=${encodeURIComponent(node.id)}` });
  }
  return result;
}

export function openQuickSwitcher({ opener, pages, read }: Options) {
  if (document.querySelector('[data-quick-switcher]')) return;
  const dialog = document.createElement('dialog');
  dialog.dataset.quickSwitcher = '';
  dialog.className = 'quick-switcher';
  dialog.setAttribute('aria-label', 'Quick switcher');
  document.body.append(dialog);
  const root = createRoot(dialog);
  let retired = false;
  const close = () => {
    if (retired) return;
    retired = true;
    dialog.close();
    root.unmount();
    dialog.remove();
    window.removeEventListener('doctorcre-session-invalidated', revoke);
    opener.focus();
  };
  const revoke = () => { clearRecents(); close(); };
  window.addEventListener('doctorcre-session-invalidated', revoke, { once: true });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  } });
  root.render(<Switcher pages={pages} read={read} close={close} />);
  dialog.showModal();
}

function Switcher({ pages, read, close }: Omit<Options, 'opener'> & { close: () => void }) {
  const [state, setState] = useState<ReadState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const pageItems: Destination[] = pages.map(page => ({ ...page, id: `page:${page.href}`, kind: 'Page' }));
  const all = [...(state.kind === 'ready' ? state.items : []), ...pageItems];
  const normalized = query.trim().toLocaleLowerCase();
  const recents = recentIds().flatMap(id => all.find(item => item.id === id) || []);
  const results = normalized ? all.filter(item => `${item.label} ${item.kind}`.toLocaleLowerCase().includes(normalized)) : [...recents, ...pageItems.filter(page => !recents.some(item => item.id === page.id))];
  const selected = results[active];
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    void read().then(payload => {
      const items = destinations(payload);
      if (current) {
        const path = `${location.pathname}${location.search}`;
        const opened = [...items, ...pageItems].find(item => item.href === path);
        if (opened) remember(opened.id);
        setState({ kind: 'ready', items });
      }
    }).catch(() => { if (current) setState({ kind: 'error' }); });
    return () => { current = false; };
  }, [attempt]);
  useEffect(() => { document.getElementById(`quick-option-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const navigate = (item: Destination) => { remember(item.id); close(); location.assign(item.href); };
  return <div className="quick-switcher-content">
    <header><h2>Jump to</h2><button type="button" aria-label="Close quick switcher" onClick={close}>Close</button></header>
    <input ref={input} id="quick-input" role="combobox" aria-label="Jump to" autoComplete="off" placeholder="Deals, contacts, tasks and pages"
      aria-expanded="true" aria-autocomplete="list" aria-controls="quick-results" aria-activedescendant={selected ? `quick-option-${active}` : undefined}
      value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (results.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
        } else if (event.key === 'Enter' && selected) { event.preventDefault(); navigate(selected); }
      }} />
    <p role="status">{state.kind === 'loading' ? 'Loading accessible items…' : state.kind === 'error' ? 'Deals and contacts unavailable. Pages are still available.' : normalized && results.length === 0 ? 'No matches. Try a deal, contact or page name.' : `${results.length} destinations`}</p>
    {state.kind === 'error' && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>}
    {!normalized && <h3>{recents.length ? 'Recent' : 'Pages'}</h3>}
    <ul id="quick-results" role="listbox" aria-label="Destinations">
      {results.map((item, index) => <li key={item.id} id={`quick-option-${index}`} role="option" aria-selected={index === active}
        onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => navigate(item)}>
        <span>{item.label}</span><small>{item.kind}</small>
      </li>)}
    </ul>
    <footer>↑ ↓ to move · Enter to open · Esc to close</footer>
  </div>;
}
