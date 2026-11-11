import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export const calendarRecordings = {
  provenance: {"repository":"DoctorCRE/carr-system","source_commit":"f08895ac514770f8ce6eb00a29159a6072da9c46","path":"mcp-server/src/brief-calendar.js","function":"calendarSection","source_sha256":"3926d5ce2d25312407ad3b4dad18f8443cfef75371e30bbb9ebb7cac65fc045c"},
  records: [
    {"name":"empty","now":"2026-11-05T14:00:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-05T14:00:00Z","items":[],"warnings":[]},"response":{"state":"empty","source":"outlook_local_store","notes":[],"observed_at":"2026-11-05T14:00:00.000Z","sources":{"outlook_calendar":{"state":"ready"}},"items":[]}},
    {"name":"same day","now":"2026-11-05T14:00:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-05T14:00:00Z","items":[{"title":"same day","start":"2026-11-05T14:00:00Z","end":"2026-11-05T15:30:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-11-05T14:00:01.000Z","end":"2026-11-05T15:30:00Z"}],"warnings":[]},"response":{"state":"ready","source":"outlook_local_store","notes":[],"observed_at":"2026-11-05T14:00:00.000Z","sources":{"outlook_calendar":{"state":"ready"}},"items":[{"start":"2026-11-05T14:00:00.000Z","end":"2026-11-05T15:30:00.000Z","title":"same day","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-11-05T14:00:01.000Z","end":"2026-11-05T15:30:00.000Z","overlap_start":"2026-11-05T14:00:01.000Z","overlap_end":"2026-11-05T15:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-11-05T14:00:01.000Z","end":"2026-11-05T15:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"same day","start":"2026-11-05T14:00:00.000Z","end":"2026-11-05T15:30:00.000Z","overlap_start":"2026-11-05T14:00:01.000Z","overlap_end":"2026-11-05T15:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"same day partial","now":"2026-11-05T14:00:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-05T14:00:00Z","items":[{"title":"same day","start":"2026-11-05T14:00:00Z","end":"2026-11-05T15:30:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-11-05T14:00:01.000Z","end":"2026-11-05T15:30:00Z"}],"warnings":[{"code":"responses_unverified"}]},"response":{"state":"partial","source":"outlook_local_store","notes":["May include meetings you declined or that were cancelled or deleted. Check Outlook."],"observed_at":"2026-11-05T14:00:00.000Z","sources":{"outlook_calendar":{"state":"partial"}},"items":[{"start":"2026-11-05T14:00:00.000Z","end":"2026-11-05T15:30:00.000Z","title":"same day","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-11-05T14:00:01.000Z","end":"2026-11-05T15:30:00.000Z","overlap_start":"2026-11-05T14:00:01.000Z","overlap_end":"2026-11-05T15:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-11-05T14:00:01.000Z","end":"2026-11-05T15:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"same day","start":"2026-11-05T14:00:00.000Z","end":"2026-11-05T15:30:00.000Z","overlap_start":"2026-11-05T14:00:01.000Z","overlap_end":"2026-11-05T15:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"overnight","now":"2026-11-06T05:30:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-06T05:30:00Z","items":[{"title":"overnight","start":"2026-11-06T05:30:00Z","end":"2026-11-06T07:00:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-11-06T05:30:01.000Z","end":"2026-11-06T07:00:00Z"}],"warnings":[]},"response":{"state":"ready","source":"outlook_local_store","notes":[],"observed_at":"2026-11-06T05:30:00.000Z","sources":{"outlook_calendar":{"state":"ready"}},"items":[{"start":"2026-11-06T05:30:00.000Z","end":"2026-11-06T07:00:00.000Z","title":"overnight","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-11-06T05:30:01.000Z","end":"2026-11-06T07:00:00.000Z","overlap_start":"2026-11-06T05:30:01.000Z","overlap_end":"2026-11-06T07:00:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-11-06T05:30:01.000Z","end":"2026-11-06T07:00:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"overnight","start":"2026-11-06T05:30:00.000Z","end":"2026-11-06T07:00:00.000Z","overlap_start":"2026-11-06T05:30:01.000Z","overlap_end":"2026-11-06T07:00:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"overnight partial","now":"2026-11-06T05:30:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-06T05:30:00Z","items":[{"title":"overnight","start":"2026-11-06T05:30:00Z","end":"2026-11-06T07:00:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-11-06T05:30:01.000Z","end":"2026-11-06T07:00:00Z"}],"warnings":[{"code":"responses_unverified"}]},"response":{"state":"partial","source":"outlook_local_store","notes":["May include meetings you declined or that were cancelled or deleted. Check Outlook."],"observed_at":"2026-11-06T05:30:00.000Z","sources":{"outlook_calendar":{"state":"partial"}},"items":[{"start":"2026-11-06T05:30:00.000Z","end":"2026-11-06T07:00:00.000Z","title":"overnight","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-11-06T05:30:01.000Z","end":"2026-11-06T07:00:00.000Z","overlap_start":"2026-11-06T05:30:01.000Z","overlap_end":"2026-11-06T07:00:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-11-06T05:30:01.000Z","end":"2026-11-06T07:00:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"overnight","start":"2026-11-06T05:30:00.000Z","end":"2026-11-06T07:00:00.000Z","overlap_start":"2026-11-06T05:30:01.000Z","overlap_end":"2026-11-06T07:00:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"spring DST","now":"2026-03-08T07:30:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-03-08T07:30:00Z","items":[{"title":"spring DST","start":"2026-03-08T07:30:00Z","end":"2026-03-08T08:30:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-03-08T07:30:01.000Z","end":"2026-03-08T08:30:00Z"}],"warnings":[]},"response":{"state":"ready","source":"outlook_local_store","notes":[],"observed_at":"2026-03-08T07:30:00.000Z","sources":{"outlook_calendar":{"state":"ready"}},"items":[{"start":"2026-03-08T07:30:00.000Z","end":"2026-03-08T08:30:00.000Z","title":"spring DST","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-03-08T07:30:01.000Z","end":"2026-03-08T08:30:00.000Z","overlap_start":"2026-03-08T07:30:01.000Z","overlap_end":"2026-03-08T08:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-03-08T07:30:01.000Z","end":"2026-03-08T08:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"spring DST","start":"2026-03-08T07:30:00.000Z","end":"2026-03-08T08:30:00.000Z","overlap_start":"2026-03-08T07:30:01.000Z","overlap_end":"2026-03-08T08:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"spring DST partial","now":"2026-03-08T07:30:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-03-08T07:30:00Z","items":[{"title":"spring DST","start":"2026-03-08T07:30:00Z","end":"2026-03-08T08:30:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-03-08T07:30:01.000Z","end":"2026-03-08T08:30:00Z"}],"warnings":[{"code":"responses_unverified"}]},"response":{"state":"partial","source":"outlook_local_store","notes":["May include meetings you declined or that were cancelled or deleted. Check Outlook."],"observed_at":"2026-03-08T07:30:00.000Z","sources":{"outlook_calendar":{"state":"partial"}},"items":[{"start":"2026-03-08T07:30:00.000Z","end":"2026-03-08T08:30:00.000Z","title":"spring DST","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-03-08T07:30:01.000Z","end":"2026-03-08T08:30:00.000Z","overlap_start":"2026-03-08T07:30:01.000Z","overlap_end":"2026-03-08T08:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-03-08T07:30:01.000Z","end":"2026-03-08T08:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"spring DST","start":"2026-03-08T07:30:00.000Z","end":"2026-03-08T08:30:00.000Z","overlap_start":"2026-03-08T07:30:01.000Z","overlap_end":"2026-03-08T08:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"fall DST","now":"2026-11-01T06:30:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-01T06:30:00Z","items":[{"title":"fall DST","start":"2026-11-01T06:30:00Z","end":"2026-11-01T07:30:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-11-01T06:30:01.000Z","end":"2026-11-01T07:30:00Z"}],"warnings":[]},"response":{"state":"ready","source":"outlook_local_store","notes":[],"observed_at":"2026-11-01T06:30:00.000Z","sources":{"outlook_calendar":{"state":"ready"}},"items":[{"start":"2026-11-01T06:30:00.000Z","end":"2026-11-01T07:30:00.000Z","title":"fall DST","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-11-01T06:30:01.000Z","end":"2026-11-01T07:30:00.000Z","overlap_start":"2026-11-01T06:30:01.000Z","overlap_end":"2026-11-01T07:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-11-01T06:30:01.000Z","end":"2026-11-01T07:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"fall DST","start":"2026-11-01T06:30:00.000Z","end":"2026-11-01T07:30:00.000Z","overlap_start":"2026-11-01T06:30:01.000Z","overlap_end":"2026-11-01T07:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"fall DST partial","now":"2026-11-01T06:30:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-01T06:30:00Z","items":[{"title":"fall DST","start":"2026-11-01T06:30:00Z","end":"2026-11-01T07:30:00Z","time_changed":true},{"title":"Overlapping appointment","start":"2026-11-01T06:30:01.000Z","end":"2026-11-01T07:30:00Z"}],"warnings":[{"code":"responses_unverified"}]},"response":{"state":"partial","source":"outlook_local_store","notes":["May include meetings you declined or that were cancelled or deleted. Check Outlook."],"observed_at":"2026-11-01T06:30:00.000Z","sources":{"outlook_calendar":{"state":"partial"}},"items":[{"start":"2026-11-01T06:30:00.000Z","end":"2026-11-01T07:30:00.000Z","title":"fall DST","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2026-11-01T06:30:01.000Z","end":"2026-11-01T07:30:00.000Z","overlap_start":"2026-11-01T06:30:01.000Z","overlap_end":"2026-11-01T07:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2026-11-01T06:30:01.000Z","end":"2026-11-01T07:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"fall DST","start":"2026-11-01T06:30:00.000Z","end":"2026-11-01T07:30:00.000Z","overlap_start":"2026-11-01T06:30:01.000Z","overlap_end":"2026-11-01T07:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"year boundary","now":"2026-12-31T23:30:00-06:00","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-12-31T23:30:00-06:00","items":[{"title":"year boundary","start":"2026-12-31T23:30:00-06:00","end":"2027-01-01T00:30:00-06:00","time_changed":true},{"title":"Overlapping appointment","start":"2027-01-01T05:30:01.000Z","end":"2027-01-01T00:30:00-06:00"}],"warnings":[]},"response":{"state":"ready","source":"outlook_local_store","notes":[],"observed_at":"2027-01-01T05:30:00.000Z","sources":{"outlook_calendar":{"state":"ready"}},"items":[{"start":"2027-01-01T05:30:00.000Z","end":"2027-01-01T06:30:00.000Z","title":"year boundary","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2027-01-01T05:30:01.000Z","end":"2027-01-01T06:30:00.000Z","overlap_start":"2027-01-01T05:30:01.000Z","overlap_end":"2027-01-01T06:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2027-01-01T05:30:01.000Z","end":"2027-01-01T06:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"year boundary","start":"2027-01-01T05:30:00.000Z","end":"2027-01-01T06:30:00.000Z","overlap_start":"2027-01-01T05:30:01.000Z","overlap_end":"2027-01-01T06:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"year boundary partial","now":"2026-12-31T23:30:00-06:00","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-12-31T23:30:00-06:00","items":[{"title":"year boundary","start":"2026-12-31T23:30:00-06:00","end":"2027-01-01T00:30:00-06:00","time_changed":true},{"title":"Overlapping appointment","start":"2027-01-01T05:30:01.000Z","end":"2027-01-01T00:30:00-06:00"}],"warnings":[{"code":"responses_unverified"}]},"response":{"state":"partial","source":"outlook_local_store","notes":["May include meetings you declined or that were cancelled or deleted. Check Outlook."],"observed_at":"2027-01-01T05:30:00.000Z","sources":{"outlook_calendar":{"state":"partial"}},"items":[{"start":"2027-01-01T05:30:00.000Z","end":"2027-01-01T06:30:00.000Z","title":"year boundary","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"Overlapping appointment","start":"2027-01-01T05:30:01.000Z","end":"2027-01-01T06:30:00.000Z","overlap_start":"2027-01-01T05:30:01.000Z","overlap_end":"2027-01-01T06:30:00.000Z"}],"schedule_conflicts_omitted":0},{"start":"2027-01-01T05:30:01.000Z","end":"2027-01-01T06:30:00.000Z","title":"Overlapping appointment","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":true,"schedule_conflicts":[{"title":"year boundary","start":"2027-01-01T05:30:00.000Z","end":"2027-01-01T06:30:00.000Z","overlap_start":"2027-01-01T05:30:01.000Z","overlap_end":"2027-01-01T06:30:00.000Z"}],"schedule_conflicts_omitted":0}]}},
    {"name":"refreshed","now":"2026-11-05T14:00:00Z","snapshot":{"schema":"carr-calendar-agenda.v1","observed_at":"2026-11-05T14:00:00Z","items":[{"title":"Later","start":"2026-11-05T16:00:00Z","end":"2026-11-05T17:00:00Z"},{"title":"Earlier","start":"2026-11-05T14:00:00Z","end":"2026-11-05T15:00:00Z","time_changed":true},{"title":"All day","start":"2026-11-05T00:00:00Z","end":"2026-11-06T00:00:00Z","all_day":true}],"warnings":[]},"response":{"state":"ready","source":"outlook_local_store","notes":[],"observed_at":"2026-11-05T14:00:00.000Z","sources":{"outlook_calendar":{"state":"ready"}},"items":[{"start":"2026-11-05T00:00:00.000Z","end":"2026-11-06T00:00:00.000Z","title":"All day","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":true,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":false,"schedule_conflicts":[],"schedule_conflicts_omitted":0},{"start":"2026-11-05T14:00:00.000Z","end":"2026-11-05T15:00:00.000Z","title":"Earlier","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":true,"times":[],"conflict":false,"schedule_conflict":false,"schedule_conflicts":[],"schedule_conflicts_omitted":0},{"start":"2026-11-05T16:00:00.000Z","end":"2026-11-05T17:00:00.000Z","title":"Later","location":null,"organizer":{"name":null,"email":null},"attendees":[],"attendee_count":0,"all_day":false,"recurring":false,"time_changed":false,"times":[],"conflict":false,"schedule_conflict":false,"schedule_conflicts":[],"schedule_conflicts_omitted":0}]}}
  ],
};

export async function observe(recordings) {
  const response = name => structuredClone(recordings.records.find(record => record.name === name).response);
  const { mountCalendarPanels } = await import('/js/ui-calendar-panels.generated.js');
  const left = document.querySelector('#left'), right = document.querySelector('#right');
  const panel = await mountCalendarPanels(left, right);
  const labels = node => [...node.querySelectorAll('.calendar-panel-meeting time')].map(el => el.textContent);
  const checks = [];
  const check = (name, value) => checks.push({ name, pass: Boolean(value) });
  panel.clear();
  check('mount and clear', left.textContent.includes('Schedule unavailable'));
  panel.render(response('empty'));
  check('empty snapshot', left.textContent.includes('No upcoming meetings returned'));
  const cases = [
    ['same day', '2026-11-05T14:00:00Z', '2026-11-05T15:30:00Z', 'Nov 5, 8:00 AM CST – 9:30 AM CST'],
    ['overnight', '2026-11-06T05:30:00Z', '2026-11-06T07:00:00Z', 'Nov 5, 11:30 PM CST – Nov 6, 1:00 AM CST'],
    ['spring DST', '2026-03-08T07:30:00Z', '2026-03-08T08:30:00Z', 'Mar 8, 1:30 AM CST – 3:30 AM CDT'],
    ['fall DST', '2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z', 'Nov 1, 1:30 AM CDT – 1:30 AM CST'],
    ['year boundary', '2026-12-31T23:30:00-06:00', '2027-01-01T00:30:00-06:00', 'Dec 31, 2026, 11:30 PM CST – Jan 1, 2027, 12:30 AM CST'],
  ];
  for (const [title, start, end, expected] of cases) {
    await window.proofSetTime(start);
    panel.render(response(title));
    check(title, labels(left)[0] === expected && labels(right)[0] === expected);
    check(`${title} warning`, left.textContent.includes('Overlapping meetings. Check Outlook.'));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start));
    check(`${title} day link`, left.querySelector('.calendar-panel-meeting a').getAttribute('href') === `/calendar?day=${day}&d=${day}`);
    panel.render(response(`${title} partial`));
    check(`${title} partial refresh`, left.textContent.includes('coverage is incomplete') && labels(left)[0] === expected);
    panel.render(response(title));
    check(`${title} ready refresh`, !left.querySelector('[role=status]'));
    await window.proofSetTime(new Date(Date.parse(end) + 1).toISOString());
    panel.render(response(title));
    check(`${title} elapsed filter`, labels(left).length === 0);
  }
  await window.proofSetTime('2026-11-05T14:00:00Z');
  const refreshed = response('refreshed');
  panel.render(refreshed);
  check('refreshed sorted rows and all day', labels(left)[0] === 'Nov 5 · All day' && left.querySelectorAll('.calendar-panel-meeting a')[1].textContent === 'Earlier');
  check('changed warning', left.textContent.includes('Time changed. Check Outlook.'));
  const rail = left.parentElement;
  const resizeRail = height => new Promise(resolve => {
    const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(rail);
    rail.style.height = height;
  });
  await resizeRail('250px');
  check('rail shrinks', left.querySelectorAll('.calendar-panel-meeting[hidden]').length > 0);
  await resizeRail('1600px');
  check('rail grows', left.querySelectorAll('.calendar-panel-meeting[hidden]').length === 0);
  panel.render({ state: 'ready', items: [{ title: 'bad', start: 'invalid', end: 'invalid' }] });
  check('invalid snapshot', labels(left).length === 0 && left.textContent.includes('Schedule unavailable'));
  panel.render(refreshed);
  panel.clear();
  check('session clear', labels(left).length === 0 && labels(right).length === 0);
  left.remove();
  panel.clear();
  check('detached clear', labels(right).length === 0);
  panel.render(refreshed);
  return checks;
}

export async function prove({ fixtureRoot, origin = 'https://app.doctorcre.com', expectedCommit, timeoutMs = 30000, engine = chromium }) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'bounded deadline');
  assert.equal(new URL(origin).origin, origin, 'origin only');
  const failure = Object.assign(new Error('insufficient_evidence: proof deadline exceeded'), { exitCode: 78 });
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  if (!fixtureRoot && (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit))) throw unavailable('Expected commit is required for endpoint evidence');
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const remaining = () => {
    controller.signal.throwIfAborted();
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw failure;
    return ms;
  };
  const timer = setTimeout(() => controller.abort(failure), timeoutMs);
  let browser, bytes = 0, requests = 0;
  let root;
  const assets = new Map();
  async function read(path) {
    assert.ok(++requests <= 64, 'request cap');
    let body;
    if (root) {
      const file = await realpath(resolve(root, `.${path}`));
      assert.ok(file.startsWith(root + sep), 'fixture path confined');
      body = await readFile(file);
    } else {
      const response = await proofFetch(new URL(path, origin), { signal: controller.signal });
      assert.ok(response.ok && /javascript|text\/css/.test(response.headers.get('content-type')), 'JavaScript asset available');
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap');
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    if (root) { bytes += body.length; assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap'); }
    assets.set(path, body);
    return body;
  }
  try {
    root = fixtureRoot ? await realpath(fixtureRoot) : null;
    const before = root ? null : await readAppRelease(origin, { timeoutMs: remaining() });
    if (before && before.source_commit !== expectedCommit) {
      try {
        await new Promise((resolve, reject) => {
          let failure;
          const child = execFile('git', ['merge-base', '--is-ancestor', expectedCommit, before.source_commit], { timeout: Math.min(remaining(), 5000), signal: controller.signal, killSignal: 'SIGKILL' }, error => { failure = error; });
          child.once('close', () => failure ? reject(failure) : resolve());
        });
      } catch { throw unavailable('Release does not establish expected commit containment'); }
    }
    remaining();
    await read('/js/ui-calendar-panels.generated.js');
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() }, { signal: controller.signal });
    const observations = [];
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, timezoneId: 'America/Chicago', serviceWorkers: 'block' });
      await page.clock.setFixedTime(new Date('2026-11-05T14:00:00Z'));
      await page.exposeFunction('proofSetTime', value => page.clock.setFixedTime(new Date(value)));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
        if (url.pathname === '/calendar') return route.fulfill({ contentType: 'text/html', body: '<h1>Calendar</h1>' });
        if (url.pathname === '/__meeting-proof') return route.fulfill({ contentType: 'text/html', body: `<html data-theme="${theme}"><head><link rel="stylesheet" href="/css/app-shell.css"></head><body><aside class="app-layout-sidebar" style="height:900px;width:300px"><div id="left"></div></aside><div id="right"></div></body></html>` });
        if (!/^\/(?:js\/[a-zA-Z0-9._/-]+\.m?js|css\/[a-zA-Z0-9._/-]+\.css)$/.test(url.pathname)) return route.abort();
        try { await route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: assets.get(url.pathname) || await read(url.pathname) }); }
        catch { await route.abort(); }
      });
      await page.goto(`${origin}/__meeting-proof`);
      const checks = await page.evaluate(observe, calendarRecordings);
      assert.deepEqual(checks.filter(check => !check.pass), [], `rendered endpoint checks at ${width} ${theme}`);
      await page.locator('#right .calendar-panel-meeting a').first().click();
      assert.equal(new URL(page.url()).searchParams.get('day'), '2026-11-05', 'calendar day navigation');
      observations.push({ width, theme, checks });
      await page.close();
    }
    const after = root ? null : await readAppRelease(origin, { timeoutMs: remaining() });
    remaining();
    if (!isDeepStrictEqual(after, before)) throw unavailable('Release changed during proof');
    return { ok: true, evidence: root ? 'local_fixture' : 'deployed_asset_fixture', natural_authenticated_observation: 'not_run', production_acceptance: 'insufficient_evidence', release: before, observations, requests };
  } catch (error) {
    if (controller.signal.aborted || performance.now() >= deadline) throw failure;
    throw error;
  } finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    const flags = new Map([['--fixture-root', 'fixtureRoot'], ['--origin', 'origin'], ['--expected-commit', 'expectedCommit'], ['--timeout-ms', 'timeoutMs']]);
    for (let index = 0; index < args.length; index += 2) {
      const key = flags.get(args[index]), value = args[index + 1];
      assert.ok(key && value && !value.startsWith('--') && !Object.hasOwn(options, key), 'usage: --fixture-root PATH | --origin URL --expected-commit SHA [--timeout-ms MS]');
      options[key] = key === 'timeoutMs' ? Number(value) : value;
    }
    assert.ok(Boolean(options.fixtureRoot) !== Boolean(options.origin), 'choose fixture root or endpoint origin');
    console.log(JSON.stringify(await prove(options)));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = error.exitCode || 1; }
}
