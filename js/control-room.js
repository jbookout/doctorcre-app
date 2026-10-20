import {onDialogClosed} from './dialog-lifecycle.js';
import { selectDocRecord } from './doc-context.js';
import { mountAutoRefresh, updatedLabel, readWithDeadline } from './auto-refresh.mjs';
import { createFixtureClient } from './fixture-client.js';
import { createLiveClient } from './live-client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAtlas } from './atlas.js';
import { mountSessions } from './sessions.js';
import { mountModelRoom } from './model-room.js';
import { mountNotificationBadge, wireTabs } from './shell.js';
import { validIncidentBoardPayload, validCurrentWorkItemPayload, incidentFilters, groupedIncidents } from './control-room-model.js';
import { jobLinks } from './progress-board-model.js';
import { mountBoard } from './progress-board.js';
import { automationMonth, automationTiming, attentionTasks } from './control-room-workspace-model.js';
import { connectionView, meteredSpend } from './connections-model.js';
import { mountJobDetail } from './job-detail.js';
import { escapeText as escapeHtml } from './change-receipts.mjs';
import { validGovernanceQueuePayload, validScheduleBoardPayload } from './operations-model.js';
import {snapshotFromReads,writeSnapshot} from './status-model.js';
import { sectionForTab, createQueue, addPage, refreshQueue, settleRefresh, queueItems, triageItems, bugItems, coverageLine, STATUS_GROUPS } from './control-room-queue-model.js';
import { notificationCards, validFeedPayload } from './notifications-model.js';
import { mountQueueList, paneShortcut, ignoreKey } from './control-room-list.js';
import { mountDetail } from './control-room-detail.js';
import { mountControlRoomCommands } from './control-room-commands.js';
const $=id=>document.getElementById(id);
export { escapeHtml };
export const view={status:'loading',sequence:0,severity:'all',queue:{state:'pending',model:createQueue()},inbox:{state:'pending'},waiting:{state:'pending'},reads:{incidents:{state:'pending'},approvals:{state:'pending'},schedule:{state:'pending'},connections:{state:'pending'}},atlas:{status:'idle',payload:null}};
let client,tabs,board,details,queueList,detail;
let attention = { tasks: [], state: 'pending' };
let heldWork = [];
const withHolders = tasks => tasks.map(task => ({ ...task, held: heldWork.find(row => row.human_ref === jobLinks(task).workRequest) }));
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
function renderAttention(tasks, observation) {
 attention = { tasks, state: observation.state };
 const state = observation.state === 'read' && view.queue.state === 'unknown' ? 'unknown' : observation.state;
 details?.update(withHolders(tasks), { ...observation, state });
 const current = state === 'read';
 const rows = current ? attentionTasks(withHolders(tasks)) : [];
 $('crAttentionCount').textContent = current ? `${rows.length} ${rows.length === 1 ? 'item' : 'items'}` : '';
 $('crAttentionCoverage').textContent = current ? 'Failed and blocked work from the loaded board. Missing facts stay unknown.' : 'Attention work unavailable. Refresh the board to try again.';
 replaceHtml($('crAttentionList'),current ? rows.length ? rows.map(row => `<article class="cr-attention-row" data-attention-id="${escapeHtml(row.id)}" data-state="${escapeHtml(row.state)}">
  <div class="cr-attention-subject"><span class="cr-work-status"><span aria-hidden="true">${row.state==='failed'?'!':'■'}</span> ${escapeHtml(row.state.replaceAll('_',' '))}</span><h4>${escapeHtml(row.title)}</h4></div>
  <dl class="cr-work-facts"><div><dt>Agent</dt><dd>${escapeHtml(row.agent)}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(row.owner)}</dd></div><div><dt>Blocker</dt><dd>${escapeHtml(row.blocker)}</dd></div><div><dt>Last progress</dt><dd>${escapeHtml(row.progress)}</dd></div></dl>
  <div class="cr-attention-footer"><span>${escapeHtml(updatedLabel(row.updatedAt))}</span><button type="button" class="btn" data-room-control="attention:${escapeHtml(row.id)}" data-attention-open="${escapeHtml(row.id)}">Open details</button></div>
 </article>`).join('') : stateBlock('empty','No failed or blocked work in the loaded board') : stateBlock('offline','Attention work could not be read'));
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
            <div class="work-meta"><span>${escapeHtml(`${card.ref} · ${card.severity} · ${card.state} · ${card.age} · ${card.owner} · seen ${card.occurrences === null ? "unknown" : card.occurrences} ${card.occurrences === 1 ? "time" : "times"}`)}</span></div>
            <div class="work-meta"><span>${escapeHtml(card.recommendedNext ? `Recommended next: ${card.recommendedNext}` : "Next action unavailable")}</span></div>
            ${card.readyToClose ? `<div class="work-meta"><span>Ready to close</span></div>` : ""}
          </div>
          <div class="stack-end"><button class="btn" type="button" data-room-control="${escapeHtml(card.ref)}" data-incident-open="${escapeHtml(card.ref)}">Details</button></div>
        </li>`).join("")}
      </ul>
    </section>`).join("") || `<div class="state-block" data-state="empty"><h3>${view.reads.incidents?.payload?.incidents?.length?"No incident matches this severity":"No incidents"}</h3></div>`);
}

function openIncident(ref) { const row=payloadOf('incidents')?.incidents?.find(item=>item.ref===ref);if(row){selectDocRecord("incident", row.ref);details.open({...row,id:row.ref},{source:'incidents'});} }

function renderConnections(){
 const projection=connectionView(payloadOf('connections'));
 $('connectionsUpdated').textContent=projection.generated_at?updatedLabel(projection.generated_at):view.reads.connections.state==='pending'?'Updating…':'No current reading';
 const missing=projection.providers.some(row=>row.status==='unknown'||!row.spend);
 const state=$('connectionsState');state.hidden=!missing;
 state.textContent=projection.providers.every(row=>row.status==='unknown'&&!row.spend)?'Provider status and spend are unavailable. Dashes mark missing readings.':'Some provider status or spend readings are unavailable. Dashes mark missing readings.';
 replaceHtml($('connectionsProviders'),projection.providers.map(row=>`<article class="connection-card" data-connection="${escapeHtml(row.id)}" data-state="${row.status}"><div class="connection-heading"><span class="connection-dot" aria-hidden="true"></span><h3>${row.name}</h3></div><span class="connection-state">${row.status==='unknown'?'—':row.label}</span><strong class="connection-spend">${row.spend?escapeHtml(meteredSpend(row.spend)):'—'}</strong>${row.spend?`<time>${escapeHtml(updatedLabel(row.spend.as_of))}</time>`:''}${row.manage_url?`<a data-room-control="manage:${escapeHtml(row.id)}" href="${escapeHtml(row.manage_url)}" target="_blank" rel="noopener noreferrer">Manage ↗</a>`:''}</article>`).join(''));
 $('connectionDevices').innerHTML=(projection.devices||[]).map(row=>`<article class="connection-card" data-device="${escapeHtml(row.id)}" data-state="${row.status}"><h3>${escapeHtml(row.name)}</h3><span>${{connected:'Connected',offline:'Not connected',unknown:'Status unavailable'}[row.status]}</span><time>${escapeHtml(updatedLabel(row.checked_at))}</time></article>`).join('');
 $('devicesState').textContent=projection.devices?projection.devices.length?'':'No devices':'Device status unavailable';
}
function automationButton(job){return `<button type="button" class="automation-job" aria-label="${escapeHtml(job.name)}" data-room-control="${escapeHtml(JSON.stringify([job.owner,job.key]))}" data-automation="${escapeHtml(job.key)}" data-owner="${escapeHtml(job.owner)}" data-state="${escapeHtml(job.state)}"><span>${escapeHtml(job.name)}</span><time>${escapeHtml(automationTiming(job,{compact:true}))}</time></button>`;}
function renderAutomations(){
 const data=automationMonth(payloadOf('schedule'),year,month);$('automationMonth').textContent=data.label;
 details?.update((data.jobs||[]).map(job=>({...job,id:`automation:${job.owner}:${job.key}`,title:job.name})),{source:'schedule',state:view.reads.schedule.state});
 const scheduled=data.days.some(day=>day.jobs.length);
 $('automationControls').hidden=!data.jobs?.some(job=>job.next_due_at);
 const state=$('automationState');state.textContent=data.notice||(!scheduled?`No scheduled runs in ${data.label}`:'');state.hidden=!state.textContent;
 const calendar=$('automationCalendar');replaceHtml(calendar,scheduled?['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>`<span class="calendar-weekday">${day}</span>`).join('')+Array.from({length:data.blanks},()=>'<div class="calendar-blank"></div>').join('')+data.days.map(day=>`<section class="calendar-day" aria-label="${day.key}"><time datetime="${day.key}">${day.day}</time>${day.jobs.map(automationButton).join('')}</section>`).join(''):'');
 replaceHtml($('automationAgenda'),data.jobs?data.days.flatMap(day=>day.jobs.map(job=>`<div><time datetime="${day.key}">${day.day} ${data.label}</time>${automationButton(job)}</div>`)).join(''):'');
 replaceHtml($('automationUndated'),data.jobs?.length?`<h3>All automations</h3><div class="automation-undated-grid">${data.jobs.map(automationButton).join('')}</div>`:'');
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
 renderQueue();
 await Promise.all([take('incidents',()=>client.incidentBoard({state:'open'})),take('approvals',()=>client.governanceQueue()),take('schedule',()=>client.scheduleBoard()),take('connections',()=>client.readConnections())]);
 await Promise.all([loadQueue(),loadInbox(),loadWaiting()]);
 await details.refresh();view.status='ready';
 if(view.reads.incidents.state==='read'){try{writeSnapshot(window.localStorage,snapshotFromReads(view.reads,Date.now()));}catch{ /* Device storage may be unavailable. */ }}
 announce(Object.values(view.reads).every(read=>read.state==='read')?'Control Room updated':'Control Room updates unavailable');
}

// V2 C1: the workbench sections. Rows are read-only here; C2 owns selection
// and the detail pane, C3 the triage actions, C5 the saved views.
const ISSUE_SECTIONS=new Set(['inbox','waiting','triage','queue','views']);
const QUEUE_PAGE=100;
const GLYPH={triage:'◇',in_progress:'◑',review:'◔',blocked:'■',ready:'●',backlog:'○',closed:'✓',other:'·'};
const emptyBlock=id=>$(id)?.innerHTML||'';
const stateBlock=(state,title,text='')=>`<div class="state-block" data-state="${state}"><h3>${escapeHtml(title)}</h3>${text?`<p>${escapeHtml(text)}</p>`:''}</div>`;
const plural=(n,one,many=one+'s')=>`${n.toLocaleString('en-US')} ${n===1?one:many}`;
function setCount(key,n){const node=document.querySelector(`[data-count-for="${key}"]`);if(node)node.textContent=n>0?n.toLocaleString('en-US'):'';}
function issueRow(item){
 const meta=[item.kindLabel,item.holder||item.owner,Number.isFinite(item.age)?`${item.age}d`:null].filter(Boolean).join(' · ');
 const group=STATUS_GROUPS.find(g=>g.key===item.statusGroup)?.label||'Other';
 return `<li class="cr-row" data-issue="${escapeHtml(item.id)}" data-group="${escapeHtml(item.statusGroup)}" data-kind="${escapeHtml(item.kind)}"><span class="cr-row-glyph" role="img" aria-label="${escapeHtml(group)}">${GLYPH[item.statusGroup]||'·'}</span><span class="cr-row-ref">${escapeHtml(item.ref)}</span><span class="cr-row-title">${escapeHtml(item.title)}</span><span class="cr-row-meta">${escapeHtml(meta)}</span></li>`;
}
function renderQueue(){
 const read=view.queue,queue=read.model;
 const coverage=$('crQueueCoverage'),more=$('crQueueMore');
 if(read.state!=='read'&&queue.pages===0){
  const failed=read.state==='unknown';
  coverage.textContent=failed?read.reason:'Reading the record layer…';coverage.dataset.complete='false';$('crQueueSources').hidden=true;
  if(failed)queueList.error(read.reason);else queueList.loading();
  for(const id of ['crTriageList','crViewsList'])replaceHtml($(id),failed?stateBlock('offline','The queue could not be read',`${read.reason}. Nothing is shown rather than a partial guess.`):stateBlock('loading','Reading the queue…'));
  more.hidden=true;return;
 }
 const line=coverageLine(queue);coverage.textContent=line.text;coverage.dataset.complete=String(line.complete);
 $('crQueueSources').hidden=line.details.length===0;
 replaceHtml($('crQueueSourceList'),line.details.map(d=>`<li><strong>${escapeHtml(d.source)}</strong> ${escapeHtml(d.text)}</li>`).join(''));
 const open=queueItems(queue),triage=triageItems(queue),everything=queueItems(queue,{includeTriage:true});
 queueList.rows(open,{triage:triage.length});
 replaceHtml($('crTriageList'),triage.length?`<ul class="cr-rows">${triage.map(issueRow).join('')}</ul>`:emptyBlock('crTriageEmpty'));
 const views=[
  ['Everything','Every loaded item, triage included',everything.length],
  ['Blocked','Items that cannot move',open.filter(i=>i.statusGroup==='blocked').length],
  ['In review','Waiting for a review or verification',open.filter(i=>i.statusGroup==='review').length],
  ['Bugs','Defects and incidents, untracked defects included',bugItems(queue).length],
 ];
 replaceHtml($('crViewsList'),`<ul class="cr-views">${views.map(([name,hint,n])=>`<li data-view="${escapeHtml(name)}"><span>${escapeHtml(name)}<small>${escapeHtml(hint)}</small></span><strong>${n.toLocaleString('en-US')}</strong></li>`).join('')}</ul>`);
 setCount('queue',open.length);setCount('triage',triage.length);
 more.hidden=!queue.nextCursor;more.disabled=read.loading===true;more.textContent=read.loading?'Loading…':'Load more';
}
// One page of the census; incidents and current holders enrich every page alike.
async function queueContext(){
 const current=client.currentWorkItem?await readWithDeadline(()=>client.currentWorkItem()).catch(()=>null):null;
 heldWork = validCurrentWorkItemPayload(current) ? current.current : [];
 renderAttention(attention.tasks, { state: attention.state });
 return {incidents:payloadOf('incidents')||null,current};
}
const readCensus=cursor=>readWithDeadline(()=>client.unfinishedWork({limit:QUEUE_PAGE,...(cursor?{cursor}:{})}));
// The 15-second refresh re-reads every page already loaded, so Load more survives it.
async function loadQueue(){
 const sequence=view.sequence;
 if(view.queue.model.pages===0){view.queue={...view.queue,state:'pending'};renderQueue();}
 try{const context=await queueContext();const model=await refreshQueue(view.queue.model,readCensus,context);if(sequence!==view.sequence)return;view.queue={state:'read',model:settleRefresh(view.queue.model,model)};}
 catch(error){if(sequence!==view.sequence)return;view.queue={state:'unknown',reason:[401,403].includes(error.status)?'Sign in required':'Updates unavailable',model:view.queue.model};}
 renderQueue();renderAttention(attention.tasks,{state:attention.state});
}
async function loadMoreQueue(){
 const cursor=view.queue.model.nextCursor;if(!cursor||view.queue.loading)return;
 view.queue={...view.queue,loading:true};renderQueue();
 try{const [census,context]=await Promise.all([readCensus(cursor),queueContext()]);const model=addPage(view.queue.model,census,context);view.queue={state:'read',model};announce(`Loaded ${plural(model.items.length,'item')}`);}
 catch{view.queue={...view.queue,loading:false};announce('More items could not be loaded');}
 renderQueue();
}
async function loadInbox(){
 try{
  const payload=await readWithDeadline(()=>client.notificationFeed({limit:50}));
  if(!validFeedPayload(payload))throw new Error('Invalid notification feed');
  const cards=notificationCards(payload);
  view.inbox={state:'read',cards};
  replaceHtml($('crInboxList'),cards.length?`<ul class="cr-rows">${cards.map(card=>`<li><button type="button" class="cr-row" aria-haspopup="dialog" aria-controls="crInboxDialog" data-room-control="${escapeHtml(card.id)}" data-notification="${escapeHtml(card.id)}" data-read="${card.read}"><span class="cr-row-glyph" role="img" aria-label="${card.read?'Read':'Unread'}">${card.read?'○':'●'}</span><span class="cr-row-ref">${escapeHtml(card.subject)}</span><span class="cr-row-title">${escapeHtml(card.reason)}</span><span class="cr-row-meta">${escapeHtml(card.clock)}</span></button></li>`).join('')}</ul>`:emptyBlock('crInboxEmpty'));
  if($('crInboxDialog').open)showInboxDetail($('crInboxDialog').dataset.notification);
  setCount('inbox',Number.isInteger(payload.unread_count)?payload.unread_count:cards.filter(c=>!c.read).length);
 }catch(error){view.inbox={state:'unknown'};$('crInboxDialog').close();replaceHtml($('crInboxList'),stateBlock('offline','Notifications could not be read',[401,403].includes(error?.status)?'Sign in required.':'Updates unavailable. Try again shortly.'));}
}
function showInboxDetail(id){
 const card=view.inbox.cards?.find(card=>card.id===id),dialog=$('crInboxDialog');
 if(!card){dialog.close();return;}
 dialog.dataset.notification=id;
 const properties=[['Category',card.subject],['Received',card.clock],['Status',card.read?'Read':'Unread'],['Severity',card.severityLabel],['Reference',card.details.subjectRef]].filter(([,value])=>value);
 const link=card.link.href?`<p><a href="${escapeHtml(card.link.href)}">${escapeHtml(card.link.label)}</a></p>`:card.link.sentence?`<p>${escapeHtml(card.link.sentence)}</p>`:'';
 replaceHtml($('crInboxBody'),`<p>${escapeHtml(card.reason)}</p><dl>${properties.map(([label,value])=>`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>${link}`);
 if(!dialog.open)dialog.showModal();
}
async function loadWaiting(){
 try{
  const payload=await readWithDeadline(()=>client.currentWorkRequests());
  if(payload?.ok!==true||!Array.isArray(payload.items))throw new Error('Invalid current work requests');
  const rows=payload.items.filter(row=>row?.state==='needs_joe'&&typeof row.human_ref==='string');
  replaceHtml($('crWaitingList'),rows.length?`<ul class="cr-rows">${rows.map(row=>`<li class="cr-row" data-waiting="${escapeHtml(row.human_ref)}" data-group="blocked"><span class="cr-row-glyph" role="img" aria-label="Needs your answer">■</span><span class="cr-row-ref">${escapeHtml(row.human_ref)}</span><span class="cr-row-title">${escapeHtml(row.title||row.human_ref)}</span><span class="cr-row-meta">${escapeHtml(row.next_human_action||'Answer needed')}</span></li>`).join('')}</ul>`:emptyBlock('crWaitingEmpty'));
  setCount('waiting',rows.length);
 }catch(error){replaceHtml($('crWaitingList'),stateBlock('offline','Waiting work could not be read',[401,403].includes(error?.status)?'Sign in required.':'Updates unavailable. Try again shortly.'));}
}
function showSection(key){
 $('crWorkbench').hidden=!ISSUE_SECTIONS.has(key);
 if(key!=='queue'&&$('crWorkbench').dataset.detail==='open')closePane({restoreFocus:false});
}
// V2 C2: the Queue list and its detail pane. The pane is a fixed column (Linear
// study #0 adaptation): Enter or a click opens it, Space or Cmd+I toggles it, Esc
// closes it, and the list runs full width while it is closed. On a phone the
// list and the record are two screens with a back control.
const paneOpen=()=>$('crWorkbench').dataset.detail==='open';
function openPane(item){
 if(!item)return;
 $('crWorkbench').dataset.detail='open';queueList.setOpen(item.id);detail.open(item);
 if(matchMedia('(max-width: 760px), (hover: none) and (pointer: coarse) and (max-width: 1023px)').matches){scrollTo({top:0});$('crDetail').querySelector('#crDetailTitle')?.focus({preventScroll:true});}
}
function closePane({restoreFocus=true}={}){
 if(!paneOpen())return false;
 $('crWorkbench').dataset.detail='closed';queueList.setOpen(null);detail.clear();
 if(restoreFocus)queueList.focus();
 return true;
}
const togglePane=item=>paneOpen()?closePane():openPane(item||queueList.highlighted);
function wireQueuePane(){
 detail=mountDetail({node:$('crDetail'),client,onClose:()=>closePane(),readDeadline:readWithDeadline});
 queueList=mountQueueList({node:$('crQueueList'),onOpen:openPane,onToggle:togglePane,onEscape:()=>closePane()});
 $('crDetail').addEventListener('keydown',event=>{if(event.key==='Escape'&&!ignoreKey(event)&&closePane())event.preventDefault();});
 $('crQueueList').addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('[data-queue-retry]'))loadQueue();});
 document.addEventListener('keydown',event=>{
  if(!paneShortcut(event)||document.querySelector('dialog[open]')||$('crWorkbench').hidden||$('panelQueue').hidden)return;
  event.preventDefault();togglePane();
 });
}

function openAtlas(node=null){mountAtlas({client,getIncidentsRead:()=>view.reads.incidents,node,onChange:atlas=>{view.atlas=atlas;}});}
async function boot(){
 const resolved=resolveDealroomBoot(globalThis.location);client=resolved.mode==='live'?createLiveClient():await createFixtureClient(resolved.options);
 onDialogClosed($("jobDialog"),()=>selectDocRecord(null,null));
 details=mountJobDetail({client,document});board=mountBoard({client,openTask:task=>details.open(withHolders([task])[0]),closeTask:()=>details.clear(),onTasks:renderAttention});board.start();
 $('crAttentionList').addEventListener('click',event=>{const button=event.target.closest('[data-attention-open]');const task=attention.state==='read'&&withHolders(attention.tasks).find(task=>task.id===button?.dataset.attentionOpen);if(task)details.open(task);});
 $('severityChips').addEventListener('click',event=>{
  const chip=event.target.closest('button[data-severity]');
  if(chip){view.severity=chip.dataset.severity;renderIncidents();}
 });
 $('incidentGroups').addEventListener('click',event=>{
  const row=event.target.closest('[data-incident]');
  if(row)openIncident(row.dataset.incident);
 });
 $('crInboxList').addEventListener('click',event=>{const row=event.target.closest('[data-notification]');if(row)showInboxDetail(row.dataset.notification);});
 $('crInboxClose').onclick=()=>$('crInboxDialog').close();
 onDialogClosed($('crInboxDialog'),()=>{const id=$('crInboxDialog').dataset.notification;[...$('crInboxList').querySelectorAll('[data-notification]')].find(row=>row.dataset.notification===id)?.focus();$('crInboxBody').textContent='';});
 mountNotificationBadge(client);tabs=wireTabs('controlRoomTabs');wireQueuePane();
 const strip=$('controlRoomTabs'),tabFor=key=>strip.querySelector(`[data-tab-key="${key}"]`);
 const commands=mountControlRoomCommands({tabs:strip,onEscape:()=>closePane()});
 const activate=selected=>{showSection(selected.dataset.tabKey);if(selected.id==='tabAtlas')openAtlas(new URLSearchParams(location.search).get('node'));if(selected.id==='tabSessions')mountSessions({});if(selected.id==='tabModelRoom')mountModelRoom({onOpenTask:task=>details.open(task,{source:'agents'}),onTasks:(tasks,observation)=>details.update(tasks,{...observation,source:'agents'})});};
 // The nav is vertical, so Up and Down move through it too.
 strip.addEventListener('keydown',event=>{if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;const all=[...strip.querySelectorAll('[role="tab"]')];const index=all.indexOf(document.activeElement);if(index<0)return;event.preventDefault();all[(index+(event.key==='ArrowDown'?1:-1)+all.length)%all.length].click();});
 strip.addEventListener('tabchange',event=>{const selected=event.detail.tab;if(!selected.dataset.tabKey)return;const next=new URL(location.href);if(next.searchParams.get('tab')!==selected.dataset.tabKey){next.searchParams.set('tab',selected.dataset.tabKey);history.pushState({},'',next);}activate(selected);const scrim=document.getElementById('appDrawerScrim');if(scrim&&!scrim.hidden)scrim.click();});
 const restoreTab=()=>{const selected=tabFor(sectionForTab(new URLSearchParams(location.search).get('tab')));if(selected){if(selected.getAttribute('aria-selected')!=='true')tabs.select(selected.id);activate(selected);}};
 window.addEventListener('popstate',restoreTab);restoreTab();
 // Opening the page restores a section without stealing focus for it.
 if(strip.contains(document.activeElement))document.activeElement.blur();
 $('crQueueMore').addEventListener('click',loadMoreQueue);
 $('automationPrev').onclick=()=>{month--;if(month<0){month=11;year--;}renderAutomations();};$('automationNext').onclick=()=>{month++;if(month>11){month=0;year++;}renderAutomations();};
 await load();const auto=mountAutoRefresh({document,window,refresh:load,intervalMs:15000});window.addEventListener('pagehide',event=>{if(!event.persisted){auto.dispose();board.dispose();commands.dispose();}});
}
boot();
