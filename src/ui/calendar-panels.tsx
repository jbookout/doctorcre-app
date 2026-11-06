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
  const rail = left.closest<HTMLElement>('.app-layout-sidebar');
  function fitMeetings() {
    if (!left.isConnected) { resize.disconnect(); return; }
    if (!rail || !rail.clientHeight) return;
    const previews = [...left.querySelectorAll<HTMLElement>('.calendar-panel-meeting')];
    const link = left.querySelector<HTMLAnchorElement>('.calendar-panel > a:last-child');
    if (!link) return;
    const coverageBody = left.querySelector<HTMLElement>('details[open] > div');
    if (coverageBody) coverageBody.style.maxHeight = '160px';
    for (const preview of previews) preview.hidden = false;
    let shown = previews.length;
    const bottom = rail.getBoundingClientRect().bottom;
    const panel = left.querySelector('.calendar-panel');
    if (!panel) return;
    link.textContent = 'Open Calendar ↗';
    for (const preview of [...previews].reverse()) {
      if (panel.getBoundingClientRect().bottom <= bottom) break;
      preview.hidden = true;
      shown--;
      link.textContent = `${previews.length - shown} more ↗`;
    }
    if (coverageBody) {
      const overflow = panel.getBoundingClientRect().bottom - bottom;
      if (overflow > 0) coverageBody.style.maxHeight = `${Math.max(0, Math.floor(coverageBody.getBoundingClientRect().height - overflow - 1))}px`;
    }
  }
  const resize = new ResizeObserver(fitMeetings);
  if (rail) resize.observe(rail);
  resize.observe(left);
  let revision = 0;
  function render(value: unknown) {
    revision++;
    const today: string = localToday();
    const grid: { title: string; days: { day: string; inMonth: boolean }[] } = monthGrid(today);
    const valid = object(value) && ['ready', 'empty', 'partial'].includes(String(value.state)) && Array.isArray(value.items) && value.items.every(meeting);
    const items = valid && Array.isArray(value.items) ? value.items.filter(meeting).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) : [];
    const now = Date.now();
    const partial = valid && value.state === 'partial';
    const rows = (list: Meeting[]) => list.map((item, index) => <p className="calendar-panel-meeting" key={`${item.start}:${index}`}><time dateTime={item.start}>{item.all_day ? `${meetingDate(item.start)} · All day` : meetingTime(item.start, 'America/Chicago', true)}</time><a href={`/calendar?day=${meetingDay(item)}&d=${meetingDay(item)}`}>{item.title}</a>{(item.schedule_conflict || item.time_changed) && <small>{item.schedule_conflict ? 'Overlapping meetings. Check Outlook.' : 'Time changed. Check Outlook.'}</small>}</p>);
    const status = !valid ? 'Schedule unavailable. Refresh to try again.' : partial ? 'Calendar coverage is incomplete. Check Outlook for changes.' : null;
    const unavailableNotes = valid && (!Array.isArray(value.notes) || value.notes.some(note => typeof note !== 'string'));
    const sourceNotes = valid && Array.isArray(value.notes) ? value.notes : [];
    const notes = [...new Set(sourceNotes.filter((note): note is string => typeof note === 'string' && Boolean(note.trim())).map(note => note.trim()))];
    const shownNotes = notes.slice(0, 20);
    const coverage = () => (partial || notes.length > 0 || unavailableNotes) && <details key={revision} onToggle={fitMeetings}><summary>Calendar coverage</summary><div style={{ maxHeight: '160px', overflowY: 'auto', overflowWrap: 'anywhere' }}>{shownNotes.length ? <ul>{shownNotes.map((note, index) => <li key={index}>{note.length > 500 ? `${note.slice(0, 499)}…` : note}</li>)}</ul> : null}{(!shownNotes.length || unavailableNotes) && <p>Coverage details unavailable.</p>}{notes.length > 20 && <p>{notes.length - 20} more coverage notes not shown.</p>}{shownNotes.some(note => note.length > 500) && <p>Long notes shortened to 500 characters.</p>}</div></details>;
    flushSync(() => {
      calendar.render(<section className="calendar-panel" aria-label="Your calendar"><h3>Your calendar</h3><p>{grid.title}</p><div className="calendar-panel-grid">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => <span key={day} aria-hidden="true">{day}</span>)}{grid.days.map(cell => <a key={cell.day} href={`/calendar?day=${cell.day}&d=${cell.day}`} aria-label={new Date(`${cell.day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} aria-current={cell.day === today ? 'date' : undefined} data-muted={!cell.inMonth || undefined} data-meeting={items.some(item => meetingDay(item) === cell.day) || undefined}>{Number(cell.day.slice(-2))}</a>)}</div><h4>Upcoming meetings</h4>{status && <p role="status">{status}</p>}{coverage()}{rows(items.filter(item => Date.parse(item.end) >= now))}{valid && !items.length && <p>No upcoming meetings returned.</p>}<a href="/calendar">Open Calendar ↗</a></section>);
      const todays = items.filter(item => meetingDay(item) === today);
      schedule.render(<section className="calendar-panel" aria-label="Your schedule"><h3>Your schedule</h3>{status && <p role="status">{status}</p>}{coverage()}{rows(todays.slice(0, 3))}{valid && !todays.length && <p>{partial ? 'No meetings returned for today.' : 'No meetings scheduled today.'}</p>}<a href="/calendar">View your schedule ↗</a></section>);
    });
    fitMeetings();
  }
  return { render, clear: () => render(null) };
}
