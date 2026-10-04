import {createLiveClient} from './live-client.js';
import {createFixtureClient} from './fixture-client.js';
import {resolveDealroomBoot} from './boot-mode.js';
import {automationSchedule,automationTiming} from './control-room-workspace-model.js';
import {mountAutoRefresh,readWithDeadline,updatedLabel} from './auto-refresh.mjs';
import {mountJobDetail} from './job-detail.js';
const root=document.getElementById('automationList');
const boot=resolveDealroomBoot(location),client=boot.mode==='live'?createLiveClient():await createFixtureClient(boot.options);
const detail=mountJobDetail({client,document});
let jobs=[],sourceState='unknown';
async function refresh(){
 try{
  const read=await readWithDeadline(()=>client.scheduleBoard());const projection=automationSchedule(read);if(!projection.jobs)throw new Error('Invalid schedule');jobs=projection.jobs;sourceState='read';
  detail.update(jobs.map(job=>({...job,id:`${job.owner}:${job.key}`,title:job.name})),{source:'schedule'});
  const focused=document.activeElement?.dataset.automationId;
  root.replaceChildren(...jobs.map(job=>{const button=document.createElement('button');button.className='automation-job';button.type='button';button.dataset.automationId=`${job.owner}:${job.key}`;button.dataset.state=job.state;
   const title=document.createElement('strong');title.textContent=job.name;const time=document.createElement('time');time.textContent=automationTiming(job);
   const state=document.createElement('span');state.textContent=job.state;button.append(title,time,state);button.onclick=()=>detail.open({...job,id:button.dataset.automationId,title:job.name,source_state:sourceState==='read'?job.source_state:'unknown'},{source:'schedule'});return button;}));
  if(focused)[...root.children].find(b=>b.dataset.automationId===focused)?.focus();
  document.getElementById('listUpdated').textContent=updatedLabel(read.observed_at);document.getElementById('automationListState').textContent=projection.notice||(jobs.length?'':'No automations');
 }catch(error){sourceState='unknown';detail.update([],{source:'schedule',state:'unknown'});if([401,403].includes(error.status)){jobs=[];root.replaceChildren();detail.clear();}document.getElementById('automationListState').textContent='Automations unavailable';}
 await detail.refresh();
}
await refresh();mountAutoRefresh({document,window,refresh,intervalMs:15000});
