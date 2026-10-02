import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { dealTimeline, countdown, renderDealTimeline, renderCriticalDates, calendarDay, updateCountdowns } from '../js/deal-timeline.js';
import { createLiveClient } from '../js/live-client.js';
import { readFile } from 'node:fs/promises';
const now = Date.parse('2026-10-04T17:00:00Z');
const detail = {deal:{id:'demo',phase:'Legal'},history:[
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
test('conflicting contract dates remain visible; equal obligations collapse; kind is never inferred from prose',()=>{
 const view=dealTimeline({...detail,critical_dates:[{kind:'lease_commencement',due_on:'2026-11-01'}, {kind:'commencement',due_on:'2026-11-02'}, {label:'Rent start',due_on:'2026-11-30'}]},now);
 assert.deepEqual(view.dates.filter(d=>d.kind==='lease_commencement').map(d=>d.day),['2026-11-01','2026-11-02']);
 assert.ok(view.missing.some(d=>d.kind==='rent_start'));
});
test('countdowns cross midnight and distinguish deadlines, completed dates and past commencement',()=>{
 assert.deepEqual(countdown({day:'2026-10-04',deadline:true},now),{state:'today',text:'Due today'});
 assert.deepEqual(countdown({day:'2026-10-05',deadline:true},now),{state:'soon',text:'1 day'});
 assert.equal(countdown({day:'2026-10-03',deadline:true},now).text,'1 day overdue');
 assert.equal(countdown({day:'2026-10-03'},now).text,'1 day ago');
 assert.equal(countdown({day:'2026-10-03',status:'completed'},now).text,'Completed');
 const root=new JSDOM(renderCriticalDates(detail,now)).window.document;
 updateCountdowns(root,now+86400000);
 assert.equal(root.querySelector('[data-countdown="2026-10-03"]').textContent,'2 days overdue');
});
test('chronology includes documents, correspondence and undated entries with escaped originals and concise summaries',()=>{
 const view=dealTimeline(detail,now);
 assert.deepEqual(view.entries.map(e=>e.kind),['Note','email','Document']);
 assert.ok(view.entries.every(e=>e.summary.length<=150));
 const html=renderDealTimeline(detail,now);
 assert.match(html,/Original demo email &lt;script&gt;/);
 assert.doesNotMatch(html,/<script>/);
 assert.match(html,/role="img"/);
 const root=new JSDOM(html).window.document;
 assert.equal(root.querySelectorAll('.timeline-entry').length,3);
 assert.equal(root.querySelector('.timeline-entry time').dateTime,'2026-10-01');
 const old={...detail,activities:[{id:'old',kind:'call',summary:'Demo old call',detail:'Original demo call',occurred_at:'2020-01-01'}]};
 assert.doesNotMatch(renderDealTimeline(old,now),/Demo old call/);
 assert.match(renderDealTimeline(old,now,true),/Demo old call/);
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
test('missing activity originals never masquerade as original email bodies',()=>{
 const html=renderDealTimeline({deal:{phase:'Legal'},activities:[{id:'mail',kind:'email',summary:'Demo summary only',occurred_at:'2026-10-02T12:00:00Z'}]},now);
 const root=new JSDOM(html).window.document;
 assert.equal(root.querySelector('.note-original').textContent,'Original unavailable');
});
