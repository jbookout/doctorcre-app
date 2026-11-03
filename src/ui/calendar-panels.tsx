import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Meeting = { title: string; start: string; end: string; all_day?: boolean; schedule_conflict?: boolean; time_changed?: boolean };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function meeting(value: unknown): value is Meeting {
  return object(value) && typeof value.title === 'string' && instant(value.start) && instant(value.end)
    && ['all_day', 'schedule_conflict', 'time_changed'].every(key => value[key] === undefined || typeof value[key] === 'boolean');
}
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
const meetingDay = (item: Meeting) => item.all_day ? item.start.slice(0, 10) : dayFormat.format(new Date(item.start));
const sibling = (path: string) => import(new URL(path, import.meta.url).href);

export async function mountCalendarPanels(left: HTMLElement, right: HTMLElement) {
  const { monthGrid, localToday } = await sibling('./calendar-model.js');
  const { meetingTime, meetingDate } = await sibling('./home-week.js');
  const calendar = createRoot(left), schedule = createRoot(right);
  function render(value: unknown) {
    const today: string = localToday();
    const grid: { title: string; days: { day: string; inMonth: boolean }[] } = monthGrid(today);
    const valid = object(value) && ['ready', 'empty', 'partial'].includes(String(value.state)) && Array.isArray(value.items) && value.items.every(meeting);
    const items = valid && Array.isArray(value.items) ? value.items.filter(meeting).sort((a, b) => a.start.localeCompare(b.start)) : [];
    const partial = valid && value.state === 'partial';
    const rows = (list: Meeting[]) => list.map((item, index) => <p className="calendar-panel-meeting" key={`${item.start}:${index}`}><time dateTime={item.start}>{item.all_day ? `${meetingDate(item.start)} · All day` : meetingTime(item.start, 'America/Chicago', true)}</time><a href={`/calendar?day=${meetingDay(item)}&d=${meetingDay(item)}`}>{item.title}</a>{(item.schedule_conflict || item.time_changed) && <small>{item.schedule_conflict ? 'Overlapping meetings. Check Outlook.' : 'Time changed. Check Outlook.'}</small>}</p>);
    const status = !valid ? 'Schedule unavailable. Refresh to try again.' : partial ? 'Calendar coverage is incomplete. Check Outlook for changes.' : null;
    flushSync(() => {
      calendar.render(<section className="calendar-panel" aria-label="Your calendar"><h3>Your calendar</h3><p>{grid.title}</p><div className="calendar-panel-grid">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => <span key={day} aria-hidden="true">{day}</span>)}{grid.days.map(cell => <a key={cell.day} href={`/calendar?day=${cell.day}&d=${cell.day}`} aria-label={cell.day} aria-current={cell.day === today ? 'date' : undefined} data-muted={!cell.inMonth || undefined} data-meeting={items.some(item => meetingDay(item) === cell.day) || undefined}>{Number(cell.day.slice(-2))}</a>)}</div><h4>Upcoming meetings</h4>{status && <p role="status">{status}</p>}{rows(items.filter(item => item.end >= new Date().toISOString()).slice(0, 3))}{valid && !items.length && <p>No upcoming meetings returned.</p>}<a href="/calendar">Open Calendar ↗</a></section>);
      const todays = items.filter(item => meetingDay(item) === today);
      schedule.render(<section className="calendar-panel" aria-label="Your schedule"><h3>Your schedule</h3>{status && <p role="status">{status}</p>}{rows(todays.slice(0, 3))}{valid && !todays.length && <p>{partial ? 'No meetings returned for today.' : 'No meetings scheduled today.'}</p>}<a href="/calendar">View your schedule ↗</a></section>);
    });
  }
  return { render, clear: () => render(null) };
}
