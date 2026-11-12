import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { mountWorkingWeek } from "./home/working-week";

type Meeting = {
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  schedule_conflict?: boolean;
  time_changed?: boolean;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function meeting(value: unknown): value is Meeting {
  return (
    object(value) &&
    typeof value.title === "string" &&
    instant(value.start) &&
    instant(value.end) &&
    ["all_day", "schedule_conflict", "time_changed"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    )
  );
}
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const meetingDay = (item: Meeting) => (item.all_day ? item.start.slice(0, 10) : dayFormat.format(new Date(item.start)));
const endpointFormat = (date: boolean, year: boolean) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    ...(date ? { month: "short", day: "numeric" } : {}),
    ...(year ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
const rangeStart = endpointFormat(true, false),
  rangeEnd = endpointFormat(false, false),
  rangeYear = endpointFormat(true, true);
function meetingRange(item: Meeting) {
  const start = new Date(item.start),
    end = new Date(item.end);
  const startDay = dayFormat.format(start),
    endDay = dayFormat.format(end);
  const crossesYear = startDay.slice(0, 4) !== endDay.slice(0, 4);
  const first = crossesYear ? rangeYear : rangeStart;
  const last = crossesYear ? rangeYear : startDay === endDay ? rangeEnd : rangeStart;
  return `${first.format(start)} – ${last.format(end)}`;
}
const sibling = (path: string) => import(new URL(path, import.meta.url).href);

export async function mountCalendarPanels(left: HTMLElement, right: HTMLElement, weekHost?: HTMLElement) {
  const week = weekHost ? await mountWorkingWeek(weekHost) : null;
  const { monthGrid, localToday } = await sibling("./calendar-model.js");
  const { meetingDate } = await sibling("./home-week.js");
  const calendar = createRoot(left),
    schedule = createRoot(right);
  const rail = left.closest<HTMLElement>(".app-layout-sidebar");
  function fitMeetings() {
    if (!left.isConnected) {
      resize.disconnect();
      return;
    }
    if (!rail?.clientHeight) return;
    const previews = [...left.querySelectorAll<HTMLElement>(".calendar-panel-meeting")];
    const link = left.querySelector<HTMLAnchorElement>(".calendar-panel > a:last-child");
    if (!link) return;
    const coverageBody = left.querySelector<HTMLElement>("details[open] > div");
    if (coverageBody) coverageBody.style.maxHeight = "160px";
    for (const preview of previews) preview.hidden = false;
    let shown = previews.length;
    const bottom = rail.getBoundingClientRect().bottom;
    const panel = left.querySelector(".calendar-panel");
    if (!panel) return;
    link.textContent = "Open Calendar ↗";
    for (const preview of [...previews].reverse()) {
      if (panel.getBoundingClientRect().bottom <= bottom) break;
      preview.hidden = true;
      shown--;
      link.textContent = `${previews.length - shown} more ↗`;
    }
    if (coverageBody) {
      const overflow = panel.getBoundingClientRect().bottom - bottom;
      if (overflow > 0)
        coverageBody.style.maxHeight = `${Math.max(0, Math.floor(coverageBody.getBoundingClientRect().height - overflow - 1))}px`;
    }
  }
  const resize = new ResizeObserver(fitMeetings);
  if (rail) resize.observe(rail);
  resize.observe(left);
  let revision = 0,
    retired = false;
  function render(value: unknown, agenda: { board: unknown; details: Map<string, unknown> } | null = null) {
    if (retired) return;
    revision++;
    const today: string = localToday();
    const grid: { title: string; days: { day: string; inMonth: boolean }[] } = monthGrid(today);
    const valid =
      object(value) &&
      ["ready", "empty", "partial"].includes(String(value.state)) &&
      Array.isArray(value.items) &&
      value.items.every(meeting);
    const items =
      valid && Array.isArray(value.items)
        ? value.items.filter(meeting).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        : [];
    week?.render(
      valid
        ? {
            state: String(value.state),
            items: items.map((item) => ({
              ...item,
              location: "location" in item && typeof item.location === "string" ? item.location : null,
            })),
            ...(Array.isArray(value.notes) ? { notes: value.notes } : {}),
          }
        : null,
      agenda,
    );
    const now = Date.now();
    const partial = valid && value.state === "partial";
    const rows = (list: Meeting[]) => {
      const occurrences = new Map<string, number>();
      return list.map((item) => {
        const identity = JSON.stringify(item);
        const occurrence = occurrences.get(identity) || 0;
        occurrences.set(identity, occurrence + 1);
        return (
          <p className="calendar-panel-meeting" key={`${identity}:${occurrence}`}>
            <time dateTime={item.start}>
              {item.all_day ? `${meetingDate(item.start)} · All day` : meetingRange(item)}
            </time>
            <a href={`/calendar?day=${meetingDay(item)}&d=${meetingDay(item)}`}>{item.title}</a>
            {(item.schedule_conflict || item.time_changed) && (
              <small>
                {item.schedule_conflict ? "Overlapping meetings. Check Outlook." : "Time changed. Check Outlook."}
              </small>
            )}
          </p>
        );
      });
    };
    const status = !valid
      ? "Schedule unavailable. Refresh to try again."
      : partial
        ? "Calendar coverage is incomplete. Check Outlook for changes."
        : null;
    const unavailableNotes =
      valid && (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== "string"));
    const sourceNotes = valid && Array.isArray(value.notes) ? value.notes : [];
    const notes = [
      ...new Set(
        sourceNotes
          .filter((note): note is string => typeof note === "string" && Boolean(note.trim()))
          .map((note) => note.trim()),
      ),
    ];
    const shownNotes = notes.slice(0, 20);
    const coverage = () =>
      (partial || notes.length > 0 || unavailableNotes) && (
        <details key={revision} onToggle={fitMeetings}>
          <summary>Calendar coverage</summary>
          <div style={{ maxHeight: "160px", overflowY: "auto", overflowWrap: "anywhere" }}>
            {shownNotes.length ? (
              <ul>
                {shownNotes.map((note) => (
                  <li key={note}>{note.length > 500 ? `${note.slice(0, 499)}…` : note}</li>
                ))}
              </ul>
            ) : null}
            {(!shownNotes.length || unavailableNotes) && <p>Coverage details unavailable.</p>}
            {notes.length > 20 && <p>{notes.length - 20} more coverage notes not shown.</p>}
            {shownNotes.some((note) => note.length > 500) && <p>Long notes shortened to 500 characters.</p>}
          </div>
        </details>
      );
    flushSync(() => {
      calendar.render(
        <section className="calendar-panel" aria-label="Your calendar">
          <h3>Your calendar</h3>
          <p>{grid.title}</p>
          <div className="calendar-panel-grid">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
              <span key={day} aria-hidden="true">
                {day}
              </span>
            ))}
            {grid.days.map((cell) => (
              <a
                key={cell.day}
                href={`/calendar?day=${cell.day}&d=${cell.day}`}
                aria-label={new Date(`${cell.day}T12:00:00Z`).toLocaleDateString("en-US", {
                  timeZone: "UTC",
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
                aria-current={cell.day === today ? "date" : undefined}
                data-muted={!cell.inMonth || undefined}
                data-meeting={items.some((item) => meetingDay(item) === cell.day) || undefined}
              >
                {Number(cell.day.slice(-2))}
              </a>
            ))}
          </div>
          <h4>Upcoming meetings</h4>
          {status && <p role="status">{status}</p>}
          {coverage()}
          {rows(items.filter((item) => Date.parse(item.end) >= now))}
          {valid && !items.length && <p>No upcoming meetings returned.</p>}
          <a href="/calendar">Open Calendar ↗</a>
        </section>,
      );
      const todays = items.filter((item) => meetingDay(item) === today);
      schedule.render(
        <section className="calendar-panel" aria-label="Your schedule">
          <h3>Your schedule</h3>
          {status && <p role="status">{status}</p>}
          {coverage()}
          {rows(todays.slice(0, 3))}
          {valid && !todays.length && (
            <p>{partial ? "No meetings returned for today." : "No meetings scheduled today."}</p>
          )}
          <a href="/calendar">View your schedule ↗</a>
        </section>,
      );
    });
    fitMeetings();
  }
  return {
    render,
    clear: () => render(null),
    retire: () => {
      if (retired) return;
      retired = true;
      week?.retire();
      calendar.unmount();
      schedule.unmount();
      resize.disconnect();
    },
  };
}
