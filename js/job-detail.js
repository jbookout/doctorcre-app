import {taskSummary,jobLinks} from './progress-board-model.js';
import {readWithDeadline} from './auto-refresh.mjs';
import {escapeText as escape} from './change-receipts.mjs';
import {workDetailUrl} from './progress-work-model.js';

// Source facts stay independent from a linked Work Request. Structured source
// content is displayed verbatim as data, without unrelated transport fields.
const transportFields = new Set(['ok','schema','projection_state','next_human_action']);
const originalEntry=entry=>Object.entries(entry||{}).flatMap(([key,value])=>{
 if(transportFields.has(key)||value==null||value===''||Array.isArray(value)&&!value.length)return [];
 return [`${key.replaceAll('_',' ')}: ${typeof value==='object'?JSON.stringify(value,null,2):value}`];
}).join('\n\n');
const sourceEntry=task=>task.governance?.entry||task;
const summary=value=>String(value||'').slice(0,220);
function activityUrl(task, location) {
 const links=jobLinks(task);
 // Queue display IDs are not census IDs. A census task must carry its kind;
 // automation and incident display keys alone cannot establish a binding.
 const taskId=task.governance?.ref?`governance_item:${task.governance.ref}`:
   task.kind && task.id?.startsWith(`${task.kind}:`)?task.id:task.task_id;
 if(!taskId&&!links.workRequest)return null;
 return workDetailUrl({board:new URLSearchParams(location?.search).get('board')||'carr-v5',task:taskId,workRequest:links.workRequest});
}
function currentTrigger(document, trigger) {
 if(trigger?.isConnected)return trigger;
 const node=trigger?.node;
 if(node?.isConnected)return node;
 if(!trigger?.attribute)return null;
 const record=[...document.querySelectorAll(`[${trigger.attribute}]`)].find(row=>row.getAttribute(trigger.attribute)===trigger.value && (trigger.owner==null || row.dataset.owner===trigger.owner) && (!trigger.container || row.closest(trigger.container)));
 return trigger.control?record?.querySelector(trigger.control):record;
}
function rememberTrigger(document) {
 const node=document.activeElement;
 for(const attribute of ['data-task-id','data-work-id','data-automation-id','data-automation','data-incident']){
  const record=node?.closest(`[${attribute}]`);
  if(record)return {node,attribute,value:record.getAttribute(attribute),owner:record.dataset.owner,container:record.closest('#automationCalendar')?'#automationCalendar':record.closest('#automationAgenda')?'#automationAgenda':null,
   control:record===node?null:node.matches('h4 a')?'h4 a':node.matches('.work-actions a')?'.work-actions a':node.tagName.toLowerCase()};
 }
 return {node};
}
export function mountJobDetail({client,document}) {
 const dialog=document.getElementById('jobDialog'),body=document.getElementById('jobBody');
 let selected=null,source='board',sourceState='read',generation=0,trigger=null,workRequest=null;
 const paint=(pending=false,message='')=>{
  if(!selected)return;
  const task=selected,entry=sourceEntry(task),expanded=body.querySelector('details')?.open;
  const focused=document.activeElement,focusKey=body.contains(focused)?focused.dataset.jobControl:null;
  document.getElementById('jobTitle').textContent=task.title||task.name||'System job';
  const links=jobLinks(task),activity=sourceState==='read'?activityUrl(task,document.defaultView?.location):null;
  const status=sourceState==='read'?entry?.state||task.state||task.status||'Unknown':'Unavailable';
  const original=originalEntry(entry)||task.title||task.name||'';
  const linked=workRequest?`\n\nLinked Work Request\n${originalEntry(workRequest)}`:'';
  const notice=sourceState==='removed'?'Source entry is no longer present. Last-known details.':sourceState!=='read'?'Source unavailable. Last-known details.':message;
  const html=`<div class="job-summary"><div><span class="eyebrow">${escape(sourceState==='read'?(task.governance?'Review':task.stage||task.state||task.status||'Job'):'Unavailable')}</span><p>${escape(summary(workRequest?.desired_outcome||entry?.desired_outcome||entry?.note||task.note||task.reason||taskSummary(task)))}</p><div class="job-links">${links.workRequest?`<span>Work Request ${escape(links.workRequest)}</span>`:'<span>Work Request unavailable</span>'}${links.prLabel?(links.prUrl?`<a data-job-control="pr" href="${escape(links.prUrl)}" target="_blank" rel="noopener noreferrer">${escape(links.prLabel)}</a>`:`<span>${escape(links.prLabel)}</span>`):''}</div></div><dl><dt>Owner</dt><dd>${escape(entry?.owner||entry?.owner_actor||entry?.proposer_actor_id||task.owner||task.executor||'Unassigned')}</dd><dt>Status</dt><dd>${escape(status)}</dd></dl></div><details${expanded?' open':''}><summary data-job-control="details">Details</summary><pre>${escape(original+linked)}</pre>${activity?`<a data-job-control="activity" href="${escape(activity)}">Project activity</a>`:''}</details><p class="job-update" role="status">${escape(notice||(pending?'Updating…':''))}</p>`;
  if(body.innerHTML!==html){body.innerHTML=html;if(focusKey)([...body.querySelectorAll('[data-job-control]')].find(node=>node.dataset.jobControl===focusKey)||body.querySelector('summary')).focus();}
 };
 async function refresh() {
  if(!selected||!dialog.open||sourceState!=='read')return;
  const task=selected,seq=++generation,links=jobLinks(task);
  if(!links.workRequest){workRequest=null;paint();return;}
  const current=()=>seq===generation&&dialog.open&&sourceState==='read'&&selected?.id===task.id&&jobLinks(selected).workRequest===links.workRequest;
  try {
   const result=await readWithDeadline(()=>client.workRequestCard({work_request:links.workRequest}));
   if(!current())return;
   if(result?.ok!==true||result.human_ref!==links.workRequest)throw new Error('Invalid work request');
   workRequest=result;paint();
  }catch(error){if(current()){if([401,403].includes(error.status)){dialog.close();body.replaceChildren();return;}paint(false,'Linked Work Request temporarily unavailable');}}
 }
 dialog.addEventListener('close',()=>{selected=null;workRequest=null;++generation;currentTrigger(document,trigger)?.focus();});
 document.getElementById('jobClose').onclick=()=>dialog.close();
 return {
  open(task,{source:readSource='board'}={}){trigger=rememberTrigger(document);selected=task;source=readSource;sourceState=task.source_state||'read';workRequest=null;++generation;paint(Boolean(jobLinks(task).workRequest));if(!dialog.open)dialog.showModal();refresh();},refresh,
  update(tasks,{source:readSource='board',state='read'}={}){
   if(!selected||!dialog.open||readSource!==source)return;
   if(['unauthorized','signed-out','unpublished'].includes(state)){this.clear();return;}
   const latest=tasks.find(task=>task.id===selected.id),nextState=state==='read'?(latest?(latest.source_state||'read'):'removed'):'unknown';
   if(nextState!==sourceState||latest&&JSON.stringify(latest)!==JSON.stringify(selected))++generation;
   sourceState=nextState;
   if(latest&&state==='read'){if(jobLinks(latest).workRequest!==jobLinks(selected).workRequest)workRequest=null;selected=latest;}
   paint();
  },
  clear(){if(dialog.open)dialog.close();body.replaceChildren();}
 };
}
