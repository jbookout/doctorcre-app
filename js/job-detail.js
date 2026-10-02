import {jobLinks} from './control-room-workspace-model.js';
import {readWithDeadline} from './auto-refresh.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const originalEntry=entry=>[...new Set(['statement','human_quote','desired_outcome','body','note','reason','admission_reason','description'].map(key=>entry?.[key]).filter(value=>typeof value==='string'&&value.trim()))].join('\n\n');
const summary=value=>String(value||'').slice(0,220);
export function mountJobDetail({client,document}) {
 const dialog=document.getElementById('jobDialog'),body=document.getElementById('jobBody');
 let selected=null,generation=0,trigger=null,record=null;
 const paint=(task,entry,pending=false)=>{
  const expanded=body.querySelector('details')?.open;
  const focusedDetails=body.querySelector('summary')===document.activeElement;
  document.getElementById('jobTitle').textContent=task.title || task.name || 'System job';
  const links=jobLinks(task);
  const html=`<div class="job-summary"><div><span class="eyebrow">${escape(task.governance?'Review':task.stage||task.state||task.status||'Job')}</span><p>${escape(summary(entry?.desired_outcome||entry?.note||task.note||task.reason||''))}</p><div class="job-links">${links.workRequest?`<span>Work Request ${escape(links.workRequest)}</span>`:'<span>Work Request unavailable</span>'}${links.prLabel?(links.prUrl?`<a href="${escape(links.prUrl)}" target="_blank" rel="noopener noreferrer">${escape(links.prLabel)}</a>`:`<span>${escape(links.prLabel)}</span>`):''}</div></div><dl><dt>Owner</dt><dd>${escape(entry?.owner||task.owner||task.executor||'Unassigned')}</dd><dt>Status</dt><dd>${escape(entry?.state||task.state||task.status||'Unknown')}</dd></dl></div><details${expanded?' open':''}><summary>Details</summary><pre>${escape(originalEntry(entry||task)||task.title||task.name||'')}</pre><a href="/control-room/progress/work?board=${encodeURIComponent(new URLSearchParams(location.search).get('board')||'carr-v5')}&task=${encodeURIComponent(task.id||task.key||'')}${links.workRequest?`&work_request=${encodeURIComponent(links.workRequest)}`:''}">Project activity</a></details><p class="job-update" role="status">${pending?'Updating…':''}</p>`;
  if(body.innerHTML!==html){body.innerHTML=html;if(focusedDetails)body.querySelector('summary').focus();}
 };
 async function refresh() {
  if(!selected||!dialog.open)return;
  const task=selected,seq=++generation,links=jobLinks(task);
  if(!links.workRequest){record=task.governance?.entry||task;paint(task,record);return;}
  try {const result=await readWithDeadline(()=>client.workRequestCard({work_request:links.workRequest}));
   if(seq!==generation||!dialog.open)return;
   if(result?.ok!==true||result.human_ref!==links.workRequest)throw new Error('Invalid work request');
   record=result;paint(selected,record);
  }catch(error) {if(seq===generation&&dialog.open){if([401,403].includes(error.status)){dialog.close();body.replaceChildren();return;}paint(task,record);body.querySelector('.job-update').textContent='Details temporarily unavailable';}}
 }
 dialog.addEventListener('close',()=>{selected=null;record=null;++generation;trigger?.focus();});
 document.getElementById('jobClose').onclick=()=>dialog.close();
 return { open(task){trigger=document.activeElement;selected=task;record=null;paint(task,task.governance?.entry||task,true);if(!dialog.open)dialog.showModal();refresh();}, refresh,
  update(tasks){if(!selected||!dialog.open)return;const latest=tasks.find(task=>task.id===selected.id);if(latest){selected=latest;paint(latest,latest.governance?.entry||record||latest);}},
  clear(){if(dialog.open)dialog.close();body.replaceChildren();}
 };
}
