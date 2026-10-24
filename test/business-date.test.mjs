import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDay, overnightCutoff } from '../js/business-date.js';
import { localToday, toDay } from '../js/calendar-model.js';
import { localDay, morningBriefView } from '../js/morning-brief-model.js';

for (const [instant,day,cutoff] of [
  ['2026-10-24T04:59:59Z','2026-10-23','2026-10-22T22:00:00.000Z'],
  ['2026-10-24T05:00:00Z','2026-10-24','2026-10-23T22:00:00.000Z'],
  ['2026-01-24T05:59:59Z','2026-01-23','2026-01-22T23:00:00.000Z'],
  ['2026-01-24T06:00:00Z','2026-01-24','2026-01-23T23:00:00.000Z'],
  ['2026-03-08T07:59:59Z','2026-03-08','2026-03-07T23:00:00.000Z'],
  ['2026-03-08T08:00:00Z','2026-03-08','2026-03-07T23:00:00.000Z'],
  ['2026-03-09T13:00:00Z','2026-03-09','2026-03-08T22:00:00.000Z'],
  ['2026-11-01T06:59:59Z','2026-11-01','2026-10-31T22:00:00.000Z'],
  ['2026-11-01T07:00:00Z','2026-11-01','2026-10-31T22:00:00.000Z'],
  ['2026-11-02T14:00:00Z','2026-11-02','2026-11-01T23:00:00.000Z'],
]) test(`Chicago calendar and overnight boundary at ${instant}`,()=>{
  const now=new Date(instant);
  assert.equal(businessDay(now),day);assert.equal(localDay(now),day);assert.equal(localToday(now),day);
  assert.equal(overnightCutoff(now),cutoff);
});

test('date-only and serialized DATE values keep their day while due eligibility uses Chicago',()=>{
  const section=items=>({state:items.length?'ready':'empty',items});
  const data={sponsor:'joe',sections:{today:section([{id:'demo-action',item_kind:'next_action',subject_type:'person',what:'Demo midnight action',due_on:'2026-10-24T00:00:00.000Z'}]),deals:section([]),loops:section([])}};
  assert.equal(toDay(data.sections.today.items[0].due_on),'2026-10-24');
  assert.equal(morningBriefView(data,{now:new Date('2026-10-24T04:59:59Z')}).groups.length,0);
  assert.equal(morningBriefView(data,{now:new Date('2026-10-24T05:00:00Z')}).groups.length,1);
});
