import { BUSINESS_TIME_ZONE, businessDay } from './business-date.js';
import { addDays, toDay } from './calendar-model.js';

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
});

export function homeWeek({ agenda, calendar, today }) {
  const days = Array.from({ length: 7 }, (_, index) => ({ day: addDays(today, index), allDay: [], timed: [] }));
  const byDay = new Map(days.map(day => [day.day, day]));
  for (const entry of agenda?.entries || []) {
    const day = byDay.get(entry.day);
    if (day) day.allDay.push({ ...entry, time: 'All day' });
  }
  const occurrences = new Map();
  if (['ready', 'partial'].includes(calendar?.state)) for (const meeting of calendar.items) {
    const day = meeting.all_day ? toDay(meeting.start.slice(0, 10)) : businessDay(new Date(meeting.start));
    const target = byDay.get(day);
    if (!target) continue;
    const identity = JSON.stringify([meeting.start, meeting.title, meeting.location, meeting.attendee_count, meeting.all_day]);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    const entry = { ...meeting, key: `meeting:${identity}:${occurrence}`, type: 'meeting', day, label: meeting.title,
      time: meeting.all_day ? 'All day' : timeFormat.format(new Date(meeting.start)) };
    target[meeting.all_day ? 'allDay' : 'timed'].push(entry);
  }
  for (const day of days) day.timed.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.key.localeCompare(b.key));
  return days;
}
