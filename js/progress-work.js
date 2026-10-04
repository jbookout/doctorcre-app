import { authGeneration, authCurrent, authReadable, establishAuth, invalidateAuth } from './progress-auth.js';
import { createLiveClient } from './live-client.js';
import { boardView, boardFreshness, taskIdentity, taskSummary, relatedQuestions, deliveryDetail } from './progress-board-model.js';
import { mountProgressWire } from './room.js';
import { validEngineeringPassport } from './job-passport.js';
import { workScope, workDetailUrl, scopedTurn, scopedQueueCard, passportAttempts, canonicalPassport, executionTurn, sourceSequence } from './progress-work-model.js';
import { systemPipeline, validSystemWork } from './system-work-board-model.js';

const client = createLiveClient();
const scope = workScope(location.search);
const explicitWorkRequest = scope.workRequest;
const $ = id => document.getElementById(id);
const node = (tag, value, className) => {
  const el = document.createElement(tag); if (value != null) el.textContent = String(value);
  if (className) el.className = className; return el;
};
const empty = (host, value) => host.replaceChildren(node('p', value, 'work-empty'));
let wire, turns = [], engineering = null, card = null, queueTask = null, selectedSession = scope.session;
let dotCards = [], queueState = 'Connecting';
let sessionIds = new Set(), dispatchCursor = null, reading = false;
let dispatchRows = [], dispatchPages = 0;
let sessionQuery = '', sessionRequest = 0;
let dispatchSelection = 0, dispatchPending = null;
let bindingGeneration = 0;
const signatures = new Map();
function clearRequestEvidence(message) {
  engineering = null; card = null; turns = []; dotCards = [];
  scope.refs = []; scope.attempts = []; sessionIds.clear(); ++sessionRequest;
  selectedSession = scope.session; ++dispatchSelection;
  dispatchRows = []; dispatchCursor = null; dispatchPages = 0;
  $('workDispatchMore').hidden = true; signatures.clear();
  for (const id of ['workMetadata','workSessionList','workDispatchHistory','workCanonicalBody','workReviewList','workDotList']) empty($(id),message);
}
function reconcileWorkRequest(task) {
  const reference = task?.work_request || task?.human_ref || task?.id;
  const next = explicitWorkRequest || (/^WR-\d+$/.test(reference || '') ? reference : null);
  if (next === scope.workRequest) return;
  scope.workRequest = next; ++bindingGeneration;
  clearRequestEvidence('Reading evidence for the current task binding.');
  wire?.refreshScope();
}

function patch(host, value, build) {
  const signature = JSON.stringify(value);
  if (signatures.get(host.id) === signature || host.contains(document.activeElement)) return;
  signatures.set(host.id, signature); host.replaceChildren(...build());
}
function fields(value) {
  const dl = node('dl', null, 'work-detail-fields');
  for (const [key, item] of Object.entries(value)) {
    if (item == null || typeof item === 'object') continue;
    const row = node('div'); row.append(node('dt', key.replaceAll('_', ' ')), node('dd', item)); dl.append(row);
  }
  return dl;
}
function record(title, value) {
  const el = node('article', null, 'work-record'); el.append(node('h3', title), fields(value));
  const detail = node('details'); detail.append(node('summary', 'Recorded evidence'), node('pre', JSON.stringify(value, null, 2)));
  el.append(detail); return el;
}
function taskRecord(task, questions) {
  const identity = taskIdentity(task);
  const article = record(task === queueTask ? 'Projected task' : 'Published task',
    { ...task, repo: task.repo || 'Not recorded', summary: taskSummary(task), ...identity });
  const link = (url, label) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      const anchor = node('a', label); anchor.href = parsed.href;
      anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      const row = node('p'); row.append(anchor); article.append(row);
    } catch { /* Only valid web links are rendered. */ }
  };
  const prs = [...(task.pr != null ? [{repo: task.repo, number: task.pr, head_sha: task.pr_head}] : []),
    ...(Array.isArray(task.pr_links) ? task.pr_links : [])];
  for (const pr of prs) {
    const number = Number(pr.number);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const label = `PR #${number}${pr.head_sha ? ` · ${pr.head_sha}` : ''}`;
    if (!pr.repo) article.append(node('p', label));
    else if (/^[\w.-]+\/[\w.-]+$/.test(pr.repo))
      link(`https://github.com/${pr.repo}/pull/${number}`, `${pr.repo} · ${label}`);
  }
  for (const url of String(task.evidence || '').match(/https?:\/\/[^\s;,]+/g) || []) {
    const clean = url.replace(/[.)]+$/, ''); link(clean, clean);
  }
  for (const question of relatedQuestions(task, questions))
    article.append(record('Board question', {prompt: question.prompt, status: question.status,
      answer: question.answer_text || `Waiting · ${question.default_answer || 'No default recorded'}`}));
  for (const event of Array.isArray(task.stage_history) ? task.stage_history : [])
    article.append(record('Stage history', event));
  return article;
}
// The board card's derived delivery facts, which the raw record does not show.
function deliveryRecord(detail) {
  const article = node('article', null, 'work-record work-delivery'); article.append(node('h3', 'Delivery'));
  const dl = node('dl', null, 'work-detail-fields');
  for (const [label, value] of detail.rows) { const row = node('div'); row.append(node('dt', label), node('dd', value)); dl.append(row); }
  article.append(dl);
  if (detail.history.length) {
    const list = node('ol', null, 'work-stage-history'); list.setAttribute('aria-label', 'Stage history');
    for (const entry of detail.history) {
      const item = node('li'); item.dataset.stage = entry.stage;
      const since = node('time', ` from ${entry.entered_at}`); since.dateTime = entry.entered_at;
      item.append(node('strong', entry.label), node('span', ` ${entry.duration}`), since); list.append(item);
    }
    article.append(list);
  }
  return article;
}
function breadcrumbs(boardTitle = scope.board, title = scope.task || 'Project activity') {
  const signature = JSON.stringify([boardTitle,title]);
  if ($('workBreadcrumbs').dataset.signature === signature) return;
  $('workBreadcrumbs').dataset.signature = signature;
  const list = node('ol');
  for (const [label, href] of [['Progress', '/control-room/progress'], [boardTitle, `/control-room/progress?board=${encodeURIComponent(scope.board)}`], [title, null]]) {
    const item = node('li'); const link = node(href ? 'a' : 'span', label);
    if (href) link.href = href; else link.setAttribute('aria-current', 'page'); item.append(link); list.append(item);
  }
  $('workBreadcrumbs').replaceChildren(list);
}
breadcrumbs();
$('sharedActivityLink').href = workDetailUrl({ board: scope.board, view: 'wire' });
$('workTasks').hidden = Boolean(scope.task || scope.workRequest || scope.session);
$('workTasksLink').hidden = $('workTasks').hidden;
if (scope.view === 'tasks') $('workTasks').scrollIntoView();
// Shared infrastructure is not evidence of execution on the selected task.
$('roomStage').setAttribute('aria-label', 'Shared infrastructure · all projects');
$('stageDesc').textContent += ' Shared infrastructure covers all projects and is not task execution evidence.';

function linkedSessionRefs(value, target = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return target;
  for (const [key, item] of Object.entries(value)) {
    if (['session_id','canonical_session_id','session_ref','native_session_ref','native_host_id'].includes(key) && typeof item === 'string') target.add(item);
    else if (typeof item === 'object') linkedSessionRefs(item, target, depth + 1);
  }
  return target;
}
function nativeReference(ref) { return typeof ref === 'string' ? ref.replace(/^native:(?:codex|claude):/, '').replace(/^(?:session|codex|claude):/, '') : ref; }
function deriveLinks() {
  const ids = new Set(scope.session ? [scope.session] : []);
  linkedSessionRefs(engineering, ids);
  for (const turn of turns.filter(turn => executionTurn(turn, scope))) {
    if (turn.session_id) ids.add(turn.session_id);
    try { linkedSessionRefs(JSON.parse(turn.body), ids); } catch { /* raw topic is not identity */ }
  }
  const changed = [...ids].sort().join() !== [...sessionIds].sort().join();
  sessionIds = ids;
  if (changed) readSessions();
}
function flow(task) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 720 90'); svg.setAttribute('role','img'); svg.setAttribute('aria-label','Task links to sessions, attempts and independent review'); svg.classList.add('work-flow');
  const status = task?.status || card?.state;
  svg.dataset.pulse = ['failed','blocked'].includes(status) ? 'critical' : ['review','needs_revision'].includes(status) ? 'attention' : ['running','in_progress','claimed'].includes(status) ? 'healthy' : 'still';
  for (const [index, label] of ['Task', 'Sessions', 'Attempts', 'Review'].entries()) {
    const x = index * 180;
    if (index) { const line = document.createElementNS(svg.namespaceURI,'line'); for (const [key,value] of Object.entries({x1:x-40,y1:40,x2:x,y2:40})) line.setAttribute(key,value); svg.append(line); }
    const rect = document.createElementNS(svg.namespaceURI,'rect'); for (const [key,value] of Object.entries({x,y:10,width:140,height:60,rx:10})) rect.setAttribute(key,value);
    const text = document.createElementNS(svg.namespaceURI,'text'); text.setAttribute('x',x+12); text.setAttribute('y',45); text.textContent = label; svg.append(rect,text);
  }
  return svg;
}
function renderReviews() {
  const facts = engineering ? [...engineering.reviewer_facts, ...engineering.receipts] : [];
  const observed = turns.filter(turn => scopedTurn(turn, scope) && /review|fix|revision/i.test(turn.kind + ' ' + turn.body));
  patch($('workReviewList'), {facts, observed}, () => {
    const rows = facts.map(fact => record(fact.slice_ref ? `Slice ${fact.slice_ref}` : 'Attempt receipt', fact));
    if (observed.length) { const history = node('details'); history.append(node('summary', 'Observed review and fix turns · not closure proof'));
      for (const turn of observed) history.append(record(`Turn ${turn.seq}`, {at:turn.created_at,seat:turn.origin_actor || turn.actor,body:turn.body})); rows.push(history); }
    return rows.length ? rows : [node('p','No linked review or fix receipt is available.','work-empty')];
  });
}
function renderDot() {
  const observed = turns.filter(turn => scopedTurn(turn,scope) && (turn.seat === 'dot' || (() => {
    try { return JSON.parse(turn.body)?.target === 'dot'; } catch { return false; }
  })()));
  patch($('workDotList'),{dotCards,observed,queueState},()=>{
    const rows = [node('p',`Queue projection: ${queueState}`,'work-empty')];
    for (const card of dotCards) { const item = record(card.title,card), link = node('a','Open research work'); link.href = workDetailUrl({board:scope.board,task:card.task_id}); item.append(link); rows.push(item); }
    for (const turn of observed) rows.push(record(`Observed Dot turn ${turn.seq}`,{at:turn.at,kind:turn.kind,body:turn.body}));
    if (!dotCards.length && !observed.length) rows.push(node('p','No Dot-targeted research job is linked in the current queue or loaded wire.','work-empty'));
    return rows;
  });
}
async function readDispatch(more = false) {
  if (!selectedSession || more && !dispatchCursor || dispatchPending?.selection === dispatchSelection) return;
  const id = selectedSession, epoch = authGeneration(), selection = dispatchSelection;
  const request = dispatchPending = {selection};
  const cursor = more ? dispatchCursor : null;
  $('workDispatchMore').disabled = true;
  try {
    const read = await client.dispatchHistory({ session_id:id,limit:100,...(cursor ? {cursor} : {}) });
    if (id !== selectedSession || selection !== dispatchSelection || !authReadable(epoch)) return;
    if (!Array.isArray(read.events)) throw new Error('dispatch shape');
    const eventKey = event => event.event_id != null ? `${event.session_id}:${event.event_id}` : JSON.stringify(event);
    dispatchRows = [...new Map((more ? [...dispatchRows,...read.events] : [...read.events,...dispatchRows]).map(event => [eventKey(event),event])).values()];
    if (more) dispatchPages++;
    patch($('workDispatchHistory'),dispatchRows,()=>[node('h3','Session dispatches · Sent, received, acknowledged and acted are separate evidence'),
      ...dispatchRows.map(event=>record(event.stage || 'Dispatch',event)),
      ...(!dispatchRows.length ? [node('p','No recorded dispatch events for this session.','work-empty')] : []),
      ...['received_unavailable_reason','acknowledged_unavailable_reason'].filter(key=>read[key]).map(key=>node('p',read[key]))]);
    if (more || !dispatchPages) { dispatchCursor = read.next_cursor; $('workDispatchMore').hidden = read.more !== true || !dispatchCursor; }
  } catch (error) { if (authCurrent(epoch) && selection === dispatchSelection) fail(error, $('workDispatchHistory'), 'Dispatch history'); }
  finally { if (dispatchPending === request) { dispatchPending = null; $('workDispatchMore').disabled = false; } }
}
async function readSessions(query = sessionQuery) {
  sessionQuery = query;
  const request = ++sessionRequest, epoch = authGeneration(), binding = bindingGeneration;
  const current = () => authReadable(epoch) && binding === bindingGeneration && request === sessionRequest && query === sessionQuery;
  try {
    const read = await client.sessionIdentity({limit:50,include_closed:true,...(query ? {query} : {})});
    if (!current()) return;
    if (!Array.isArray(read.sessions)) throw new Error('session shape');
    const unscoped = !scope.task && !scope.workRequest && !scope.session;
    const rows = read.sessions.filter(row => query || unscoped || sessionIds.has(row.canonical_session_id) || [...sessionIds].some(ref => nativeReference(ref) === nativeReference(row.native_host_id) && row.native_host_id));
    patch($('workSessionList'), {rows, query,filtered:read.permission_filtered}, () => {
      const nodes = [node('p',query ? 'Lookup results · selecting a session adds its explicit link to this view.' : 'Recorded sessions linked by exact evidence.','work-empty')];
      if (read.permission_filtered) nodes.push(node('p','CARR omitted sessions outside your permission.'));
      for (const row of rows) {
        const item = record(row.display_name || 'Recorded session',row);
        const pick = node('button','Read dispatch history'); pick.type = 'button'; pick.dataset.sessionId = row.canonical_session_id;
        pick.addEventListener('click',() => { selectedSession = row.canonical_session_id; ++dispatchSelection; dispatchCursor = null; dispatchRows = []; dispatchPages = 0; readDispatch(); }); item.append(pick); nodes.push(item);
      }
      if (!rows.length) nodes.push(node('p','No linked native session is available in this read. Use lookup for an explicit session.','work-empty'));
      return nodes;
    });
    if (selectedSession) readDispatch();
  } catch (error) { if (authCurrent(epoch) && binding === bindingGeneration && request === sessionRequest) fail(error, $('workSessionList'), 'Sessions'); }
}
function fail(error, host, label) {
  if (error.status === 401 || error.status === 403) {
    invalidateAuth();
    const signIn = node('a','Sign in'); signIn.href = `/auth/login?return_to=${encodeURIComponent(location.pathname+location.search)}`; host.append(signIn);
  } else {
    const status = host.querySelector('.work-read-error') || node('p',null,'work-read-error');
    status.textContent = `${label} unavailable · retained evidence is last-known. Retrying.`; host.append(status);
  }
  $('workReadState').textContent = 'Work evidence unavailable · last-known records may be stale.';
  $('workReadState').dataset.state = 'stale';
}
document.addEventListener('progress-auth-lost', () => {
    ++bindingGeneration; scope.workRequest = explicitWorkRequest; queueTask = null;
    clearRequestEvidence('Sign in to read work evidence.'); scope.sourceSeqs = [];
    $('workTitle').textContent = 'Work detail'; document.title = 'Work detail · Progress';
    breadcrumbs('Progress', 'Sign in');
});
function renderMetadata(task, questions) {
  const delivery = task ? deliveryDetail(task) : null;
  // Displayed delivery ages change independently of publication revisions.
  patch($('workMetadata'), {task, card, questions, delivery}, () => [
    flow(task), ...(task ? [deliveryRecord(delivery), taskRecord(task, questions)] : [node('p', scope.task
      ? 'This task is not in the loaded publication; linked wire evidence remains available.'
      : 'Shared project activity · infrastructure and queue cover all projects.', 'work-empty')]),
    ...(card ? [record('Work request', card)] : []),
  ]);
}
async function refresh() {
  if (reading) return; reading = true;
  const epoch = authGeneration();
  try {
    const read = await client.readProgressBoard({board_id:scope.board});
    if (!authCurrent(epoch)) return;
    establishAuth(epoch);
    const view = boardView(read); let task = view.stages.flatMap(stage => stage.tasks).find(task => task.id === scope.task);
    if (!task && scope.board === 'carr-v5' && /^[a-z_]+:.+/.test(scope.task || '')) {
      const split = scope.task.indexOf(':'), kind = scope.task.slice(0,split), id = scope.task.slice(split+1);
      const census = validSystemWork(await client.unfinishedWork({kinds:kind,id,limit:1}));
      if (!authReadable(epoch)) return;
      task = systemPipeline(census.items,[]).stages.flatMap(stage => stage.tasks).find(item => item.id === scope.task);
    }
    task ||= queueTask;
    reconcileWorkRequest(task);
    const workRequest = scope.workRequest, binding = bindingGeneration;
    const currentBinding = () => authCurrent(epoch) && binding === bindingGeneration && workRequest === scope.workRequest;
    const title = task?.title || card?.title || (scope.task ? 'Task work' : 'Project activity');
    $('workTitle').textContent = title; document.title = `${title} · Progress`; breadcrumbs(view.title, title);
    const age = boardFreshness(view.updated_at); $('workReadState').textContent = `${age.label}${age.state === 'stale' ? ' · Stale publication' : ''}`; $('workReadState').dataset.state = age.state;
    renderMetadata(task, view.questions);
    if (workRequest) await Promise.allSettled([
      client.workRequestCard({work_request:workRequest}).then(value => { if (!currentBinding()) return; if (value.human_ref !== workRequest) throw new Error('work binding'); card = value; $('workTitle').textContent = task?.title || card.title || title; renderMetadata(task, view.questions); }).catch(error=>currentBinding() && fail(error,$('workMetadata'),'Work request')),
      client.engineeringPassport({work_request:workRequest}).then(value => { if (!currentBinding()) return;
        if (!canonicalPassport(value) && !validEngineeringPassport(value)) throw new Error('passport binding'); engineering = value;
        // The canonical projection resolves a human reference into its immutable
        // wr:<uuid> binding. Keep that binding for subsequent exact wire joins.
        scope.refs = [...new Set([...(scope.refs || []),typeof value.work_request === 'string' ? value.work_request : value.work_request.id])];
        scope.attempts = passportAttempts(value);
        patch($('workCanonicalBody'),value,()=>[record(`Closure: ${value.closure_state} · ${value.stale_conflict.state}`,value)]); deriveLinks(); renderReviews();
      }).catch(error => currentBinding() && fail(error,$('workCanonicalBody'),'Engineering Passport')),
    ]);
    else empty($('workCanonicalBody'),'No canonical work-request reference is linked to this task.');
    if (!currentBinding() || !authReadable(epoch)) return;
    renderReviews(); await readSessions();
    if (authReadable(epoch)) wire?.refreshScope();
  } catch (error) { if (authCurrent(epoch)) fail(error,$('workMetadata'),'Publication'); }
  finally { reading = false; }
}
document.addEventListener('progress-queue', event => {
  if (!authReadable(authGeneration())) return;
  const cards = event.detail.cards;
  const task = cards.find(card => card.task_id === scope.task);
  if (!task && event.detail.state === 'Live') {
    const hadTask = queueTask !== null; queueTask = null; scope.sourceSeqs = [];
    wire?.refreshScope();
    if (hadTask) refresh();
  }
  if (task) { queueTask = task; scope.sourceSeqs = sourceSequence(task.source_seq) === null ? [] : [sourceSequence(task.source_seq)]; if (!$('workMetadata').querySelector('article')) $('workMetadata').append(taskRecord(task,[])); if ($('workTitle').textContent === 'Task work') $('workTitle').textContent = task.title; wire?.refreshScope(); }
  dotCards = cards.filter(card => card.target === 'dot' && scopedQueueCard(card,scope));
  queueState = event.detail.state || (event.detail.live === true ? 'Live' : 'Stale'); renderDot();
});
$('workSessionSearch').addEventListener('submit',event=>{event.preventDefault();readSessions($('workSessionQuery').value.trim());});
document.addEventListener('progress-queue-state',event=>{
  queueState=event.detail.state;
  if (event.detail.authRequired) { fail({status:401},$('workDotList'),'Queue'); return; }
  renderDot();
});
$('workDispatchMore').addEventListener('click',()=>readDispatch(true));
empty($('workDotList'),'Waiting for the queue projection.');
wire = mountProgressWire({scope,onRead:read=>{
  if (!authReadable(authGeneration())) return;
  turns = read.turns;
  deriveLinks(); renderReviews(); renderDot();
}});
refresh();
let refreshTimer;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(async()=>{await refresh();scheduleRefresh();},document.hidden?30000:5000); }
document.addEventListener('visibilitychange',scheduleRefresh); scheduleRefresh();
