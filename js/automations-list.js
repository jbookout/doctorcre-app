import {createLiveClient} from './live-client.js';
import {createFixtureClient} from './fixture-client.js';
import {resolveDealroomBoot} from './boot-mode.js';
import {validScheduleBoardPayload,formatScheduleDateTime} from './operations-model.js';
import {mountAutoRefresh,readWithDeadline,updatedLabel} from './auto-refresh.mjs';
import {mountJobDetail} from './job-detail.js';
const root=document.getElementById('automationList');
const boot=resolveDealroomBoot(location),client=boot.mode==='live'?createLiveClient():await createFixtureClient(boot.options);
const detail=mountJobDetail({client,document});
let jobs=[];
async function refresh(){
 try{
  const read=await readWithDeadline(()=>client.scheduleBoard());if(!validScheduleBoardPayload(read))throw new Error('Invalid schedule');jobs=read.jobs;
  detail.update(jobs.map(job=>({...job,id:`${job.owner}:${job.key}`,title:job.name})),{source:'schedule'});
  const focused=document.activeElement?.dataset.automationId;
  root.replaceChildren(...jobs.map(job=>{const button=document.createElement('button');button.className='automation-job';button.type='button';button.dataset.automationId=`${job.owner}:${job.key}`;button.dataset.state=job.state;
   const title=document.createElement('strong');title.textContent=job.name;const time=document.createElement('time');time.textContent=job.next_due_at?`${job.next_due_basis==='cadence_deadline'?'Expected by':'Next'} ${formatScheduleDateTime(job.next_due_at)}`:'Unscheduled';
   const state=document.createElement('span');state.textContent=job.state;button.append(title,time,state);button.onclick=()=>detail.open({...job,id:button.dataset.automationId,title:job.name},{source:'schedule'});return button;}));
  if(focused)[...root.children].find(b=>b.dataset.automationId===focused)?.focus();
  document.getElementById('listUpdated').textContent=updatedLabel(read.observed_at);document.getElementById('automationListState').textContent=jobs.length?'':'No automations';
 }catch(error){detail.update([],{source:'schedule',state:'unknown'});if([401,403].includes(error.status)){jobs=[];root.replaceChildren();detail.clear();}document.getElementById('automationListState').textContent='Automations unavailable';}
 await detail.refresh();
}
await refresh();mountAutoRefresh({document,window,refresh,intervalMs:15000});
