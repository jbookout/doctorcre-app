import { OWNER_FILTERS } from './owner-filters.js';
import { engagementWriterFor } from './prospect-engagement.mjs';
import { showToast } from './toast.js';
import { renderDealVendors } from './deal-vendors.js';
import { pageDocContext, selectDocRecord, setDocFilters, publishDocRead } from './doc-context.js';
import { createCommandDock } from './command-dock.js';
import { readWithDeadline } from './auto-refresh.mjs';
import { preserveBoardFocus } from './board-focus.mjs';
import { performCommand, pendingCommand } from './command-feedback.mjs';
import { createFixtureClient } from './fixture-client.js';
import { createLiveClient } from './live-client.js';
import { mountEvidence, loadEvidence, renderEvidence } from './correspondence.js';
import { deploymentIdentity, resolveDealroomBoot } from './boot-mode.js';
import { ACTOR_LABEL } from './client.js';
import { mountNotificationBadge, mountPrefs } from './shell.js';
import { formatCalendarDate } from './visual-system.js';
import {
  createBoardSync, batchTouchesBoard, HEALTH, SYNC_STATES,
} from './board-sync.mjs';
import {
  cellKey, performFieldWrite, unresolvedFieldWrites, fieldWriteMessage, nextCellBase,
} from './field-write-reconciliation.mjs';
import {
  escapeText, fieldLabel, readableValue, ingestChangeEvents, receiptViews, receiptListHtml,
  receiptsSignature, createFeedProgress, observeChangeBatch, performUndo,
} from './change-receipts.mjs';
import {
  CLOSED_SLUG, COLUMNS, OPEN_COLUMNS, COMPLETION_CAPTIONS, closedColumnCaption, columnBySlug, columnByValue,
  columnLabel, completionPlan, contextDrawerSections, groupByColumn, keyboardTarget,
  loadDealContext, moveIntent, moveSummary, moveTitle, noteText, dealName,
} from './pipeline-model.js';
import { isClosedDeal, localDeals, needsAttention } from './deal-review-model.js';
import { lostDeals, closedDeals, urgencyOrder, concise, automaticMove, PHASE_TRIGGERS } from './local-deals-model.js';
import { renderDealTimeline, renderDealUpdates } from './deal-timeline.js';
import { renderDealChecklist } from './deal-checklist.js';
import { uuidv4 } from './uuid.js';
import { mountVisibilityPoll } from './visibility-poll.mjs';

const POLL_MS = 1400;
const BOARD_REFRESH_MS = 15000;

const $ = (id) => document.getElementById(id);
const esc = escapeText;
const actorName = (slug) => ACTOR_LABEL[slug] || slug || 'Unassigned';
const incomingScope = new URLSearchParams(globalThis.location?.search);

const state = {
  client: null,
  selfActor: null,
  mode: 'fixture',
  /** Rows by id, replaced wholesale by every applied snapshot. */
  deals: new Map(),
  boardSync: null,
  /** Per cell, the newest event SEEN for it — the base its next write sends. */
  fieldBase: new Map(),
  fieldWrites: {},
  presence: [],
  receipts: [],
  undo: {},
  feed: createFeedProgress(),
  receiptSignature: null,
  filter: ['joe','dell'].includes(incomingScope.get('owner')) ? incomingScope.get('owner') : 'all',
  personalScope: incomingScope.get('owner') === 'me',
  scopeFilter: incomingScope.get('filter') === 'flagged' ? 'flagged' : 'all',
  view: ['list','closed','lost'].includes(incomingScope.get('view')) ? incomingScope.get('view') : 'board',
  closedDeals: null,
  lostDeals: null,
  parkedOpen: false,
  /** Ids, never rows: a lifted card, a chosen column, an open panel, a move in hand. */
  lifted: null,
  target: null,
  panelDeal: null,
  panelReturnTo: null,
  intent: null,
  boardStatus: 'starting',
  unplaced: 0,
};

let commandState = {};
let dock = { record: () => {}, mount: () => {}, render: () => {}, forget: () => {} };
const operations = new Map();

function announce(text) {
  const live = $('dragLive');
  if (live) live.textContent = text;
}

function say(text) {
  const live = $('boardLive');
  if (live && live.textContent !== text) live.textContent = text;
}

const dateWords = (value) => (value ? formatCalendarDate(value) || value : 'no date recorded');


function autoHtml(deal) {
  const move = automaticMove(deal);
  return move ? `<div class="auto-move"><span>${esc(move.text.slice(0, move.text.lastIndexOf(' ')))}</span> <time>${esc(move.text.slice(move.text.lastIndexOf(' ') + 1))}</time></div>` : '';
}
const dealTitle = (deal) => dealName(deal.name);
function nextStepHtml(deal) {
  const text = noteText(deal.next_step);
  if (!text.trim()) return '';
  return `<p class="next-line" title="${esc(text)}">${esc(text)}</p>`;
}
function cardHtml(deal) {
  const attention = needsAttention(deal);
  const pending = pendingCommand(state.fieldWrites, cellKey(deal.id, 'phase'));
  return `<article class="kanban-card" data-id="${esc(deal.id)}" data-attention="${attention}" data-phase="${esc(deal.phase)}" draggable="true" tabindex="0"${pending ? ' data-pending="true"' : ''}${state.lifted === deal.id ? ' data-lifted="true"' : ''} aria-label="${esc(dealTitle(deal))}, ${esc(columnLabel(deal.phase))}">
    <h4><button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(dealTitle(deal))}</button></h4>
    <div class="work-meta"><span class="owner">${esc(actorName(deal.owner))}</span>${attention ? '<span class="attention-flag"><span aria-hidden="true">◆</span> Overdue</span>' : ''}</div>
    ${nextStepHtml(deal)}
    ${renderDealVendors(deal.vendors)}
    ${autoHtml(deal)}
  </article>`;
}
function rowHtml(deal) {
  return `<article class="kanban-card deal-row" data-id="${esc(deal.id)}" tabindex="0" data-attention="${needsAttention(deal)}">
    <h4>${esc(dealTitle(deal))}</h4><span class="deal-stage">${esc(columnLabel(deal.phase))}</span>
    ${nextStepHtml(deal)}<span class="owner">${esc(actorName(deal.owner))}</span>${renderDealVendors(deal.vendors)}${autoHtml(deal)}</article>`;
}
function parkedHtml(deal) {
  return `<article class="kanban-card parked-card" data-id="${esc(deal.id)}" tabindex="0"><h4>${esc(dealTitle(deal))}</h4><p class="next-line">${esc(deal.parking_note || deal.parking_reason?.replaceAll('_',' ') || 'Parked')}</p>${renderDealVendors(deal.vendors)}<button class="btn btn-quiet" type="button" data-revive="${esc(deal.id)}">Revive</button></article>`;
}

let dealCreation = null;
let creatingDeal = false;
function syncDealCreation() {
  $('addDealFields').disabled = creatingDeal || Boolean(dealCreation);
  $('addDealSubmit').disabled = creatingDeal;
  $('addDealCancel').disabled = creatingDeal;
  $('addDealSubmit').textContent = creatingDeal ? 'Saving…' : dealCreation ? 'Check creation outcome' : 'Create deal';
}
function openAddDeal() {
  if (!dealCreation) {
    $('addDealForm').reset();
    $('addDealOwner').value = state.selfActor || 'joe';
    $('addDealError').textContent = '';
  }
  syncDealCreation();
  $('addDealDialog').showModal();
}
async function submitDeal(event) {
  event.preventDefault();
  if (creatingDeal) return;
  const errorBox = $('addDealError');
  if (!dealCreation) {
    const args = Object.fromEntries(new FormData($('addDealForm')));
    for (const name of ['name','client','notes']) args[name] = args[name].trim();
    if (!args.name || !args.client) {
      errorBox.textContent = 'Enter a deal name and an existing client.'; errorBox.focus(); return;
    }
    dealCreation = {...args, lane:'territory', idempotency_key:uuidv4()};
  }
  creatingDeal = true; syncDealCreation(); errorBox.textContent = '';
  try {
    const request = dealCreation;
    const result = await state.client.createDeal(request);
    if (result?.status !== 'ok') throw new Error('Creation receipt unavailable');
    dealCreation = null;
    state.filter = request.owner; state.personalScope = false; state.scopeFilter = 'all';
    const url = new URL(location.href); url.searchParams.set('owner',request.owner); url.searchParams.delete('filter'); history.replaceState({},'',url);
    await loadBoard();
    $('boardView').click();
    $('addDealDialog').close();
    const id = result.deal_id || result.deal?.id;
    document.querySelector(`.kanban-card[data-id="${CSS.escape(id || '')}"] .card-open`)?.focus();
    showToast('Deal created');
  } catch (error) {
    if (error.creationRefused) {
      dealCreation = null;
      const reasons = { subject_not_found:'Client not found. Use an existing client reference or exact name.', not_a_client:'Choose an existing client.', needs_disambiguation:'More than one client matches. Use the client reference.', deal_name_exists:'A deal with this name already exists. Use a distinct name.' };
      errorBox.textContent = reasons[error.payload?.error] || 'Deal creation was refused. Check the client, name, type, and stage.';
    } else errorBox.textContent = 'Creation not confirmed. The original request is retained. Check creation outcome to finish the same deal, owner, and notes.';
    errorBox.focus();
  } finally { creatingDeal = false; syncDealCreation(); }
}

function renderClosedDeals() {
  const lost = state.view === 'lost';
  const label = lost ? 'lost' : 'closed';
  $('closedDealsTitle').textContent = lost ? 'Lost deals' : 'Closed deals';
  document.querySelector('label[for=closedSearch]').textContent = `Search ${label} deals`;
  const archived = lost ? state.lostDeals : state.closedDeals;
  const records = new Map(state.deals);
  for (const deal of archived || []) records.set(deal.id,{...records.get(deal.id),...deal});
  const rows = (lost ? lostDeals : closedDeals)([...records.values()], state.filter, $('closedSearch').value);
  $('closedCount').textContent = archived === null ? 'Closed history is unavailable. Refresh to try again.' : `${rows.length} ${label} deals`;
  $('closedDealsList').innerHTML = rows.map(d => `<article class="closed-deal glass" data-id="${esc(d.id)}">
    <h3><button type="button" class="card-open" data-open-deal="${esc(d.id)}">${esc(dealTitle(d))}</button></h3><dl><div><dt>Client</dt><dd>${esc(d.client_name || d.client_ref || 'Not recorded')}</dd></div>
    <div><dt>Type</dt><dd>${esc(d.type || 'Not recorded')}</dd></div><div><dt>Close date</dt><dd>${esc(d.closed_on ? dateWords(d.closed_on) : 'Not recorded')}</dd></div>
    <div><dt>Owner</dt><dd>${esc(actorName(d.owner))}</dd></div></dl>${renderDealVendors(d.vendors)}${autoHtml(d)}</article>`).join('') || (archived === null ? '' : `<p>No ${label} deals match this search.</p>`);
}

function visibleBoardDeals() {
  return localDeals([...state.deals.values()], state.personalScope ? state.selfActor : state.filter)
    .filter(d => state.scopeFilter !== 'flagged' || needsAttention(d));
}
function renderBoardMessage(status = state.boardSync?.status()) {
  if (status && (!status.online || [HEALTH.FAILED,HEALTH.RENDER_FAILED].includes(status.board_health))) {
    say('The board is unavailable. Refresh to try again.');
    return;
  }
  const rows = visibleBoardDeals();
  const parked = rows.filter(d => d.operating_state === 'parked').length;
  say(`${rows.length - parked} open deals · ${parked} parked`);
}

function renderBoard() {
  const board = $('kanban');
  if (!board) return;
  board.hidden = ['closed','lost'].includes(state.view);
  $('boardLive').hidden = ['closed','lost'].includes(state.view);
  $('closedDealsView').hidden = !['closed','lost'].includes(state.view);
  $('parkedToggle').hidden = ['closed','lost'].includes(state.view);
  if (['closed','lost'].includes(state.view)) { renderClosedDeals(); return; }
  if (board.dataset.pressed === 'true' || board.querySelector('[data-dragging="true"]')) { state.paintDeferred = true; return; }
  state.paintDeferred = false;
  const rows = visibleBoardDeals();
  setDocFilters({ owner: state.personalScope ? state.selfActor : state.filter, filter: state.scopeFilter });
  if (state.panelDeal) {
    if (state.panelDetail) publishDocRead('getDeal', state.panelDetail, [state.panelDeal]);
    selectDocRecord('deal', state.panelDeal);
  }
  publishDocRead('getBoard', { deals: rows });
  const active = rows.filter(d => d.operating_state !== 'parked');
  const prospects = rows.filter(d => columnByValue(d.phase)?.slug === 'pending');
  const parked = rows.filter(d => d.operating_state === 'parked' && columnByValue(d.phase)?.slug !== 'pending');
  renderBoardMessage();
  const grouped = groupByColumn(active);
  state.unplaced = grouped.unplaced.length;
  preserveBoardFocus({ board, document, announce, paint() {
    board.innerHTML = state.view === 'list' ? `<div class="deal-list">${urgencyOrder(state.parkedOpen ? rows : active).map(d => d.operating_state === 'parked' ? parkedHtml(d) : rowHtml(d)).join('')}</div>` : grouped.columns.map((column) => {
      const cards = urgencyOrder(column.slug === 'pending' ? prospects : column.deals);
      const content = cards.map(d => d.operating_state === 'parked' ? parkedHtml(d) : cardHtml(d)).join('');
      const chosen = state.lifted && state.target === column.slug;
      return `<section class="kanban-column glass" data-column="${esc(column.slug)}"${chosen ? ' data-drop="true"' : ''}
        aria-label="${esc(column.label)}, ${cards.length} cards">
        <h3 title="${esc(PHASE_TRIGGERS[column.slug])}">${esc(column.label)}<small>${cards.length}</small></h3>
        ${content}
      </section>`;
    }).join('') + `<details class="parked-lane"${state.parkedOpen ? ' open' : ''}><summary>Parked · ${parked.length}</summary><div class="parked-cards">${parked.map(parkedHtml).join('')}</div></details>`;
  } });
  const note = $('boardNote');
  if (note) {
    note.hidden = state.unplaced === 0;
    note.textContent = state.unplaced
      ? `${state.unplaced} deals need a phase`
      : '';
  }
  renderPendingWrites();
}

function renderChips() {
  const bar = $('boardChips');
  if (!bar) return;
  const filters = OWNER_FILTERS;
  if (!filters.some((entry) => entry.value === state.filter)) state.filter = 'all';
  bar.innerHTML = filters.map((entry) => `<button class="chip" type="button" data-filter="${esc(entry.value)}"
    aria-pressed="${String(entry.value === state.filter)}">${esc(entry.label)}</button>`).join('');
}

function renderStatus(status) {
  renderBoardMessage(status);
  state.boardStatus = status.state;
  const label = status.state === SYNC_STATES.OFFLINE ? 'Offline'
    : status.state === SYNC_STATES.ERROR ? 'Board view error'
    : status.state === SYNC_STATES.RECONNECTING ? 'Reconnecting'
    : status.state === SYNC_STATES.READY ? 'Current'
    : 'Updating…';
  const orbState = status.state === SYNC_STATES.READY ? 'healthy'
    : status.state === SYNC_STATES.ERROR || status.state === SYNC_STATES.OFFLINE ? 'urgent'
    : status.state === SYNC_STATES.RECONNECTING ? 'attention' : 'refreshing';
  $('boardOrb')?.setAttribute('data-state', orbState);
  const badge = $('boardStatus');
  if (badge) badge.setAttribute('data-state', orbState);
  const text = $('boardStatusLabel');
  if (text && text.textContent !== label) text.textContent = label;
  const asOf = $('boardAsOf');
  if (asOf) {
    asOf.textContent = [HEALTH.FAILED,HEALTH.RENDER_FAILED].includes(status.board_health) || !status.online ? 'Unavailable' : status.last_read_at
      ? `Updated ${new Date(status.last_read_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',hour12:true})}`
      : [SYNC_STATES.STARTING, SYNC_STATES.SYNCING].includes(status.state) ? 'Updating…' : 'Unavailable';
  }
}

function renderPendingWrites() {
  const node = $('pendingWrites');
  if (!node) return;
  const pending = unresolvedFieldWrites(state.fieldWrites);
  node.hidden = pending.length === 0;
  if (!pending.length) { node.innerHTML = ''; return; }
  node.innerHTML = `<b>Unconfirmed changes · ${pending.length}</b>`
    + pending.map((entry) => {
      const name = state.deals.get(entry.deal)?.name || 'a record this board is not showing right now';
      return `<span>${esc(fieldLabel(entry.field))} on ${esc(name)} — not confirmed
        <button class="btn btn-quiet" type="button" data-retry-write="${esc(entry.cell)}">Send again</button></span>`;
    }).join('');
}

function renderReceipts() {
  const list = $('receiptsList');
  if (!list) return;
  const views = state.feed.caught_up
    ? receiptViews(state.receipts, { selfActor: state.selfActor, undo: state.undo, now: Date.now() })
    : [];
  const count = $('receiptsCount');
  if (count) count.textContent = String(views.length);
  const signature = receiptsSignature(views);
  if (signature === state.receiptSignature) return;
  state.receiptSignature = signature;
  list.innerHTML = views.length ? receiptListHtml(views.map(view => ({...view, can_undo:false})))
    : '<li class="receipt"><p class="receipt-line">Nothing has changed in this session yet.</p></li>';
}


function noteCellBase(cell, event) {
  if (!event?.id) return;
  const seen = { id: event.id, recorded_at: event.recorded_at ?? null };
  state.fieldBase.set(cell, nextCellBase(state.fieldBase.get(cell) || null, seen));
}

function applyBoardSnapshot(board) {
  const previousPanelRow = state.deals.get(state.panelDeal);
  const previousActor = state.selfActor;
  state.selfActor = board.actor || state.client.selfActor || state.selfActor;
  const actorChanged = previousActor && previousActor !== state.selfActor;
  bindDraftActor(state.selfActor);
  if (actorChanged) {
    pageDocContext?.clear();
    const contextRead = pageDocContext?.begin('getBoard');
    pageDocContext?.finish(contextRead, board);
    ++panelReadSequence; ++contextReadSequence;
    state.panelDetail = null;
    disposeEvidence?.(); disposeEvidence = null;
    $('contextDrawer').close(); $('contextDrawerBody').replaceChildren();
    $('panelTitle').textContent = 'Deal';
    $('panelBody').innerHTML = '<p>Updating…</p>';
  }
  if (state.personalScope && ['joe','dell'].includes(state.selfActor)) state.filter = state.selfActor;
  state.lostDeals = Array.isArray(board.lost_deals) ? board.lost_deals : null;
  state.closedDeals = Array.isArray(board.closed_deals) ? board.closed_deals : null;
  state.deals = new Map((board.deals || []).map((deal) => [deal.id, deal]));
  for (const deal of state.deals.values()) {
    for (const [field, seen] of Object.entries(deal.field_base || {})) {
      noteCellBase(cellKey(deal.id, field), seen);
    }
  }
  renderChips();
  renderBoard();
  if (actorChanged && state.panelDeal) {
    void refreshPanel();
    return;
  }
  syncUpdateForm();
  if (!previousPanelRow && state.panelDetail && state.deals.has(state.panelDeal)) {
    const template = document.createElement('div'); template.innerHTML = detailHtml(state.panelDetail);
    for (const section of ['board-controls', 'prospect']) {
      const selector = `[data-detail-read="${section}"]`;
      $('panelBody').querySelector(selector)?.replaceWith(template.querySelector(selector));
    }
  }
  if (state.panelDeal && $('recordPanel')?.open && previousPanelRow
    && JSON.stringify(previousPanelRow) !== JSON.stringify(state.deals.get(state.panelDeal))) void refreshPanel({changed:true});
}

async function loadBoard() {
  const outcome = await state.boardSync.refreshBoard({ reason: 'load-board' });
  if (!outcome.applied && state.boardSync.status().snapshots === 0) {
    say('The board could not be read. Nothing here has been inferred, and no record is shown.');
    return;
  }
  await pollOnce(true);
}

async function pollOnce(initial = false) {
  const outcome = await state.boardSync.pollChanges();
  if (!outcome.applied) return;
  const result = outcome.changes;
  state.presence = result.presence || [];
  const capture = (result.capture_sessions || []).find(session => !['done','completed','failed','cancelled'].includes(session.state));
  $('captureStatus').hidden = !capture;
  if (capture) $('captureStatus').textContent = `Capture: ${String(capture.state).replaceAll('_',' ')}`;
  const batch = result.events || [];
  state.feed = observeChangeBatch(state.feed, batch);
  for (const event of batch) {
    if (event.field) noteCellBase(cellKey(event.subject_id, event.field), event);
    if (!initial && state.feed.caught_up && event.actor !== state.selfActor && event.field === 'phase') {
      const deal = state.deals.get(event.subject_id);
      if (deal) showToast(`${actorName(event.actor)} moved ${dealTitle(deal)}`);
    }
  }
  if (state.feed.caught_up && batchTouchesBoard(batch)) state.boardSync.requestRefresh('change-feed');
  if (!initial && state.feed.caught_up && batch.some(event => event.subject_id === state.panelDeal)) void refreshPanel({changed:true});
  state.receipts = ingestChangeEvents(state.receipts, batch, {
    dealName: (dealId) => (state.deals.has(dealId) ? dealTitle(state.deals.get(dealId)) : null),
    actorLabel: actorName,
  });
  renderReceipts();
  if (!document.querySelector('dialog[open]')) renderBoard();
}


function confirmLocalWrite(dealId, patch) {
  const deal = state.deals.get(dealId) || null;
  if (deal) Object.assign(deal, patch);
  state.boardSync.noteLocalWrite(dealId, patch);
  state.boardSync.requestRefresh('after-write');
  return deal;
}

async function sendPhaseWrite(dealId, value, extra = null) { return sendFieldWrite(dealId, 'phase', value, extra); }
async function sendFieldWrite(dealId, field, value, extra = null) {
  const cell = cellKey(dealId, field);
  const result = await performFieldWrite({
    deal: dealId,
    field,
    value,
    extra,
    base: state.fieldBase.get(cell)?.id || null,
    baseNow: () => state.fieldBase.get(cell)?.id || null,
    getState: () => state.fieldWrites,
    setState: (next) => { state.fieldWrites = next; },
    newKey: uuidv4,
    patch: (request) => state.client.patchDealField(request),
  });
  if (result.status === 'ok' && !result.superseded && result.event_id) {
    noteCellBase(cell, { id: result.event_id, recorded_at: result.event_recorded_at });
  }
  return result;
}

const FOLLOW_UP_SENDERS = {
  'resolve-conflict': request => state.client.resolveConflict(request),
  'add-deal-note': (request) => state.client.addDealNote(request),
  'set-next-step': (request) => state.client.setNextStep(request),
  'add-critical-date': (request) => state.client.addCriticalDate(request),
  'update-deal': (request) => state.client.updateDeal(request),
};
const nextStepKey = deal => `next-step:${deal}`;

async function runOutcomeWrite(operationKey, step, intent) {
  operations.set(operationKey, { kind: 'outcome-read', step, intent, summary: step.summary });
  dock.record(operationKey, { summary: step.summary, status: 'sending', undo: false });

  let version = null;
  try {
    const fresh = await state.client.getDeal(intent.deal);
    version = fresh?.deal?.version ?? null;
  } catch {
    version = null;
  }
  if (!Number.isInteger(version)) {
    dock.record(operationKey, {
      summary: step.summary, status: 'failed', retry: true, undo: false,
      reason: `${intent.name} moved, but the record could not be re-read for its version, so the outcome was not written. Nothing was guessed.`,
    });
    return null;
  }

  const args = { ...step.args, base_version: version };
  const send = (request) => state.client.updateDeal(request);
  operations.set(operationKey, { kind: 'command', verb: step.verb, args, send, summary: step.summary });
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  dock.record(operationKey, {
    summary: step.summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.status === 'ok') state.boardSync.requestRefresh('after-write');
  return result;
}

/** One follow-up, its own key, its own receipt. A failure never un-moves a card. */
async function runFollowUp(operationKey, step) {
  const isUpdate = step.verb === 'add-deal-note' && operationKey.startsWith('deal-update:');
  if (isUpdate && operationKey !== updateKey(step.args.deal)) return {status:'blocked'};
  if (step.verb === 'set-next-step') operationKey = nextStepKey(step.args.deal);
  const send = FOLLOW_UP_SENDERS[step.verb];
  if (!send) return null;
  const pending = pendingCommand(commandState, operationKey);
  let args = step.args;
  if (step.verb === 'set-next-step') {
    if (pending) args = { ...args, base_version: pending.request.base_version };
    else {
      operations.set(operationKey, { kind: 'follow-up-read', step, summary: step.summary });
      let current;
      try { current = (await state.client.getDeal(args.deal))?.deal; }
      catch { /* A missing current version cannot authorize a replacement. */ }
      if (current?.id !== args.deal || !Number.isSafeInteger(current.version) || current.version < 1) {
        dock.record(operationKey, { summary: step.summary, status: 'failed', retry: true, undo: false,
          reason: 'The move was recorded, but the next step was not sent. Retry reading the current record before saving it.' });
        return null;
      }
      const reviewed = step.reviewed || state.deals.get(args.deal);
      if (!reviewed || noteText(reviewed.next_step) !== noteText(current.next_step) || (reviewed.next_date || null) !== (current.next_date || null)) {
        dock.record(operationKey, { summary: step.summary, status: 'conflict', retry: false, undo: false,
          reason: `The next step changed. Current: ${noteText(current.next_step) || 'None'} (${current.next_date || 'no date'}). Review the current record before replacing it.` });
        return null;
      }
      args = { ...args, base_version: current.version };
    }
  }
  if (!pending) operations.set(operationKey, { kind: 'command', verb: step.verb, args, send, summary: step.summary });
  dock.record(operationKey, { summary: step.summary, status: 'sending', undo: false });
  const updateActor = isUpdate ? state.selfActor : null;
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  if (updateActor !== null && updateActor !== state.selfActor) return result;
  dock.record(operationKey, {
    summary: operations.get(operationKey).summary,
    status: result.status === 'blocked' ? 'unknown' : result.status,
    reason: result.message || null,
    retry: result.status === 'blocked' || result.retry, undo: false, request: result.request,
  });
  if (isUpdate && result.status === 'ok') discardUpdate(args.deal);
  if (step.verb === 'add-deal-note' && operationKey === updateKey(state.panelDeal) && state.panelDetail) {
    if ([401,403].includes(result.http_status)) { refusePanelDetail({status:result.http_status}); return result; }
    syncUpdateForm();
    if (result.status === 'ok') await refreshPanel();
  }
  if (step.verb === 'resolve-conflict') await settleConflictChoice(step.args.conflict_id, result);
  return result;
}

async function runMove(intent, form) {
  const plan = completionPlan(intent, form);
  if (plan.errors.length) return { ok: false, errors: plan.errors };

  const [phaseStep, ...followUps] = plan.steps;
  for (const step of followUps) if (step.verb === 'set-next-step') {
    const reviewed = state.deals.get(intent.deal);
    step.reviewed = { next_step: reviewed?.next_step, next_date: reviewed?.next_date };
  }
  const cell = cellKey(intent.deal, 'phase');
  if (!pendingCommand(state.fieldWrites, cell)) {
    operations.set(cell, { kind: 'field', deal: intent.deal, value: phaseStep.args.value,
      summary: moveSummary(intent), intent: { ...intent }, followUps, followUpToken: uuidv4(), followUpsStarted: false });
  }
  dock.record(cell, { summary: moveSummary(intent), status: 'sending', undo: false });
  renderBoard();

  const phaseExtra = {};
  if (phaseStep.args.change_reason) phaseExtra.change_reason = phaseStep.args.change_reason;
  if (phaseStep.args.human_quote) phaseExtra.human_quote = phaseStep.args.human_quote;

  const result = await sendPhaseWrite(intent.deal, phaseStep.args.value, Object.keys(phaseExtra).length ? phaseExtra : null);
  dock.record(cell, {
    summary: moveSummary(intent), status: result.status,
    reason: fieldWriteMessage(result, `${fieldLabel('phase')} on ${intent.name}`) || null,
    retry: result.retry, undo: false, request: result.request,
  });

  if (result.status === 'conflict') {
    renderBoard();
    showConflict(result.conflict);
    return { ok: false, errors: [] };
  }
  if (result.status !== 'ok') {
    renderBoard();
    const message = fieldWriteMessage(result, `${fieldLabel('phase')} on ${intent.name}`);
    if (message) { showToast(message, {error:true}); say(message); }
    return { ok: false, errors: [] };
  }
  if (result.superseded) {
    state.boardSync.requestRefresh('after-write');
    renderBoard();
    const message = fieldWriteMessage(result, `${fieldLabel('phase')} on ${intent.name}`);
    if (message) showToast(message);
  } else {
    confirmLocalWrite(intent.deal, { phase: phaseStep.args.value });
    renderBoard();
    showToast(`${intent.name} moved to ${intent.to_label}`, {eventId: result.event_id});
  }
  announce(`${intent.name} moved to ${intent.to_label}.`);

  if (!result.superseded) await resumeMoveFollowUps(cell);
  return { ok: true, errors: [] };
}

async function resumeMoveFollowUps(cell) {
  const move = operations.get(cell);
  if (!move?.followUps || move.followUpsStarted) return;
  move.followUpsStarted = true;
  for (const step of move.followUps) {
    const operationKey = `${step.verb}:${move.intent.deal}:${move.followUpToken}`;
    if (step.verb === 'update-deal') await runOutcomeWrite(operationKey, step, move.intent);
    else await runFollowUp(operationKey, step);
  }
}

async function retryFieldWrite(cell) {
  const entry = pendingCommand(state.fieldWrites, cell);
  if (!entry) { renderBoard(); return; }
  const { deal, field, value } = entry.request;
  const row = state.deals.get(deal);
  const result = await sendFieldWrite(deal, field, value);
  const subject = `${fieldLabel(field)} on ${row?.name || 'this deal'}`;
  dock.record(cell, {
    summary: `${row?.name || 'Deal'} · ${fieldLabel(field)}`,
    status: result.status, reason: fieldWriteMessage(result, subject) || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.status === 'ok' && !result.superseded) {
    confirmLocalWrite(deal, fieldPatch(field, value));
    if (field === 'phase') await resumeMoveFollowUps(cell);
    await refreshPanel();
  }
  renderBoard();
  const message = fieldWriteMessage(result, subject);
  if (message) showToast(message, {error:result.status !== 'ok'});
}

async function runUndo(eventId) {
  const result = await performUndo({
    eventId,
    getState: () => state.undo,
    setState: (next) => { state.undo = next; renderReceipts(); },
    newKey: uuidv4,
    revert: (request) => state.client.revertDealField(request),
  });
  if (!result.started) return;
  if (result.outcome.status === 'succeeded') {
    state.boardSync.requestRefresh('after-undo');
    await refreshPanel();
    showToast('Change undone');
    return;
  }
  showToast(result.outcome.message, {error:true});
}


function openCompletion(intent) {
  state.intent = intent;
  const dialog = $('completionDialog');
  if (!dialog) return;
  $('completionTitle').textContent = moveTitle(intent);

  const isClosed = intent.to === CLOSED_SLUG;
  const closed = $('completionClosedNote');
  if (closed) {
    closed.hidden = !isClosed;
    closed.textContent = closedColumnCaption();
  }
  const outcomeField = $('completionOutcomeField');
  if (outcomeField) outcomeField.hidden = !isClosed;
  for (const radio of outcomeRadios()) radio.checked = false;
  const closedOn = $('completionClosedOn');
  if (closedOn) closedOn.value = isClosed ? todayIso() : '';
  const wonValue = $('completionWonValue');
  if (wonValue) wonValue.value = '';
  renderOutcomeState();
  const confirm = $('completionConfirm');
  if (confirm) confirm.textContent = `Move to ${intent.to_label}`;
  $('completionEvidence').value = '';
  $('completionReason').value = '';
  $('completionQuote').value = '';
  $('completionNextStep').value = '';
  $('completionNextWhen').value = '';
  $('completionDate').value = '';
  $('completionCritical').checked = false;
  $('completionSource').value = '';
  const errors = $('completionErrors');
  if (errors) { errors.hidden = true; errors.textContent = ''; }
  renderCriticalState();
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  $('completionEvidence')?.focus();
}

const outcomeRadios = () => [...document.querySelectorAll('input[name="completionOutcome"]')];
const chosenOutcome = () => outcomeRadios().find((radio) => radio.checked)?.value || '';
/** Today as the calendar's own YYYY-MM-DD, in the reader's timezone, not UTC. */
function todayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function renderOutcomeState() {
  const field = $('completionWonValueField');
  if (field) field.hidden = chosenOutcome() !== 'won';
}

function renderCriticalState() {
  const on = $('completionCritical')?.checked === true;
  const source = $('completionSourceField');
  if (source) source.hidden = !on;
  const input = $('completionSource');
  if (input) input.required = on;
  const caption = $('completionDateCaption');
  if (caption) caption.textContent = on ? COMPLETION_CAPTIONS.effective_on : COMPLETION_CAPTIONS.effective_off;
}

function closeCompletion({ cancelled }) {
  const dialog = $('completionDialog');
  if (dialog?.open) dialog.close();
  const intent = state.intent;
  state.intent = null;
  state.lifted = null;
  state.target = null;
  renderBoard();
  if (cancelled && intent) announce(`Move cancelled. ${intent.name} stays in ${intent.from_label}.`);
  if (intent) {
    const returnTo = state.panelDeal === intent.deal && $('recordPanel')?.open
      ? $('detailPhase') : document.querySelector(`.kanban-card[data-id="${CSS.escape(intent.deal)}"]`);
    if (returnTo?.id === 'detailPhase') returnTo.value = columnByValue(state.deals.get(intent.deal)?.phase)?.slug || '';
    returnTo?.focus({ preventScroll: true });
  }
}

function showConflict(conflict) {
  const dialog = $('conflictDialog');
  if (!conflict || !dialog) return;
  const display = value => conflict.field === 'operating_state' && value && typeof value === 'object'
    ? [value.state, value.reason, value.note].filter(Boolean).join(' · ')
    : readableValue(conflict.field, value, {actorLabel:actorName});
  $('conflictTitle').textContent = `Choose the value for ${fieldLabel(conflict.field)}`;
  $('conflictChoices').innerHTML = ['a', 'b'].map((side) => `<label class="field">
    <input type="radio" name="winner" value="${side}"${side === 'a' ? ' checked' : ''}>
    <span>${esc(actorName(conflict[side].actor))}: ${esc(display(conflict[side].value))}${conflict[side].recorded_at ? ` · ${esc(dateWords(conflict[side].recorded_at))}` : ''}</span></label>`).join('');
  dialog.dataset.conflict = conflict.conflict_id;
  if (!$('conflictStatus')) { const status = document.createElement('p'); status.id = 'conflictStatus'; status.setAttribute('role','status'); $('conflictChoices').after(status); }
  syncConflictForm();
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

function syncConflictForm() {
  const dialog = $('conflictDialog');
  const pending = pendingCommand(commandState, `resolve-conflict:${dialog.dataset.conflict}`);
  dialog.querySelectorAll('input[name="winner"]').forEach(input => {
    input.disabled = Boolean(pending);
    if (pending) input.checked = input.value === pending.request.winner;
  });
  const button = dialog.querySelector('button[type="submit"]');
  button.disabled = pending?.status === 'pending';
  button.textContent = pending ? 'Check outcome' : 'Keep selected value';
  $('conflictStatus').textContent = pending?.message || '';
}
async function resolveConflictChoice() {
  const dialog = $('conflictDialog');
  const conflictId = dialog?.dataset.conflict;
  if (!conflictId) return;
  const key = `resolve-conflict:${conflictId}`;
  const pending = pendingCommand(commandState, key);
  const winner = pending?.request.winner || dialog.querySelector('input[name="winner"]:checked')?.value;
  if (!winner) return;
  const promise = runFollowUp(key, {verb:'resolve-conflict',args:{conflict_id:conflictId,winner},summary:'Conflict resolution'});
  syncConflictForm();
  await promise;
}
async function settleConflictChoice(conflictId, result) {
  const dialog = $('conflictDialog');
  if (dialog.dataset.conflict !== conflictId) return;
  syncConflictForm();
  if (result.status === 'ok') {
    dialog.close();
    state.boardSync.requestRefresh('after-conflict');
    await refreshPanel();
    showToast('Conflict resolved with both values kept in history');
  } else $('conflictStatus').textContent = result.message || 'Resolution not confirmed';
}


let disposeEvidence = null;
let panelReadSequence = 0;
let contextReadSequence = 0;
let panelRead = null;
let updateDraft = null;
const updateDrafts = new Map();
const requirementDrafts = new Map();
const requirementFields = [['use','Use'],['size','Size'],['location','Location'],['timing','Timing'],['budget','Budget'],['requirements','Approved requirements']];
let draftActor = null;
function bindDraftActor(actor) {
  if (draftActor === actor) return;
  draftActor = actor;
  updateDrafts.clear();
  requirementDrafts.clear();
  updateDraft = null;
  for (const key of Object.keys(commandState)) {
    if (key.startsWith('deal-update:')) dock.forget(key);
  }
}
function updateKey(id) { return `deal-update:${state.selfActor}:${id}`; }
function discardUpdate(id) {
  updateDrafts.delete(id);
  if (updateDraft?.id === id) updateDraft = null;
}
function refusePanelDetail(error) {
  if (![401,403].includes(error?.status) && !['unauthorized','not_authenticated','forbidden'].includes(error?.payload?.error)) return false;
  ++panelReadSequence;
  ++contextReadSequence;
  state.panelDetail = null;
  bindDraftActor(null);
  disposeEvidence?.(); disposeEvidence = null;
  setContextOpenVisible(false);
  $('contextDrawer').close();
  $('contextDrawerBody').replaceChildren();
  $('panelTitle').textContent = 'Deal';
  $('panelBody').innerHTML = '<p role="status">Unavailable. Sign in to reload this record. <a href="/auth/login">Sign in</a> <button class="btn" type="button" data-refresh-detail>Retry</button></p>';
  return true;
}
function syncUpdateForm() {
  const form = $('detailUpdateForm');
  if (!form || !state.panelDeal) return;
  const pending = pendingCommand(commandState, updateKey(state.panelDeal));
  bindDraftActor(state.selfActor);
  const requirementFieldset = $('requirementEmailForm')?.querySelector('fieldset');
  if (requirementFieldset) requirementFieldset.disabled = !state.selfActor;
  if (!updateDraft || updateDraft.id !== state.panelDeal) {
    updateDraft = updateDrafts.get(state.panelDeal) || {id:state.panelDeal,text:''};
    updateDrafts.set(state.panelDeal, updateDraft);
  }
  form.elements.text.value = pending ? pending.request.text : updateDraft.text;
  form.elements.text.disabled = Boolean(pending) || !state.selfActor;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = pending?.status === 'pending' || !state.selfActor;
  button.textContent = pending ? 'Check outcome' : 'Add update';
  form.querySelector('[data-discard-update]').disabled = Boolean(pending) || !updateDraft.text;
  if (!pending) $('detailUpdateStatus').textContent = updateDraft.text ? 'Unsent draft · kept while this page is open' : '';
  if (pending) $('detailUpdateStatus').textContent = pending.message || 'Saving update…';
}
function validateDetail(detail, id) {
  if (!detail?.deal || detail.deal.id !== id || typeof detail.deal.name !== 'string') throw new Error('Invalid detail');
  for (const field of ['activities','thread','next_actions','critical_dates','participants','premises','negotiation_rounds','documents','history']) {
    if (detail[field] !== undefined && (!Array.isArray(detail[field]) || detail[field].some(row => !row || typeof row !== 'object'))) throw new Error('Invalid detail section');
  }
  return detail;
}
function readDealDetail(id) {
  return readWithDeadline(signal => state.client.getDeal(id, { signal })).then(detail => validateDetail(detail, id));
}
async function saveUpdate(id) {
  const key = updateKey(id);
  const pending = pendingCommand(commandState, key);
  if (pending?.status === 'pending' || !state.selfActor || draftActor !== state.selfActor) return;
  const form = $('detailUpdateForm');
  const text = form?.elements.text.value.trim();
  if (!pending && !text) { $('detailUpdateStatus').textContent = 'Enter an update'; return; }
  const args = pending?.request || {deal:id,text};
  const promise = runFollowUp(key,{verb:'add-deal-note',args,summary:'Deal update'});
  syncUpdateForm();
  const result = await promise;
  state.boardSync.requestRefresh('deal-update');
  if (state.panelDeal === id && form?.isConnected) {
    syncUpdateForm();
    $('detailUpdateStatus').textContent = result.status === 'ok' ? 'Update added' : result.message || 'Update not confirmed';
  }
}
function requirementEmailHtml(deal) {
  const draft = requirementDrafts.get(deal.id) || {};
  return `<details id="requirementEmail"><summary>Draft requirement email</summary>
    <p>Unsent draft · kept while this page is open.</p>
    <p>Enter only requirements approved for sharing. Client details are never added automatically.</p>
    <form id="requirementEmailForm" class="deal-update-form"><fieldset class="add-deal-fields"${state.selfActor ? '' : ' disabled'}>
      ${requirementFields.map(([name,label]) => `<div class="field"><label for="requirement-${name}">${label}</label>${name === 'requirements' ? `<textarea id="requirement-${name}" name="${name}" rows="3" maxlength="2000">${esc(draft[name] || '')}</textarea>` : `<input id="requirement-${name}" name="${name}" maxlength="2000" value="${esc(draft[name] || '')}"${['use','location'].includes(name) ? ' required' : ''}>`}</div>`).join('')}
      <button class="btn" type="button" data-generate-requirement>Generate email preview</button>
      <div class="field"><label for="requirementSubject">Email subject</label><input id="requirementSubject" name="subject" maxlength="500" value="${esc(draft.subject || '')}"></div>
      <div class="field"><label for="requirementMessage">Email message</label><textarea id="requirementMessage" name="message" rows="10" maxlength="15000">${esc(draft.message || '')}</textarea></div>
      <button class="btn" type="button" data-copy-requirement>Copy email draft</button>
      <button class="btn btn-quiet" type="button" data-discard-requirement>Discard email draft</button>
      <p id="requirementEmailStatus" role="status">Preview and copy only. Nothing is sent.</p>
    </fieldset></form></details>`;
}
async function copyRequirementDraft() {
  const form = $('requirementEmailForm');
  const status = $('requirementEmailStatus');
  const actor = state.selfActor;
  const id = state.panelDeal;
  const draft = requirementDrafts.get(id);
  if (!form || !actor || draftActor !== actor) return;
  const subject = form.elements.subject.value.trim();
  const message = form.elements.message.value.trim();
  if (!subject || !message) { status.textContent = 'Generate or enter a subject and message first.'; return; }
  try {
    await navigator.clipboard.writeText(`Subject: ${subject}\n\n${message}`);
    if (form.isConnected && state.selfActor === actor && draftActor === actor && requirementDrafts.get(id) === draft) status.textContent = 'Email draft copied. Nothing sent.';
  } catch {
    if (!form.isConnected || state.selfActor !== actor || draftActor !== actor || requirementDrafts.get(id) !== draft) return;
    status.textContent = 'Copy unavailable. Select the subject and message to copy manually.';
    form.elements.message.focus(); form.elements.message.select();
  }
}
function detailHtml(detail) {
  const d = detail.deal;
  const prospect = state.deals.get(d.id);
  const pendingProspect = engagementWriterFor(state.client).get(prospect?.client_id, state.selfActor);
  const nextStep = noteText(d.next_step).trim();
  const parked = d.operating_state === 'parked';
  const controlsAvailable = state.deals.has(d.id) && !isClosedDeal(d);
  return `<div class="deal-freshness"><time id="detailUpdated" title="Last updated"></time><button class="btn icon-btn" type="button" data-refresh-detail aria-label="Refresh deal" title="Refresh">↻</button></div><p id="detailReadStatus" role="status"></p>
    <section class="deal-opening-snapshot" data-detail-read="snapshot" aria-label="Deal snapshot">
      ${nextStep ? `<p class="deal-current-action"><span>${d.next_date && d.next_date < todayIso() ? 'Overdue action' : 'Next action'}</span><strong>${esc(nextStep)}</strong>${d.next_date ? `<span>Due <time datetime="${esc(d.next_date)}">${esc(dateWords(d.next_date))}</time></span>` : ''}</p>` : ''}
      <dl class="deal-snapshot-facts">${d.workspace_kind === 'national_account' || d.account_client_id ? `<div><dt>Market agent</dt><dd>${esc(d.market_agent || 'Unassigned')}</dd></div>` : ''}${d.client_name ? `<div><dt>Client</dt><dd>${esc(d.client_name)}</dd></div>` : ''}${d.type ? `<div><dt>Type</dt><dd>${esc(d.type)}</dd></div>` : ''}${d.outcome ? `<div><dt>Outcome</dt><dd>${esc(d.outcome[0].toUpperCase()+d.outcome.slice(1))}</dd></div>` : ''}</dl>
    </section>
    <div data-detail-read="checklist">${renderDealChecklist(detail.checklist)}</div>
    <form id="detailUpdateForm" class="deal-update-form"><label for="dealUpdate">Update</label><textarea id="dealUpdate" name="text" rows="2" maxlength="10000" required></textarea><button class="btn btn-primary" type="submit">Add update</button><button class="btn btn-quiet" type="button" data-discard-update>Discard draft</button><p id="detailUpdateStatus" role="status"></p></form>
    ${requirementEmailHtml(d)}
    <div data-detail-read="vendors">${renderDealVendors(d.vendors)}</div>
    <div data-detail-read="board-controls" data-available="${controlsAvailable}">${controlsAvailable ? `<div class="detail-actions"><div class="detail-controls"><label>Phase<select id="detailPhase">${COLUMNS.map(c => `<option value="${esc(c.slug)}"${c.value === d.phase ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label><label>Owner<select id="detailOwner"><option value="">Unassigned</option>${['joe','dell'].map(owner => `<option value="${owner}"${owner === d.owner ? ' selected' : ''}>${actorName(owner)}</option>`).join('')}</select></label></div><div data-detail-read="parking" data-parked="${parked}">${parked ? `<p>${esc(concise(d.parking_note) || 'Parked')}</p><button type="button" class="btn" data-revive="${esc(d.id)}">Revive</button>` : `<details class="park-options"><summary class="park-control">Park</summary><form id="detailParkForm"><label>Park reason<input name="reason" maxlength="500" required></label><button class="btn park-control" type="submit">Park deal</button></form></details>`}</div></div>` : ''}</div>
    <div data-detail-read="prospect">${controlsAvailable && prospect?.client_status === 'prospect' ? `<form id="detailInactiveForm"><p>Inactive prospects return to Leads.</p><label>Reason<input name="reason" maxlength="1000" required value="${esc(pendingProspect?.request.reason || '')}"${pendingProspect ? ' readonly' : ''}></label><button class="btn" type="submit">${pendingProspect ? 'Check outcome' : 'Mark inactive'}</button><p role="status" data-prospect-status>${pendingProspect ? 'Confirmation pending for this prospect. Check outcome to retry the same request.' : ''}</p></form>` : ''}</div>
    ${renderDealTimeline(detail)}<div data-detail-read="updates">${renderDealUpdates(detail)}</div>
    <details id="panelEvidenceSection"><summary>Evidence</summary><div id="panelEvidence"></div></details>`;
}
function refreshPanel({ changed = false } = {}) {
  const id = state.panelDeal;
  if (!id) return Promise.resolve();
  if (panelRead?.id === id && panelRead.sequence === panelReadSequence) {
    if (changed) panelRead.again = true;
    return panelRead.promise;
  }
  const reading = readPanel(id);
  const current = { id, sequence: panelReadSequence, again: false, promise: null };
  panelRead = current;
  current.promise = reading.then(() => {
    if (panelRead === current) panelRead = null;
    if (current.again && state.panelDeal === id && current.sequence === panelReadSequence) return refreshPanel();
  });
  return current.promise;
}
async function readPanel(id) {
  const seq = ++panelReadSequence;
  try {
    const detail = await readDealDetail(id);
    if (state.panelDeal !== id || seq !== panelReadSequence || panelRead?.again) return;
    state.panelDetail = detail;
    const contextRead = pageDocContext?.begin('getDeal', [id]);
    pageDocContext?.finish(contextRead, detail);
    selectDocRecord('deal', id);
    updateDetailTimestamp();
    if (!$('panelBody').querySelector('.deal-opening-snapshot')) paintPanel(detail);
    else {
      if ($('detailPhase') && document.activeElement !== $('detailPhase')) $('detailPhase').value = columnByValue(detail.deal.phase)?.slug || '';
      if ($('detailOwner') && document.activeElement !== $('detailOwner')) $('detailOwner').value = detail.deal.owner || '';
      syncUpdateForm();
      $('detailReadStatus').textContent = '';
      $('panelTitle').textContent = dealTitle(detail.deal);
      const template = document.createElement('div'); template.innerHTML = detailHtml(detail);
      for (const fresh of template.querySelectorAll('[data-detail-read]')) {
        const current = $('panelBody').querySelector(`[data-detail-read="${fresh.dataset.detailRead}"]`);
        if (!current) continue;
        if (fresh.dataset.detailRead === 'board-controls' && current.dataset.available === fresh.dataset.available) continue;
        if (fresh.dataset.detailRead === 'parking' && current.dataset.parked === 'false' && fresh.dataset.parked === 'false') continue;
        if (current.innerHTML !== fresh.innerHTML) {
          const expanded = new Set([...current.querySelectorAll('.deal-note details[open]')].map(n => n.closest('.deal-note').dataset.id));
          const focused = current.contains(document.activeElement) ? document.activeElement : null;
          const focusIdentity = focused?.dataset.detailFocus;
          const wasOpen = current.open || current.querySelector('.deal-checklist')?.open;
          const checklistOpens = new Set([...current.querySelectorAll('[data-checklist-item] details[open]')].map(n => n.closest('[data-checklist-item]').dataset.checklistItem));
          const historyOpen = current.querySelector('.updates-history')?.open;
          const oldScroll = current.scrollLeft;
          current.replaceWith(fresh);
          fresh.scrollLeft = oldScroll;
          if (wasOpen) {
            const disclosure = fresh.querySelector('.deal-checklist') || fresh;
            disclosure.open = true;
          }
          fresh.querySelectorAll('[data-checklist-item]').forEach(n => { if (checklistOpens.has(n.dataset.checklistItem)) n.querySelector('details').open = true; });
          if (historyOpen && fresh.querySelector('.updates-history')) fresh.querySelector('.updates-history').open = true;
          fresh.querySelectorAll('.deal-note').forEach(n => { if (expanded.has(n.dataset.id)) n.querySelector('details').open = true; });
          if (focusIdentity) [...fresh.querySelectorAll('[data-detail-focus]')].find(n => n.dataset.detailFocus === focusIdentity)?.focus({preventScroll:true});
          else if (focused?.id) document.getElementById(focused.id)?.focus({preventScroll:true});
        }
      }
      if ($('panelEvidenceSection')?.open) await refreshEvidence(detail, id, seq);
    }
    if (state.panelDeal === id && seq === panelReadSequence) setContextOpenVisible(true);
  } catch (error) {
    if (state.panelDeal !== id || seq !== panelReadSequence) return;
    if (refusePanelDetail(error)) return;
    setContextOpenVisible(false);
    const message = 'Updates temporarily unavailable';
    const status = $('detailReadStatus');
    if (status) status.textContent = message;
    else $('panelBody').innerHTML = `<p role="status">${message}</p>`;
  }
}
function updateDetailTimestamp() {
  const at = new Date().toISOString();
  $('recordPanel').dataset.updated = at;
  const time = $('detailUpdated');
  if (time) { time.dateTime = at; time.textContent = new Date(at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',hour12:true}); }
}
async function refreshEvidence(detail, id, seq) {
  const evidence = await loadEvidence(state.client, detail);
  if (state.panelDeal !== id || seq !== panelReadSequence) return;
  if (evidence.threads.state === 'refused') { refusePanelDetail({status:evidence.threads.status}); return; }
  if (!$('panelEvidenceSection')?.open) return;
  const root = $('panelEvidence');
  const template = document.createElement('div'); template.innerHTML = renderEvidence(evidence);
  if (disposeEvidence && root.innerHTML === template.innerHTML) return;
  const expanded = new Set([...root.querySelectorAll('details[open]')].map(n => n.querySelector('summary')?.textContent));
  disposeEvidence?.();
  disposeEvidence = mountEvidence(root, {client:state.client,detail,onDenied:refusePanelDetail,initialView:evidence});
  root.querySelectorAll('details').forEach(n => { if (expanded.has(n.querySelector('summary')?.textContent)) n.open = true; });
}
function paintPanel(detail) {
  $('panelTitle').textContent = dealTitle(detail.deal);
  $('panelBody').innerHTML = detailHtml(detail);
  disposeEvidence?.(); disposeEvidence = null;
  syncUpdateForm();
  updateDetailTimestamp();
}
async function openPanel(dealId, trigger, { fromHistory = false } = {}) {
  selectDocRecord('deal', dealId);
  const panel = $('recordPanel');
  disposeEvidence?.(); disposeEvidence = null;
  setContextOpenVisible(false);
  state.panelDeal = dealId; state.panelDetail = null; updateDraft = null;
  const url = new URL(location.href);
  if (!fromHistory && url.searchParams.get('deal') !== dealId) {
    url.searchParams.set('deal',dealId);
    history.pushState({doctorcreDealPanel:true},'',url);
  }
  state.panelReturnTo = trigger?.closest('.kanban-card')?.dataset.id || dealId;
  $('panelTitle').textContent = state.deals.get(dealId)?.name || 'Deal';
  $('panelBody').innerHTML = '<p>Updating…</p>';
  if (!panel.open) panel.showModal();
  await refreshPanel();
}
function closePanel({ fromHistory = false } = {}) {
  if (!fromHistory && history.state?.doctorcreDealPanel) { history.back(); return; }
  selectDocRecord('deal', null);
  pageDocContext?.release('getDeal');
  ++panelReadSequence; ++contextReadSequence;
  $('contextDrawer').close(); $('contextDrawerBody').replaceChildren();
  const id = state.panelReturnTo;
  disposeEvidence?.(); disposeEvidence=null;
  if (!fromHistory) { const url = new URL(location.href); url.searchParams.delete('deal'); history.replaceState({},'',url); }
  $('recordPanel').close(); state.panelDeal = null; state.panelDetail = null;
  state.panelReturnTo = null;
  setContextOpenVisible(false);
  if (id) document.querySelector(`.kanban-card[data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});
}
function fieldPatch(field, value) {
  return field === 'operating_state' ? {operating_state:value.state, parking_note:value.note || null, parking_reason:value.reason || null} : {[field]:value};
}
async function setOperatingState(id, value) {
  const result = await sendFieldWrite(id, 'operating_state', value);
  if (result.status === 'ok' && !result.superseded) {
    const accepted = result.request.value;
    confirmLocalWrite(id, fieldPatch('operating_state', accepted));
    showToast(accepted.state === 'active' ? 'Deal revived' : 'Deal parked');
    if (state.panelDeal === id) closePanel();
  } else if (result.conflict) showConflict(result.conflict);
  else { showToast(fieldWriteMessage(result,'Operating state') || 'Change not confirmed', {error:true}); state.boardSync.requestRefresh('operating-state'); }
  renderPendingWrites();
}

async function markProspectInactive(form,id,reason) {
  const prospect = state.deals.get(id);
  if (!prospect || !reason) return;
  const engagement = engagementWriterFor(state.client);
  if (engagement.get(prospect.client_id, state.selfActor)?.sending) return;
  const status = engagement.get(prospect.client_id, state.selfActor)?.request.status || 'inactive';
  form.querySelector('button').disabled = true;
  try {
    await engagement({ client_id: prospect.client_id, base_version: prospect.client_version,
      status: 'inactive', reason, human_quote: reason, expected_actor: state.selfActor }, {
      readBack: async () => {
        const { deal } = await state.client.getDeal(id);
        return { client_id: deal.client_id, status: deal.prospect_engagement_status, version: deal.client_version };
      },
    });
    await state.boardSync.refreshBoard({reason:'prospect-inactive'});
    if (state.panelDeal === id) closePanel();
    showToast(status === 'inactive' ? 'Prospect returned to Leads' : 'Prospect returned to the deal board');
  } catch (error) {
    await state.boardSync.refreshBoard({reason:'prospect-check'});
    if (state.panelDeal === id) await refreshPanel();
    if (error.code !== 'unknown_outcome') showToast('Change unavailable. Refresh and try again.',{error:true});
  } finally {
    const pending = engagement.get(prospect.client_id, state.selfActor);
    const current = $('detailInactiveForm');
    if (current && state.panelDeal === id) {
      current.querySelector('button').disabled = false;
      current.querySelector('button').textContent = pending ? 'Check outcome' : 'Mark inactive';
      current.elements.reason.readOnly = Boolean(pending);
      if (pending) current.elements.reason.value = pending.request.reason;
      current.querySelector('[data-prospect-status]').textContent = pending ? 'Confirmation pending for this prospect. Check outcome to retry the same request.' : '';
    }
  }
}

function setContextOpenVisible(visible) {
  const wrap = $('panelContextOpenWrap');
  if (wrap) wrap.hidden = !visible;
}


async function openContextDrawer() {
  const dialog = $('contextDrawer');
  const detail = state.panelDetail;
  if (!dialog || !detail) return;
  const seq = ++contextReadSequence;
  $('contextDrawerBody').innerHTML = '<div class="state-block" data-state="loading"><h3>Updating…</h3></div>';
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  const dealId = state.panelDeal;
  let context;
  try { context = await loadDealContext(state.client, detail); }
  catch (error) { if (state.panelDeal === dealId && seq === contextReadSequence) refusePanelDetail(error); return; }
  if (state.panelDeal !== dealId || seq !== contextReadSequence || !dialog.open) return;
  const sections = contextDrawerSections(context, { dateLabel: dateWords });
  if (!sections.length) { $('contextDrawerBody').innerHTML = '<p>No linked context recorded.</p>'; return; }
  $('contextDrawerBody').innerHTML = sections
    .map((section) => `<div class="panel-section"${section.state ? ` data-state="${esc(section.state)}"` : ''}>
      <h3>${esc(section.title)}</h3>${section.state === 'unavailable' ? '<button type="button" data-context-retry>Retry</button>' : ''}${section.lines.map((line) => `<p>${esc(line)}</p>`).join('')}${(section.links || []).map(link=>`<p><a href="${esc(link.href)}">${esc(link.label)}</a></p>`).join('')}</div>`).join('');
}


function leasePhase(dealId) {
  state.client.presenceLease({ deal: dealId, field: 'phase', idempotency_key: uuidv4() })
    .catch(() => { /* a courtesy, never a requirement */ });
}

function beginMove(dealId, toSlug) {
  const deal = state.deals.get(dealId);
  const intent = moveIntent(deal, toSlug);
  state.lifted = null;
  state.target = null;
  if (!intent) { renderBoard(); return; }
  announce(`Reviewing ${intent.name} for ${intent.to_label}. Nothing has been saved yet.`);
  openCompletion(intent);
}


function wireBoard() {
  const board = $('kanban');
  if (!board) return;

  board.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.kanban-card')) board.dataset.pressed = 'true';
  });
  const release = () => {
    if (board.dataset.pressed !== 'true') return;
    delete board.dataset.pressed;
    if (state.paintDeferred) setTimeout(renderBoard);
  };
  addEventListener('pointerup', release, true);
  addEventListener('pointercancel', release, true);

  board.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.kanban-card');
    if (!card) return;
    card.dataset.dragging = 'true';
    event.dataTransfer.setData('text/plain', card.dataset.id);
    event.dataTransfer.effectAllowed = 'move';
    leasePhase(card.dataset.id);
  });
  board.addEventListener('dragend', () => {
    board.querySelectorAll('[data-dragging="true"]').forEach((card) => card.removeAttribute('data-dragging'));
    state.target = null;
    renderBoard();
  });
  board.addEventListener('dragover', (event) => {
    const column = event.target.closest('.kanban-column');
    if (!column) return;
    event.preventDefault();
    column.dataset.drop = 'true';
  });
  board.addEventListener('dragleave', (event) => {
    const column = event.target.closest('.kanban-column');
    if (column) column.removeAttribute('data-drop');
  });
  board.addEventListener('drop', (event) => {
    const column = event.target.closest('.kanban-column');
    if (!column) return;
    event.preventDefault();
    column.removeAttribute('data-drop');
    beginMove(event.dataTransfer.getData('text/plain'), column.dataset.column);
  });

  board.addEventListener('keydown', (event) => {
    const card = event.target.closest('.kanban-card');
    if (!card) return;
    if (event.target.closest('button')) return;
    if (state.view === 'list' || card.classList.contains('parked-card')) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(card.dataset.id, card); } return; }
    const id = card.dataset.id;
    const deal = state.deals.get(id);
    if (!deal) return;
    const here = columnByValue(deal.phase);

    if ((event.key === 'Enter' || event.key === ' ') && state.lifted !== id) {
      event.preventDefault();
      state.lifted = id;
      state.target = here ? here.slug : COLUMNS[0].slug;
      leasePhase(id);
      announce(`${dealTitle(deal)} lifted from ${columnLabel(deal.phase)}. Use the arrow keys to choose a column, Enter to drop, Escape to cancel.`);
      renderBoard();
      document.querySelector(`.kanban-card[data-id="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    if (state.lifted !== id) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      state.lifted = null;
      state.target = null;
      announce(`Move cancelled. ${dealTitle(deal)} stays in ${columnLabel(deal.phase)}.`);
      renderBoard();
      document.querySelector(`.kanban-card[data-id="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    const next = keyboardTarget(state.target, event.key, OPEN_COLUMNS);
    if (next) {
      event.preventDefault();
      state.target = next;
      announce(`${columnBySlug(next).label} selected. Enter drops ${dealTitle(deal)} here.`);
      renderBoard();
      document.querySelector(`.kanban-card[data-id="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      beginMove(id, state.target);
    }
  });
}


function wire() {
  wireBoard();

  $('boardChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('button[data-filter]');
    if (!chip) return;
    state.personalScope = false; state.filter = chip.dataset.filter;
    const url = new URL(location.href);
    if (state.filter === 'all') url.searchParams.delete('owner'); else url.searchParams.set('owner',state.filter);
    history.replaceState({},'',url);
    renderChips();
    renderBoard();
  });

  document.addEventListener('click', async (event) => {
    const revive = event.target.closest('button[data-revive]');
    if (revive) { setOperatingState(revive.dataset.revive, {state:'active'}); return; }
    const open = event.target.closest('button[data-open]');
    if (open) { openPanel(open.dataset.open, open); return; }
    const retry = event.target.closest('button[data-retry-write]');
    if (retry) { retryFieldWrite(retry.dataset.retryWrite); return; }
    const undo = event.target.closest('button[data-undo]');
    if (undo) { runUndo(undo.dataset.undo); return; }
    const openDeal = event.target.closest('button[data-open-deal]');
    const card = event.target.closest('.kanban-card');
    if (card && card.dataset.dragging !== 'true' && !event.target.closest('button,input,select,a')) { openPanel(card.dataset.id, card); return; }
    if (openDeal) {
      openPanel(openDeal.dataset.openDeal, null);
    }
  });

  $('addDealStage').innerHTML = OPEN_COLUMNS.map(c => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');
  $('addDealOpen').addEventListener('click', openAddDeal);
  $('addDealForm').addEventListener('submit', submitDeal);
  $('addDealCancel').addEventListener('click', () => $('addDealDialog').close());
  $('addDealDialog').addEventListener('cancel', event => { if (creatingDeal) event.preventDefault(); });
  $('addDealDialog').addEventListener('close', () => $('addDealOpen').focus());

  addEventListener('popstate', () => {
    const deal = new URL(location.href).searchParams.get('deal');
    if (deal) void openPanel(deal, null, {fromHistory:true});
    else closePanel({fromHistory:true});
  });
  $('recordPanel')?.addEventListener('cancel', (event) => { event.preventDefault(); closePanel(); });
  $('panelClose')?.addEventListener('click', closePanel);
  $('receiptsOpen')?.addEventListener('click', () => {
    renderReceipts();
    document.dispatchEvent(new Event('doctorcre:open-today'));
  });

  $('panelContextOpen')?.addEventListener('click', () => { openContextDrawer(); });
  $('contextDrawerBody')?.addEventListener('click', event => { if (event.target.closest('[data-context-retry]')) void openContextDrawer(); });
  $('contextDrawerClose')?.addEventListener('click', () => $('contextDrawer')?.close());

  $('completionCritical')?.addEventListener('change', renderCriticalState);
  $('completionOutcomeField')?.addEventListener('change', renderOutcomeState);
  $('completionCancel')?.addEventListener('click', () => closeCompletion({ cancelled: true }));
  $('completionDismiss')?.addEventListener('click', () => closeCompletion({ cancelled: true }));
  $('completionForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const intent = state.intent;
    if (!intent) return;
    const outcome = await runMove(intent, {
      evidence: $('completionEvidence')?.value,
      changeReason: $('completionReason')?.value,
      humanQuote: $('completionQuote')?.value,
      nextStep: $('completionNextStep')?.value,
      nextWhen: $('completionNextWhen')?.value,
      effectiveDate: $('completionDate')?.value,
      recordCriticalDate: $('completionCritical')?.checked === true,
      dateSource: $('completionSource')?.value,
      outcome: chosenOutcome(),
      closedOn: $('completionClosedOn')?.value,
      wonValue: $('completionWonValue')?.value,
    });
    if (outcome.errors.length) {
      const errors = $('completionErrors');
      if (errors) {
        errors.hidden = false;
        errors.textContent = outcome.errors.join(' ');
        errors.focus?.();
      }
      return;
    }
    closeCompletion({ cancelled: false });
    if (state.panelDeal === intent.deal) await refreshPanel();
  });

  $('conflictCancel')?.addEventListener('click', () => $('conflictDialog')?.close());
  $('conflictForm')?.addEventListener('submit', (event) => { event.preventDefault(); resolveConflictChoice(); });

  $('retryRead')?.addEventListener('click', () => loadBoard());
  const changeView = view => {
    state.view = view;
    const url = new URL(location.href); url.searchParams.set('view',view); history.replaceState({},'',url);
    $('boardView').setAttribute('aria-pressed', String(view === 'board'));
    $('listView').setAttribute('aria-pressed', String(view === 'list'));
    $('lostView').setAttribute('aria-pressed', String(view === 'lost'));
    $('closedView').setAttribute('aria-pressed', String(view === 'closed')); renderBoard();
  };
  $('lostView').addEventListener('click', () => changeView('lost'));
  $('closedView').addEventListener('click', () => changeView('closed'));
  $('closedSearch').addEventListener('input', renderClosedDeals);
  $('boardView').addEventListener('click', () => changeView('board'));
  $('listView').addEventListener('click', () => changeView('list'));
  $('parkedToggle').addEventListener('click', () => { state.parkedOpen = !state.parkedOpen; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); renderBoard(); });
  $('kanban').addEventListener('toggle', e => { if(e.target.classList.contains('parked-lane')) { state.parkedOpen=e.target.open; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); } },true);
  $('panelBody').addEventListener('toggle', event => {
    if (event.target.id !== 'panelEvidenceSection') return;
    if (!event.target.open) { disposeEvidence?.(); disposeEvidence = null; return; }
    if (state.panelDetail) void refreshEvidence(state.panelDetail, state.panelDeal, panelReadSequence);
  }, true);
  $('panelBody').addEventListener('click', e => {
    if (e.target.closest('[data-discard-update]') && !pendingCommand(commandState, updateKey(state.panelDeal))) { discardUpdate(state.panelDeal); syncUpdateForm(); }
    if (e.target.closest('[data-refresh-detail]')) refreshPanel();
    if (e.target.closest('[data-generate-requirement]') && state.selfActor && draftActor === state.selfActor) {
      const form = $('requirementEmailForm');
      if (!form.reportValidity()) return;
      const id = state.panelDeal;
      const draft = Object.assign(requirementDrafts.get(id) || {}, Object.fromEntries(new FormData(form)));
      const subject = `Space requirement · ${draft.use.trim()} · ${draft.location.trim()}`.slice(0, form.elements.subject.maxLength);
      const message = `Hello,\n\nWe are looking for space with the following requirements:\n\n${requirementFields.map(([name,label]) => `${label}: ${draft[name].trim() || 'Not specified'}`).join('\n')}\n\nPlease share matching spaces and availability. Thank you.`;
      Object.assign(draft, {subject,message}); requirementDrafts.set(id,draft);
      form.elements.subject.value = subject;
      form.elements.message.value = message;
      $('requirementEmailStatus').textContent = 'Email preview generated. Review and edit before copying.';
    }
    if (e.target.closest('[data-copy-requirement]')) void copyRequirementDraft();
    if (e.target.closest('[data-discard-requirement]')) {
      requirementDrafts.delete(state.panelDeal);
      for (const input of $('requirementEmailForm').querySelectorAll('input,textarea')) input.value = '';
      $('requirementEmailStatus').textContent = 'Email draft discarded.';
    }

  });
  $('panelBody').addEventListener('input', e => {
    if (e.target.closest('#requirementEmailForm') && state.selfActor && draftActor === state.selfActor) {
      const draft = requirementDrafts.get(state.panelDeal) || {};
      Object.assign(draft, Object.fromEntries(new FormData($('requirementEmailForm'))));
      requirementDrafts.set(state.panelDeal, draft);
    }
    if (e.target.id === 'dealUpdate' && updateDraft) { updateDraft.text = e.target.value; syncUpdateForm(); }
  });
  $('panelBody').addEventListener('change', async e => {
    const id = state.panelDeal;

    if (e.target.id === 'detailPhase') {
      const destination = e.target.value;
      e.target.value = columnByValue(state.deals.get(id)?.phase)?.slug || '';
      beginMove(id, destination);
    }
    if (e.target.id === 'detailOwner') { const value = e.target.value || null; const result = await sendFieldWrite(id,'owner',value); if(result.status === 'ok' && !result.superseded) confirmLocalWrite(id,{owner:result.request.value}); else if(result.conflict) showConflict(result.conflict); else showToast(fieldWriteMessage(result,'Owner') || 'Change not confirmed', {error:true}); renderPendingWrites(); }
  });
  $('panelBody').addEventListener('submit', async e => {
    e.preventDefault(); const id=state.panelDeal; const form = new FormData(e.target);
    if (e.target.id === 'detailParkForm') await setOperatingState(id,{state:'parked',reason:'other',note:String(form.get('reason'))});
    if (e.target.id === 'detailInactiveForm') await markProspectInactive(e.target,id,String(form.get('reason')).trim());
    if (e.target.id === 'detailUpdateForm') await saveUpdate(id);
  });

  globalThis.addEventListener?.('online', () => { state.boardSync.setOnline(true); refreshPanel(); });
  globalThis.addEventListener?.('offline', () => state.boardSync.setOnline(false));
}

function mountDock() {
  const root = $('receiptDock');
  if (!root) return;
  dock = createCommandDock({
    root,
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.kind === 'field') retryFieldWrite(operationKey);
      else if (entry?.kind === 'outcome-read') return runOutcomeWrite(operationKey, entry.step, entry.intent);
      else if (entry?.kind === 'follow-up-read') return runFollowUp(operationKey, entry.step);
      else if (entry?.args) runFollowUp(operationKey, { verb: entry.verb, args: entry.args, summary: entry.summary });
    },
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.kind === 'field') retryFieldWrite(operationKey);
      else if (entry?.kind === 'outcome-read') return runOutcomeWrite(operationKey, entry.step, entry.intent);
      else if (entry?.kind === 'follow-up-read') return runFollowUp(operationKey, entry.step);
      else if (entry?.args && entry?.send) {
        runFollowUp(operationKey, { verb: entry.verb, args: entry.args, summary: entry.summary });
      }
    },
    onUndo: null,
  });
  dock.mount();
}


async function boot() {
  mountPrefs();

  mountDock();
  wire();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: '', search: '' });
  state.client = resolved.mode === 'live' ? createLiveClient() : await createFixtureClient(resolved.options);
  mountNotificationBadge(state.client);
  state.mode = state.client.mode;
  const identity = deploymentIdentity(state.mode);
  $('deploymentBadge').textContent = identity.label;
  $('deploymentBadge').dataset.mode = identity.mode;
  $('deploymentBadge').title = identity.detail;
  state.selfActor = state.client.selfActor || null;
  state.boardSync = createBoardSync({
    readBoard: () => state.client.getBoard({ workspace: 'team' }),
    readChanges: (cursor) => state.client.getChanges(cursor),
    applyBoard: (board) => { applyBoardSnapshot(board); },
    onStatus: renderStatus,
  });
  $('boardView').setAttribute('aria-pressed',String(state.view === 'board'));
  $('listView').setAttribute('aria-pressed',String(state.view === 'list'));
  $('lostView').setAttribute('aria-pressed',String(state.view === 'lost'));
  $('closedView').setAttribute('aria-pressed',String(state.view === 'closed'));
  const linkedDeal = incomingScope.get('deal');
  if (linkedDeal) void openPanel(linkedDeal);
  void loadBoard();
  mountVisibilityPoll({ intervalMs: BOARD_REFRESH_MS, poll: refreshPanel });
  mountVisibilityPoll({ intervalMs: POLL_MS, poll: () => { pollOnce().catch(() => { /* the badge already says the feed failed */ }); } });
  mountVisibilityPoll({ intervalMs: BOARD_REFRESH_MS, poll: () => { state.boardSync.requestRefresh('periodic'); } });

}

if (globalThis.document) boot();

export { state };
