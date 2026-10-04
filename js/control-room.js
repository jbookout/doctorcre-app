import { selectDocRecord } from './doc-context.js';
import { mountAutoRefresh, updatedLabel, readWithDeadline } from './auto-refresh.mjs';
import { createFixtureClient } from './fixture-client.js';
import { createLiveClient } from './live-client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAtlas } from './atlas.js';
import { mountSessions } from './sessions.js';
import { mountModelRoom } from './model-room.js';
import { mountNotificationBadge, wireTabs } from './shell.js';
import { validIncidentBoardPayload, incidentFilters, groupedIncidents } from './control-room-model.js';
import { mountBoard } from './progress-board.js';
import { automationMonth } from './control-room-workspace-model.js';
import { connectionView, meteredSpend } from './connections-model.js';
import { mountJobDetail } from './job-detail.js';
import { escapeText as escapeHtml } from './change-receipts.mjs';
import { validGovernanceQueuePayload, validScheduleBoardPayload } from './operations-model.js';
const $=id=>document.getElementById(id);
export { escapeHtml };
export const view={status:'loading',sequence:0,severity:'all',reads:{incidents:{state:'pending'},approvals:{state:'pending'},schedule:{state:'pending'},connections:{state:'pending'}},atlas:{status:'idle',payload:null}};
let client,tabs,board,details;
const now=new Date();let year=now.getFullYear(),month=now.getMonth();
const payloadOf=id=>view.reads[id]?.state==='read'?view.reads[id].payload:null;
const asOf=read=>updatedLabel(read?.observed_at);
const announce=text=>{if($('roomLive').textContent!==text)$('roomLive').textContent=text;};
function replaceHtml(node,html){
 if(node.innerHTML===html)return;
 const key=node.contains(document.activeElement)?document.activeElement.dataset.roomControl:null;
 node.innerHTML=html;
 if(key)[...node.querySelectorAll('[data-room-control]')].find(control=>control.dataset.roomControl===key)?.focus();
}
function renderIncidents() {
  const read = view.reads.incidents;
  $("attentionAsOf").textContent = asOf(read);
  const chips = $("severityChips");
  const groups = $("incidentGroups");
  const state = $("attentionState");
  const payload = payloadOf("incidents");
  details?.update((payload?.incidents||[]).map(row=>({...row,id:row.ref})),{source:'incidents',state:read.state});
  if (!payload || !validIncidentBoardPayload(payload)) {
    chips.innerHTML = `<span class="chip-label">Severity</span>`;
    groups.innerHTML = "";
    state.hidden = false;
    return;
  }
  state.hidden = true;
  replaceHtml(chips, `<span class="chip-label">Severity</span>${incidentFilters(payload.incidents)
    .map((filter) => `<button class="chip" type="button" data-room-control="${escapeHtml(filter.id)}" data-severity="${escapeHtml(filter.id)}" aria-pressed="${filter.id === view.severity}">${escapeHtml(filter.label)} · ${filter.count}</button>`)
    .join("")}`);
  const grouped = groupedIncidents(payload.incidents, { severity: view.severity });
  replaceHtml(groups, grouped.map((group) => `
    <section class="card" data-group="${escapeHtml(group.severity)}" aria-label="${escapeHtml(group.severity)}">
      <div class="card-heading"><div><p class="eyebrow">${escapeHtml(group.severity)}</p><h3>${group.count} ${group.count === 1 ? "incident" : "incidents"}</h3></div></div>
      <ul class="work-list">
        ${group.incidents.map((card) => `<li class="work-item" data-incident="${escapeHtml(card.ref)}" data-priority="ordinary">
          <div>
            <h3>${escapeHtml(card.title)}</h3>
            <div class="work-meta"><span>${escapeHtml(`${card.ref} · ${card.severity} · ${card.state} · ${card.age} · ${card.owner} · seen ${card.occurrences === null ? "unknown" : card.occurrences} times`)}</span></div>
            <div class="work-meta"><span>${escapeHtml(card.recommendedNext ? `Recommended next: ${card.recommendedNext}` : "Next action unavailable")}</span></div>
            ${card.readyToClose ? `<div class="work-meta"><span>Ready to close</span></div>` : ""}
          </div>
          <div class="stack-end"><button class="btn" type="button" data-room-control="${escapeHtml(card.ref)}" data-incident-open="${escapeHtml(card.ref)}">Details</button></div>
        </li>`).join("")}
      </ul>
    </section>`).join("") || `<div class="state-block" data-state="empty"><h3>No incident matches this severity</h3></div>`);
}

function openIncident(ref) { const row=payloadOf('incidents')?.incidents?.find(item=>item.ref===ref);if(row){selectDocRecord("incident", row.ref);details.open({...row,id:row.ref},{source:'incidents'});} }

function renderConnections(){
 const projection=connectionView(payloadOf('connections'));
 $('connectionsUpdated').textContent=updatedLabel(projection.generated_at);
 replaceHtml($('connectionsProviders'),projection.providers.map(row=>`<article class="connection-card" data-connection="${escapeHtml(row.id)}" data-state="${row.status}"><div class="connection-heading"><span class="connection-dot" aria-hidden="true"></span><h3>${row.name}</h3></div><span class="connection-state">${row.label}</span><strong class="connection-spend">${escapeHtml(meteredSpend(row.spend))}</strong>${row.spend?`<time>${escapeHtml(updatedLabel(row.spend.as_of))}</time>`:''}${row.manage_url?`<a data-room-control="manage:${escapeHtml(row.id)}" href="${escapeHtml(row.manage_url)}" target="_blank" rel="noopener noreferrer">Manage ↗</a>`:''}</article>`).join(''));
 $('connectionDevices').innerHTML=(projection.devices||[]).map(row=>`<article class="connection-card" data-device="${escapeHtml(row.id)}" data-state="${row.status}"><h3>${escapeHtml(row.name)}</h3><span>${{connected:'Connected',offline:'Not connected',unknown:'Status unavailable'}[row.status]}</span><time>${escapeHtml(updatedLabel(row.checked_at))}</time></article>`).join('');
 $('devicesState').textContent=projection.devices?projection.devices.length?'':'No devices':'Device status unavailable';
}
function automationButton(job){return `<button type="button" class="automation-job" aria-label="${escapeHtml(job.name)}" data-room-control="${escapeHtml(JSON.stringify([job.owner,job.key]))}" data-automation="${escapeHtml(job.key)}" data-owner="${escapeHtml(job.owner)}" data-state="${escapeHtml(job.state)}"><span>${escapeHtml(job.name)}</span><time>${job.next_due_at?escapeHtml(new Date(job.next_due_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true})):'Unscheduled'}</time>${job.next_due_basis==='cadence_deadline'?'<small>Expected by</small>':''}</button>`;}
function renderAutomations(){
 const data=automationMonth(payloadOf('schedule'),year,month);$('automationMonth').textContent=data.label;
 details?.update((data.jobs||[]).map(job=>({...job,id:`automation:${job.owner}:${job.key}`,title:job.name})),{source:'schedule',state:view.reads.schedule.state});
 const calendar=$('automationCalendar');replaceHtml(calendar,data.jobs?['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>`<span class="calendar-weekday">${day}</span>`).join('')+Array.from({length:data.blanks},()=>'<div class="calendar-blank"></div>').join('')+data.days.map(day=>`<section class="calendar-day" aria-label="${day.key}"><time datetime="${day.key}">${day.day}</time>${day.jobs.map(automationButton).join('')}</section>`).join(''):'<p role="status">Automations unavailable</p>');
 replaceHtml($('automationAgenda'),data.jobs?data.days.flatMap(day=>day.jobs.map(job=>`<div><time datetime="${day.key}">${day.day} ${data.label}</time>${automationButton(job)}</div>`)).join(''):'');
 replaceHtml($('automationUndated'),data.undated.length?`<h3>Unscheduled</h3><div class="automation-undated-grid">${data.undated.map(automationButton).join('')}</div>`:'');
 document.querySelectorAll('[data-automation]').forEach(button=>button.onclick=()=>{const job=data.jobs.find(j=>j.key===button.dataset.automation&&j.owner===button.dataset.owner);if(job)details.open({...job,id:`automation:${job.owner}:${job.key}`,title:job.name},{source:'schedule'});});
}
function renderRead(id){
 if(id==='incidents')renderIncidents();
 if(id==='approvals')board?.setGovernance(payloadOf(id),view.reads[id]);
 if(id==='schedule')renderAutomations();
 if(id==='connections')renderConnections();
}
async function take(id,run){
 const sequence=view.sequence;
 try{
  const payload=await readWithDeadline(run);
  if(sequence!==view.sequence)return;
  const valid=id==='incidents'?validIncidentBoardPayload(payload):id==='approvals'?validGovernanceQueuePayload(payload):id==='schedule'?validScheduleBoardPayload(payload):true;
  if(!valid)throw new Error('Invalid source read');
  view.reads[id]={state:'read',payload,observed_at:new Date().toISOString()};
  renderRead(id);
 }catch(error){
  if(sequence!==view.sequence)return;
  const denied=[401,403].includes(error.status);
  if(denied)details?.clear();
  view.reads[id]={state:'unknown',reason:denied?'Sign in required':'Updates unavailable'};
  // Projection/render errors follow the same unavailable path as transport
  // errors, so they cannot leave earlier observations looking current.
  renderRead(id);
 }
}
async function load(){
 view.sequence++;view.status='loading';
 await Promise.all([take('incidents',()=>client.incidentBoard({state:'open'})),take('approvals',()=>client.governanceQueue()),take('schedule',()=>client.scheduleBoard()),take('connections',()=>client.readConnections())]);
 await details.refresh();view.status='ready';
 announce(Object.values(view.reads).every(read=>read.state==='read')?'Control Room updated':'Control Room updates unavailable');
}

function openAtlas(node=null){mountAtlas({client,getIncidentsRead:()=>view.reads.incidents,node,onChange:atlas=>{view.atlas=atlas;}});}
function openSessions(){mountSessions({});}
function openModelRoom(){mountModelRoom({});}
async function boot(){
 const resolved=resolveDealroomBoot(globalThis.location);client=resolved.mode==='live'?createLiveClient():await createFixtureClient(resolved.options);
 $("jobDialog").addEventListener("close",()=>selectDocRecord(null,null));
 details=mountJobDetail({client,document});board=mountBoard({client,openTask:task=>details.open(task),onTasks:tasks=>details.update(tasks)});board.start();
 $('severityChips').addEventListener('click',event=>{
  const chip=event.target.closest('button[data-severity]');
  if(chip){view.severity=chip.dataset.severity;renderIncidents();}
 });
 $('incidentGroups').addEventListener('click',event=>{
  const row=event.target.closest('[data-incident]');
  if(row)openIncident(row.dataset.incident);
 });
 mountNotificationBadge(client);tabs=wireTabs('controlRoomTabs');
 const activate=selected=>{if(selected.id==='tabAtlas')openAtlas(new URLSearchParams(location.search).get('node'));if(selected.id==='tabSessions')openSessions();if(selected.id==='tabModelRoom')openModelRoom();};
 document.getElementById('controlRoomTabs')?.addEventListener('click',event=>{const selected=event.target.closest('[data-tab-key]');if(!selected)return;const next=new URL(location.href);next.searchParams.set('tab',selected.dataset.tabKey);history.pushState({},'',next);activate(selected);},true);
 const restoreTab=()=>{const requested=new URLSearchParams(location.search).get('tab');const key={atlas:'system-map','model-room':'agents',dashboard:'overview'}[requested]||requested||'overview';const selected=[...document.querySelectorAll('#controlRoomTabs [data-tab-key]')].find(t=>t.dataset.tabKey===key);if(selected){tabs.select(selected.id);activate(selected);}};
 window.addEventListener('popstate',restoreTab);const parameters=new URLSearchParams(location.search);if(parameters.has("tab")) restoreTab();
 $('automationPrev').onclick=()=>{month--;if(month<0){month=11;year--;}renderAutomations();};$('automationNext').onclick=()=>{month++;if(month>11){month=0;year++;}renderAutomations();};
 await load();const auto=mountAutoRefresh({document,window,refresh:load,intervalMs:15000});window.addEventListener('pagehide',event=>{if(!event.persisted){auto.dispose();board.dispose();}});
}
boot();
