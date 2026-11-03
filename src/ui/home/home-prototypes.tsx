import { useState, type ReactNode } from 'react';
import type { InboxItem } from './inbox';
import { recordRoutes } from './routes';

export type HomeVariant = 'a' | 'b' | 'c';
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const labels = { a: 'A · Day briefing', b: 'B · Today beside you', c: 'C · At a glance' };

export function HomeWelcome({ variant, items }: { variant: HomeVariant; items: readonly InboxItem[] }) {
  const attention = items.filter(item => item.section === 'inbox');
  const due = items.filter(item => item.due_on && item.due_on <= day() && item.source_state === 'needs_attention');
  return <>
    <nav className="home-variants" aria-label="Home design prototypes">{(['a', 'b', 'c'] as const).map(key => <a key={key} aria-current={key === variant ? 'page' : undefined} href={`/?home=${key}`}>{labels[key]}</a>)}<a href="/">Classic Home ↗</a></nav>
    <header className="home-welcome"><p className="home-kicker">YOUR DAY, IN FOCUS <span>· SYNTHETIC PREVIEW</span></p><p className="home-date">{new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p><h1>Welcome home.</h1><p>Review what matters. Keep your day moving.</p></header>
    {variant === 'a' && <div className="home-day-strip"><div><strong>{attention.length}</strong><span>ready for your attention</span></div><div><strong>{due.length}</strong><span>dated reminders due</span></div><div><strong>Calendar</strong><span>Meetings aren't included here</span><a href="/calendar">View your schedule ↗</a></div><div><strong>Deal pulse</strong><span>Changes aren't included here</span><a href="/deals">Open deals ↗</a></div></div>}
    <div className="home-progress" role="status"><span><b>{attention.length}</b> to review</span><span><b>{items.filter(item => ['working', 'held'].includes(item.section)).length}</b> in motion</span><span><b>{items.filter(item => item.source_state === 'done').length}</b> done in this snapshot</span></div>
    <nav className="home-shortcuts" aria-label="Review workflows"><a href="/#homeCallTasks">Review call follow-ups ↗</a><a href="/#homeEmailFollowups">Review email & filings ↗</a><a href="/deals">Next steps ↗</a></nav>
  </>;
}

export function TodayPanel({ items }: { items: readonly InboxItem[] }) {
  const upcoming = items.filter(item => item.due_on && item.source_state === 'needs_attention').sort((a, b) => (a.due_on || '').localeCompare(b.due_on || ''));
  const working = items.filter(item => item.section === 'working');
  return <aside className="home-today" aria-label="Today"><p className="home-kicker">A LITTLE LOOK AHEAD</p><h2>Today</h2><section><h3>Your schedule</h3><p>Meetings and work blocks aren't included in this inbox.</p><a href="/calendar">Open Calendar ↗</a></section><section><h3>Dated reminders <span>{upcoming.length}</span></h3>{upcoming.slice(0, 3).map(item => <p key={item.item_id}><time>{item.due_on}</time><a href={`${recordRoutes.card(item.item_id)}?home=b`}>{item.title}</a></p>)}{!upcoming.length && <p>No dated reminders in this snapshot.</p>}</section><section><h3>Deal pulse</h3><p>Deal and lead changes aren't included here.</p><a href="/deals">Review your deals ↗</a></section><section><h3>In motion <span>{working.length}</span></h3>{working.map(item => <p key={item.item_id}>{item.title}</p>)}</section></aside>;
}

function Slice({ title, detail, items, row }: { title: string; detail: string; items: readonly InboxItem[]; row: (item: InboxItem) => ReactNode }) {
  const [expanded, expand] = useState(false);
  return <section className="home-slice"><header><div><h2>{title} <span>{items.length}</span></h2><p>{detail}</p></div>{items.length > 1 && <button aria-expanded={expanded} onClick={() => expand(!expanded)}>{expanded ? 'Show less' : `See all ${items.length}`}</button>}</header>{items.length ? (expanded ? items : items.slice(0, 1)).map(row) : <p className="home-slice-empty">Nothing here right now.</p>}</section>;
}
export function HomeSections({ items, row }: { items: readonly InboxItem[]; row: (item: InboxItem) => ReactNode }) {
  const today = day();
  const dueToday = (item: InboxItem) => item.section === 'inbox' && item.due_on === today;
  return <div className="home-sections">
    <Slice title="Needs your attention" detail="One thing at a time. Review, act, move on." items={items.filter(item => item.section === 'inbox' && !dueToday(item))} row={row} />
    <Slice title="Today" detail="Inbox tasks dated today. Open Calendar for meetings and blocks." items={items.filter(dueToday)} row={row} />
    <a className="home-calendar-link" href="/calendar">View today's work schedule ↗</a>
    <Slice title="Waiting on others" detail="Working, held, or set aside. A waiting person isn't supplied." items={items.filter(item => ['working', 'held', 'snoozed'].includes(item.section))} row={row} />
    <Slice title="Recently done" detail="Completed items, sorted by activity. Completion time isn't supplied." items={items.filter(item => ['done', 'settled'].includes(item.section)).sort((a, b) => b.activity_at.localeCompare(a.activity_at))} row={row} />
  </div>;
}
