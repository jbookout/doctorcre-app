import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { dealTimeline, countdown, renderDealTimeline, renderDealUpdates, renderCriticalDates, calendarDay, updateCountdowns } from '../js/deal-timeline.js';
import { createLiveClient } from '../js/live-client.js';
import { readFile } from 'node:fs/promises';
const now = Date.parse('2026-10-04T17:00:00Z');
const detail = {deal:{id:'demo',phase:'Legal',phase_started_on:{research:'2026-09-20',legal:'2026-10-03'}},history:[
  {id:'p1',field:'phase',new_value:{phase:'research'},recorded_at:'2026-09-20T12:00:00Z'},
  {id:'p2',field:'phase',new_value:'legal',recorded_at:'2026-10-03T12:00:00Z'},
],lease:{id:'demo-lease',status:'current',commencement_on:'2026-11-01',expiration_on:'2031-10-31',source:'Demo abstract',evidence_ref:'Demo clause 3',free_rent_months:2},
critical_dates:[{id:'loi',kind:'loi_expiry',due_on:'2026-10-03',source:'Demo contract'}],
thread:[{id:'note',kind:'note',at:'2026-10-01',text:'Demo note. '+ 'Original. '.repeat(30)}],
activities:[{id:'mail',kind:'email',summary:'Demo negotiated allowance',detail:'Original demo email <script>data only</script>',occurred_at:'2026-10-02T12:00:00Z'}],
documents:[{id:'doc',note:'Demo revised lease',prepared_at:'2026-10-03T12:00:00Z'}]};
test('phases use recorded entries; lease dates are exact and no rent/option date is calculated',()=>{
 const view = dealTimeline(detail,now);
 assert.equal(view.phases.find(p=>p.slug==='legal').day,'2026-10-03');
 assert.equal(view.phases.find(p=>p.slug==='pending').day,null);
 assert.equal(view.dates.find(d=>d.kind==='lease_commencement').day,'2026-11-01');
 assert.deepEqual(view.missing.map(d=>d.kind),['due_diligence','rent_start','option_window']);
 assert.equal(dealTimeline({...detail,lease:{...detail.lease,status:'superseded'}}).dates.some(d=>d.kind==='lease_commencement'),false);
 assert.equal(calendarDay('2026-02-30'),null);
});
test('conflicting contract dates remain visible; co-located originals survive; kind is never inferred from prose',()=>{
 const view=dealTimeline({...detail,critical_dates:[{kind:'lease_commencement',due_on:'2026-11-01',note:'Demo signed contract date',source:'Demo contract clause'}, {kind:'commencement',due_on:'2026-11-02'}, {label:'Rent start',due_on:'2026-11-30'}]},now);
 assert.deepEqual(view.dates.filter(d=>d.kind==='lease_commencement').map(d=>d.day),['2026-11-01','2026-11-02']);
 assert.ok(view.missing.some(d=>d.kind==='rent_start'));
 assert.match(view.dates.find(d=>d.day==='2026-11-01').original,/Demo signed contract date/);
 assert.match(view.dates.find(d=>d.day==='2026-11-01').original,/Demo clause 3/);
 const statuses=dealTimeline({...detail,critical_dates:[{kind:'loi_expiry',due_on:'2026-10-03',status:'cleared'},{kind:'loi_expiry',due_on:'2026-10-03',status:'open'}]},now);
 assert.equal(statuses.dates.filter(d=>d.kind==='loi_expiry').length,2);
});
test('countdowns cross midnight and distinguish deadlines, cleared dates and past commencement',()=>{
 assert.deepEqual(countdown({day:'2026-10-04',deadline:true},now),{state:'today',text:'Due today'});
 assert.deepEqual(countdown({day:'2026-10-05',deadline:true},now),{state:'soon',text:'1 day'});
 assert.equal(countdown({day:'2026-10-03',deadline:true},now).text,'1 day overdue');
 assert.equal(countdown({day:'2026-10-03'},now).text,'1 day ago');
 assert.equal(countdown({day:'2026-10-03',status:'cleared'},now).text,'Cleared');
 const root=new JSDOM(renderCriticalDates(detail,now)).window.document;
 updateCountdowns(root,now+86400000);
 assert.equal(root.querySelector('[data-countdown="2026-10-03"]').textContent,'2 days overdue');
});
test('updates preserve escaped originals, author, exact date and newest-first order',()=>{
 const html=renderDealUpdates(detail);
 assert.match(html,/Original demo email &lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 const root=new JSDOM(html).window.document;
 assert.equal(root.querySelectorAll('.deal-note').length,2);
 assert.equal(root.querySelector('.deal-note time').dateTime,'2026-10-02T12:00:00Z');
 assert.equal(new JSDOM(renderDealTimeline(detail)).window.document.querySelectorAll('.phase-rail').length,1);
});
test('the live adapter preserves the versioned lease and explicit absence behind getDeal',async()=>{
 const contract=JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json',import.meta.url),'utf8')).mcp_read_contracts['get-deal-room'];
 assert.equal(contract.response.schema_version,'deal-timeline.v1');
 assert.match(contract.producer.source_commit,/^[a-f0-9]{40}$/);
 const calls=[];
 for(const lease of [detail.lease,null]) {
  const client=createLiveClient({fetchImpl:async(path,init)=>{
   calls.push({path,init});return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({deal_id:'demo',name:'Demo assignment',phase:'legal',schema_version:'deal-timeline.v1',lease})}]}}),{status:200});
  }});
  const value=await client.getDeal('demo');assert.deepEqual(value.lease,lease);assert.equal(value.schema_version,'deal-timeline.v1');
 }
 assert.ok(calls.every(c=>c.path==='/mcp' && c.init.credentials==='same-origin'));
 assert.deepEqual(JSON.parse(calls[0].init.body).params,{name:'get-deal-room',arguments:{deal:'demo'}});
});
test('summary-only activity does not offer a fabricated original',()=>{
 const html=renderDealUpdates({activities:[{id:'mail',kind:'email',summary:'Demo summary',occurred_at:'2026-10-02T12:00:00Z'}]});
 assert.doesNotMatch(html,/unavailable|Read full update/);
});

test('zero notes omit the entire Updates section',()=>{
 assert.equal(renderDealUpdates({thread:[],activities:[]}), '');
});

test('review 1: producer cleared and passed dates do not raise deadline alarms',()=>{
 for (const [status,state,text] of [['cleared','complete','Cleared'],['passed','past','Passed'],['open','overdue','1 day overdue']]) {
  const value={deal:detail.deal,critical_dates:[{id:'loi',kind:'loi_expiry',due_on:'2026-10-03',status}]};
  assert.deepEqual(countdown(dealTimeline(value,now).dates[0],now),{state,text});
  const root=new JSDOM(renderCriticalDates(value,now)).window.document;
  updateCountdowns(root,now+86400000);
  assert.equal(root.querySelector('[data-date-id="loi"]').dataset.state,state);
  if(status!=='open') assert.equal(root.querySelector('strong').textContent,text);
 }
});
test('review 2: recorded and projected lease expiration share urgency while commencement stays a milestone',()=>{
 for(const day of ['2026-10-03','2026-10-07']) {
  const expected=day==='2026-10-03'?'overdue':'soon';
  for(const lease of [null,{...detail.lease,expiration_on:day}]) {
   const value={deal:detail.deal,lease,critical_dates:lease?[]:[{id:'expiry',kind:'lease_expiration',due_on:day,status:'open'}]};
   const date=dealTimeline(value,now).dates.find(d=>d.kind==='lease_expiration');
   assert.equal(countdown(date,now).state,expected);
   const root=new JSDOM(renderCriticalDates(value,now)).window.document;
   assert.equal(root.querySelector(`[data-countdown="${day}"]`).closest('article').dataset.state,expected);
  }
  const date=dealTimeline({deal:detail.deal,critical_dates:[{kind:'lease_commencement',due_on:day,status:'open'}]},now).dates[0];
  assert.equal(countdown(date,now).state,day==='2026-10-03'?'past':'upcoming');
 }
});

test('updates collapse into one deterministic overview of every entry with full history on demand',()=>{
 const root=new JSDOM(renderDealUpdates(detail)).window.document;
 const overview=root.querySelector('.updates-overview');
 assert.ok(overview);
 assert.match(overview.textContent,/Demo negotiated allowance/);
 assert.match(overview.textContent,/Demo note/);
 assert.ok(overview.textContent.length<400);
 const history=root.querySelector('.updates-history');
 assert.equal(history.open,false);
 assert.match(history.querySelector('summary').textContent,/Recorded updates.*2/);
 assert.match(history.textContent,/Original demo email <script>data only<\/script>/);
 assert.equal(root.querySelectorAll('.deal-note').length,2);
});

test('timeline consumes first phase dates from the board projection and never overwrites them with a later revisit',()=>{
 const value={...detail,deal:{...detail.deal,phase_started_on:{research:'2026-08-31',legal:'2026-09-30'}},history:[...detail.history,{field:'phase',new_value:'research',recorded_at:'2026-10-04T12:00:00Z'}]};
 const phases=dealTimeline(value,now).phases;
 assert.equal(phases.find(p=>p.slug==='research').day,'2026-08-31');
 assert.equal(phases.find(p=>p.slug==='legal').day,'2026-09-30');
 assert.match(renderDealTimeline(value,now),/Start date not recorded/);
});

test('the live adapter preserves authoritative start dates in both board and detail reads',async()=>{
 const phase_started_on={research:'2026-08-31',legal:'2026-09-30'};
 const client=createLiveClient({fetchImpl:async(_path,init)=>{
  const {name}=JSON.parse(init.body).params;
  const result=name==='deal-room-board'?{deals:[{id:'demo',phase:'legal',next_step:'Review the draft',phase_started_on}]}:{deal_id:'demo',phase:'legal',next_step:'Review the draft',phase_started_on};
  return new Response(JSON.stringify({result:{content:[{text:JSON.stringify(result)}]}}));
 }});
 assert.deepEqual((await client.getBoard()).deals[0].phase_started_on,phase_started_on);
 const detail=await client.getDeal('demo');
 assert.deepEqual(detail.deal.phase_started_on,phase_started_on);
 assert.equal(dealTimeline(detail).phases.find(p=>p.slug==='legal').day,'2026-09-30');
});


test('a capped activity feed never claims to be full history',()=>{
 const allActivities=Array.from({length:51},(_,i)=>({id:`activity-${i}`,kind:'note',summary:`Demo activity ${i}`,occurred_at:new Date(Date.UTC(2026,9,20,12,0,-i)).toISOString()}));
 const root=new JSDOM(renderDealUpdates({activities:allActivities.slice(0,50)})).window.document;
 assert.equal(root.querySelectorAll('.deal-note').length,50);
 assert.doesNotMatch(root.body.textContent,/Full history/i);
 assert.match(root.querySelector('.updates-history > summary').textContent,/Recorded updates \(50\)/);
 assert.match(root.body.textContent,/latest 50 activities.*older activities may be omitted/i);
});
