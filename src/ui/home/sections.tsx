import { useEffect, useState, type ReactNode } from 'react';
import type { InboxItem } from './inbox';

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
const completionFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const welcomeFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' });
const day = (date: Date) => dayFormat.format(date);

export function completionGroups(items: readonly InboxItem[], now: Date) {
  const completed = items.filter(item => item.section === 'done' || item.auto_settled).sort((a, b) => (b.completed_at ? Date.parse(b.completed_at) : 0) - (a.completed_at ? Date.parse(a.completed_at) : 0) || a.item_id.localeCompare(b.item_id));
  const today = day(now);
  const isToday = (item: InboxItem) => item.completed_at !== null && day(new Date(item.completed_at)) === today;
  return { today: completed.filter(isToday), earlier: completed.filter(item => !isToday(item)) };
}
export function completionLabel(item: InboxItem) {
  if (!item.completed_at) return 'Done, time not recorded';
  return `Done ${completionFormat.format(new Date(item.completed_at))}`;
}

function Slice({ title, detail, items, current, row }: { title: string; detail: string; items: readonly InboxItem[]; current: string | undefined; row: (item: InboxItem) => ReactNode }) {
  const [expanded, expand] = useState(false);
  const shown = expanded ? items : items.filter((item, index) => index === 0 || item.item_id === current);
  return <section className="home-slice" aria-label={title}><header><div><h2 tabIndex={-1}>{title} <span>{items.length}</span></h2><p>{detail}</p></div>{items.length > 1 && <button type="button" aria-expanded={expanded} onClick={() => expand(!expanded)}>{expanded ? 'Show less' : `See all ${items.length}`}</button>}</header>{items.length ? shown.map(row) : <p className="home-slice-empty">Nothing here right now.</p>}</section>;
}

export function HomeWelcome() {
  return <header className="home-welcome"><p className="home-kicker">YOUR DAY, IN FOCUS</p><p className="home-date">{welcomeFormat.format(new Date())}</p><h1>Welcome home.</h1><p>Review what matters. Keep your day moving.</p></header>;
}

function matchesLoadedCard(item: InboxItem, query: string) {
  const literal = query.trim().toLowerCase();
  return [item.title, item.context_label, item.kind_label].some(value => value?.toLowerCase().includes(literal));
}

export function HomeSections({ items: loaded, pinned, current, search, locked, changeSearch, row }: { items: readonly InboxItem[]; pinned?: InboxItem | null; current: string | undefined; search: string; locked: boolean; changeSearch: (value: string) => void; row: (item: InboxItem) => ReactNode }) {
  const placement = (item: InboxItem) => item.item_id === pinned?.item_id ? pinned : item;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      // eslint-disable-next-line no-restricted-syntax -- One local clock update per minute boundary; no reads, one timer, cleared on unmount.
      timer = setTimeout(tick, 60_000 - Date.now() % 60_000);
    };
    // eslint-disable-next-line no-restricted-syntax -- One initial minute-boundary timer; no reads, cleared on unmount.
    timer = setTimeout(tick, 60_000 - Date.now() % 60_000);
    return () => clearTimeout(timer);
  }, []);
  const matching = loaded.filter(item => matchesLoadedCard(item, search));
  const items = loaded.filter(item => matchesLoadedCard(item, search) || item.item_id === current);
  const renderRow = (item: InboxItem) => <div key={item.item_id}>{item.item_id === current && !matchesLoadedCard(item, search) && <p role="status">Pinned outside search</p>}{row(item)}</div>;
  const today = day(now);
  const completed = completionGroups(items.map(placement), now);
  const overdue = (item: InboxItem) => {
    const placed = placement(item);
    return placed.section === 'inbox' && placed.source_state === 'needs_attention' && placed.action_id !== null && placed.due_on !== null && placed.due_on < today;
  };
  const overdueItems = items.filter(overdue);
  const dueToday = (item: InboxItem) => placement(item).section === 'inbox' && placement(item).due_on === today;

  return <div className="home-sections">
    {<div role="search" aria-label="Loaded Home cards"><label>Search loaded cards <input type="search" value={search} disabled={locked} onChange={event => changeSearch(event.target.value)} /></label><button type="button" disabled={locked || !search} onClick={() => changeSearch('')}>Clear</button><p role="status">{matching.length} matching loaded cards of {loaded.length} loaded</p>{search.trim() && !matching.length && <p role="status">No loaded cards match your search.</p>}</div>}
    <nav className="home-shortcuts" aria-label="Review workflows"><a href="/review-workflows#homeCallTasks">Call follow-ups ↗</a><a href="/review-workflows#homeEmailFollowups">Email and filings ↗</a><a href="/deals">Next steps ↗</a></nav>
    {overdueItems.length > 0 && <Slice title="Overdue" detail="Your tasks dated before today." items={overdueItems} current={current} row={renderRow} />}
    <Slice title="Needs your attention" detail="One thing at a time. Review, act, move on." items={items.filter(item => placement(item).section === 'inbox' && !dueToday(item) && !overdue(item))} current={current} row={renderRow} />
    <Slice title="Today" detail="Your tasks dated today." items={items.filter(dueToday)} current={current} row={renderRow} />
    <Slice title="In motion and waiting" detail="Work in progress, on hold, or snoozed." items={items.filter(item => ['working', 'held', 'snoozed'].includes(placement(item).section))} current={current} row={renderRow} />
    <Slice title="Done today" detail="Completed today in Chicago, with a recorded completion time." items={completed.today.map(done => items.find(item => item.item_id === done.item_id) ?? done)} current={current} row={renderRow} />
    <Slice title="Earlier and undated completions" detail="Completed before today, or without a recorded completion time." items={completed.earlier.map(done => items.find(item => item.item_id === done.item_id) ?? done)} current={current} row={renderRow} />
    <Slice title="Hidden from inbox" detail="Set aside by you. These tasks may still be open." items={items.filter(item => placement(item).section === 'settled' && !placement(item).auto_settled)} current={current} row={renderRow} />

  </div>;
}
