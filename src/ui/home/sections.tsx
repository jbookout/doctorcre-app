import { useState, type ReactNode } from 'react';
import type { InboxItem } from './inbox';

const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function Slice({ title, detail, items, current, row }: { title: string; detail: string; items: readonly InboxItem[]; current: string | undefined; row: (item: InboxItem) => ReactNode }) {
  const [expanded, expand] = useState(false);
  const shown = expanded ? items : items.filter((item, index) => index === 0 || item.item_id === current);
  return <section className="home-slice" aria-label={title}><header><div><h2>{title} <span>{items.length}</span></h2><p>{detail}</p></div>{items.length > 1 && <button type="button" aria-expanded={expanded} onClick={() => expand(!expanded)}>{expanded ? 'Show less' : `See all ${items.length}`}</button>}</header>{items.length ? shown.map(row) : <p className="home-slice-empty">Nothing here right now.</p>}</section>;
}

export function HomeWelcome() {
  return <header className="home-welcome"><p className="home-kicker">YOUR DAY, IN FOCUS</p><p className="home-date">{new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p><h1>Welcome home.</h1><p>Review what matters. Keep your day moving.</p></header>;
}

export function HomeSections({ items, pinned, current, row }: { items: readonly InboxItem[]; pinned?: InboxItem | null; current: string | undefined; row: (item: InboxItem) => ReactNode }) {
  const placement = (item: InboxItem) => item.item_id === pinned?.item_id ? pinned : item;
  const today = day();
  const dueToday = (item: InboxItem) => placement(item).section === 'inbox' && placement(item).due_on === today;
  return <div className="home-sections"><nav className="home-shortcuts" aria-label="Review workflows"><a href="/review-workflows#homeCallTasks">Call follow-ups ↗</a><a href="/review-workflows#homeEmailFollowups">Email and filings ↗</a><a href="/deals">Next steps ↗</a></nav>
    <Slice title="Needs your attention" detail="One thing at a time. Review, act, move on." items={items.filter(item => placement(item).section === 'inbox' && !dueToday(item))} current={current} row={row} />
    <Slice title="Today" detail="Your tasks dated today." items={items.filter(dueToday)} current={current} row={row} />
    <Slice title="In motion and waiting" detail="Work in progress, on hold, or snoozed." items={items.filter(item => ['working', 'held', 'snoozed'].includes(placement(item).section))} current={current} row={row} />
    <Slice title="Recently done" detail="Completed work, ordered by latest activity." items={items.filter(item => (placement(item).section === 'done' || placement(item).auto_settled)).sort((a, b) => b.activity_at.localeCompare(a.activity_at))} current={current} row={row} />
    <Slice title="Hidden from inbox" detail="Set aside by you. These tasks may still be open." items={items.filter(item => placement(item).section === 'settled' && !placement(item).auto_settled)} current={current} row={row} />
  </div>;
}
