import { BUSINESS_TIME_ZONE } from './business-date.js';
import { addDays, toDay } from './calendar-model.js';

export const meetingTime = (value, timeZone, includeDate = false) => new Intl.DateTimeFormat('en-US', {
  timeZone, ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
  hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
}).format(new Date(value));

export const meetingDate = value => new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

export function homeWeek({ agenda, calendar, today, timeZone = BUSINESS_TIME_ZONE }) {
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = Array.from({ length: 7 }, (_, index) => ({ day: addDays(today, index), dated: [], allDay: [], timed: [] }));
  const byDay = new Map(days.map(day => [day.day, day]));
  for (const entry of agenda?.entries || []) {
    const day = byDay.get(entry.day);
    if (day) day.dated.push(entry);
  }
  const occurrences = new Map();
  if (['ready', 'partial'].includes(calendar?.state)) for (const meeting of calendar.items) {
    const day = meeting.all_day ? toDay(meeting.start.slice(0, 10)) : dayFormat.format(new Date(meeting.start));
    const target = byDay.get(day);
    if (!target) continue;
    const identity = JSON.stringify([meeting.start, meeting.title, meeting.location, meeting.attendee_count, meeting.all_day]);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    const entry = { ...meeting, key: `meeting:${identity}:${occurrence}`, type: 'meeting', day, label: meeting.title,
      time: meeting.all_day ? 'All day' : meetingTime(meeting.start, timeZone) };
    target[meeting.all_day ? 'allDay' : 'timed'].push(entry);
  }
  for (const day of days) day.timed.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.key.localeCompare(b.key));
  return days;
}
