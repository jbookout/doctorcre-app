import { workCard } from './work-card.js';
import { renderDealItems, renderDealSummary, renderOverdueFlag } from './deal-items.js';
import { mountDealItemSheet } from './deal-item-sheet.js';
import { OWNER_FILTERS } from './owner-filters.js';
import { engagementWriterFor } from './prospect-engagement.mjs';
import { showToast } from './toast.js';
import { renderDealVendors } from './deal-vendors.js';
import { renderClientPortalLink } from './client-portal-link.js';
import { pageDocContext, selectDocRecord, setDocFilters, publishDocRead } from './doc-context.js';
import { createCommandDock } from './command-dock.js';
import { readWithDeadline } from './auto-refresh.mjs';
import { preserveBoardFocus } from './board-focus.mjs';
import { performCommand, pendingCommand } from './command-feedback.mjs';
import { createLiveClient } from './live-client.js';
import { mountEvidence, loadEvidence, renderEvidence } from './correspondence.js';
import { deploymentIdentity, resolveDealroomBoot } from './boot-mode.js';
import { ACTOR_LABEL, FACT_TERMS } from './client.js';
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
import { isClosedDeal, localDeals, needsAttention, overdueLabel, overdueSince } from './deal-review-model.js';
import { lostDeals, closedDeals, urgencyOrder, concise, automaticMove, prepareDealDetail, PHASE_TRIGGERS } from './local-deals-model.js';
import { sourceTime } from './email-source-line.js';
import { renderDealTimeline, renderDealUpdates, renderCriticalDates, dealTimeline, dateCaption, calendarDay } from './deal-timeline.js';
import { renderDealChecklist } from './deal-checklist.js';
import { uuidv4 } from './uuid.js';
import { mountVisibilityPoll } from './visibility-poll.mjs';


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
  collapsedColumns: new Set(),
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
const phoneBoard = globalThis.matchMedia?.('(max-width:480px)');
function cardHtml(deal) {
  const today = todayIso(), overdue = overdueLabel(overdueSince(deal, today), today);
  const attention = Boolean(overdue);
  const pending = pendingCommand(state.fieldWrites, cellKey(deal.id, 'phase'));
  return workCard({ variant: 'tile', className: 'kanban-card', heading: 'h4',
    attributes: `data-id="${esc(deal.id)}" data-attention="${attention}" data-phase="${esc(deal.phase)}" draggable="true" tabindex="0"${pending ? ' data-pending="true"' : ''}${state.lifted === deal.id ? ' data-lifted="true"' : ''} aria-label="${esc(dealTitle(deal))}, ${esc(columnLabel(deal.phase))}"`,
    title: `<button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(dealTitle(deal))}</button>`,
    meta: `<span class="owner">${esc(actorName(deal.owner))}</span>${renderOverdueFlag(deal.id, dealTitle(deal), overdue)}`,
    body: `<div class="deal-alert">${renderDealSummary(deal,{today,board:true})}${renderDealItems(deal,{today,buttons:true,empty:false,board:true})}</div>${renderDealVendors(deal.vendors)}${renderClientPortalLink(deal.client_portal_url)}${autoHtml(deal)}` });
}
function rowHtml(deal) {
  const nextStep = noteText(deal.next_step);
  const today = todayIso(), overdue = overdueLabel(overdueSince(deal, today), today);
  return workCard({ variant: 'row', className: 'kanban-card deal-row', heading: 'h4', attributes: `data-id="${esc(deal.id)}" tabindex="0" data-attention="${needsAttention(deal)}"`,
    title: `<button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(dealTitle(deal))}</button>`,
    meta: `<span class="owner">${esc(actorName(deal.owner))}</span>`,
    body: `<span class="deal-stage">${esc(columnLabel(deal.phase))}</span><div class="deal-row-next"><p class="next-line" title="${esc(nextStep)}">${nextStep.trim() ? esc(nextStep) : 'Next step missing'}</p>${renderOverdueFlag(deal.id, dealTitle(deal), overdue)}${renderDealVendors(deal.vendors)}${autoHtml(deal)}</div>` });
}
function parkedHtml(deal) {
  const note = deal.parking_note === 'unverified import — 2026-10-01 records audit; revive if active' ? 'Imported Oct 1, not yet confirmed. Revive if still active.' : deal.parking_note;
  return workCard({ variant: 'tile', className: 'kanban-card parked-card', heading: 'h4', attributes: `data-id="${esc(deal.id)}" tabindex="0"`,
    title: esc(dealTitle(deal)), meta: esc(actorName(deal.owner)), status: deal.parking_reason !== 'other' ? deal.parking_reason?.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()) : '',
    body: `<p class="next-line">${esc(note || deal.parking_reason?.replaceAll('_',' ') || 'Parked')}</p>${renderDealSummary(deal, { today: todayIso(), board: true })}${renderDealItems(deal, { today: todayIso(), buttons: true, empty: false, board: true })}${renderDealVendors(deal.vendors)}`,
    actions: `<button class="btn btn-quiet" type="button" data-revive="${esc(deal.id)}">Revive</button>` });
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
  // A phone shows only work in motion; every parked deal folds into the Parked lane.
  const foldParked = Boolean(phoneBoard?.matches);
  const prospects = rows.filter(d => columnByValue(d.phase)?.slug === 'pending' && (!foldParked || d.operating_state !== 'parked'));
  const parked = rows.filter(d => d.operating_state === 'parked' && (foldParked || columnByValue(d.phase)?.slug !== 'pending'));
  renderBoardMessage();
  const grouped = groupByColumn(active);
  state.unplaced = grouped.unplaced.length;
  const focusedStage = board.contains(document.activeElement) ? document.activeElement?.dataset?.collapseStage : null;
  preserveBoardFocus({ board, document, announce, paint() {
    board.innerHTML = state.view === 'list' ? `<div class="deal-list"><div class="deal-list-head" aria-hidden="true"><span>Deal</span><span>Stage</span><span>Next step</span><span>Owner</span></div>${urgencyOrder(state.parkedOpen ? rows : active).map(d => d.operating_state === 'parked' ? parkedHtml(d) : rowHtml(d)).join('')}</div>` : grouped.columns.map((column) => {
      const cards = urgencyOrder(column.slug === 'pending' ? prospects : column.deals);
      const collapsed = state.collapsedColumns.has(column.slug);
      const content = collapsed
        ? `<p class="stage-preview">${cards.slice(0,2).map(d => `<span>${esc(dealTitle(d))}</span>`).join('')}${cards.length > 2 ? `<span>${cards.length - 2} more</span>` : ''}</p>`
        : cards.map(d => d.operating_state === 'parked' ? parkedHtml(d) : cardHtml(d)).join('');
      const chosen = state.lifted && state.target === column.slug;
      return `<section class="kanban-column glass" data-column="${esc(column.slug)}" ${!cards.length && !state.showEmptyStages ? 'data-hide-empty="true" ' : ''}data-collapsed="${collapsed}"${chosen ? ' data-drop="true"' : ''}
        aria-label="${esc(column.label)}, ${cards.length} cards">
        <h3 title="${esc(PHASE_TRIGGERS[column.slug])}"><button type="button" data-collapse-stage="${esc(column.slug)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(column.label)}">${esc(column.label)}<small>${cards.length}</small><span aria-hidden="true">${collapsed ? '+' : '−'}</span></button></h3>
        ${content}
      </section>`;
    }).join('') + emptyStagesNote(grouped.columns.filter(c => !(c.slug === 'pending' ? prospects : c.deals).length).length) + `<details class="parked-lane"${state.parkedOpen ? ' open' : ''}><summary>Parked · ${parked.length}</summary><div class="parked-cards">${parked.map(parkedHtml).join('')}</div></details>`;
  } });
  const note = $('boardNote');
  if (note) {
    note.hidden = state.unplaced === 0;
    note.textContent = state.unplaced
      ? `${state.unplaced} deals need a phase`
      : '';
  }
  if (focusedStage) board.querySelector(`[data-collapse-stage="${CSS.escape(focusedStage)}"]`)?.focus();
  renderPendingWrites();
}

const emptyStagesNote = count => count ? `<p class="stages-hidden"><span>${state.showEmptyStages ? `Showing ${count} stage${count === 1 ? '' : 's'} with no deals` : `${count} stage${count === 1 ? '' : 's'} hidden`}</span> <button type="button" data-toggle-empty-stages aria-pressed="${Boolean(state.showEmptyStages)}"><span aria-hidden="true">${state.showEmptyStages ? '− ' : '+ '}</span>${state.showEmptyStages ? 'Hide empty stages' : 'Show empty stages'}</button></p>` : '';

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
    clearMarketTermsViews();
    pageDocContext?.clear();
    const contextRead = pageDocContext?.begin('getBoard');
    pageDocContext?.finish(contextRead, board);
    ++panelReadSequence; ++contextReadSequence;
    state.panelDetail = null;
    disposeEvidence?.(); disposeEvidence = null;
    disposePanelEmailFollowups();
    $('contextDrawer').close(); $('contextDrawerBody').replaceChildren();
    $('panelTitle').textContent = 'Deal';
    $('workspaceFacts').replaceChildren();
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
    const template = document.createElement('div'); template.innerHTML = workspaceHtml(state.panelDetail);
    for (const section of ['board-controls', 'prospect']) {
      const selector = `[data-detail-read="${section}"]`;
      $('panelBody').querySelector(selector)?.replaceWith(template.querySelector(selector));
    }
  }
  if (state.panelDeal && !$('recordPanel')?.hidden && previousPanelRow
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

const nextStepKey = deal => `next-step:${deal}`;
const FOLLOW_UP_SENDERS = {
  'resolve-conflict': request => state.client.resolveConflict(request),
  'add-deal-note': (request) => state.client.addDealNote(request),
  'set-next-step': (request) => state.client.setNextStep(request),
  'instruct-deal-item': request => state.client.instructDealItem(request),
  'complete-deal-item': request => state.client.completeDealItem(request),
  'record-deal-item': (request) => state.client.recordDealItem(request),
  'add-critical-date': (request) => state.client.addCriticalDate(request),
  'update-deal': (request) => state.client.updateDeal(request),
  'register-client-portal': (request) => state.client.registerClientPortal(request),
};
const newItemKey = deal => `new-item:${deal}`;

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
  // One unresolved item creation per deal retains its request across moves.
  if (step.verb === 'record-deal-item') operationKey = newItemKey(step.args.deal);
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
        return {status:'conflict', message:`Current next step: ${noteText(current.next_step) || 'None'} (${current.next_date || 'no date'}). Review before retrying.`};
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
  if (step.verb === 'register-client-portal' && result.started) {
    const entry = operations.get(operationKey);
    if (entry?.args?.password) delete entry.args.password;
  }
  if (updateActor !== null && updateActor !== state.selfActor) return result;
  let dockRequest = result.request;
  if (step.verb === 'register-client-portal' && dockRequest) {
    dockRequest = { ...dockRequest };
    delete dockRequest.password;
  }
  dock.record(operationKey, {
    summary: operations.get(operationKey).summary,
    status: result.status === 'blocked' ? 'unknown' : result.status,
    reason: result.message || null,
    retry: result.status === 'blocked' || result.retry, undo: false, request: dockRequest,
  });
  if (step.verb === 'register-client-portal' && result.status === 'ok') state.boardSync.requestRefresh('client-portal');
  if (step.verb === 'add-deal-note' && operationKey === updateKey(state.panelDeal) && state.panelDetail) {
    if ([401,403].includes(result.http_status)) { refusePanelDetail({status:result.http_status}); return result; }
    syncUpdateForm();
    if (result.status === 'ok' && !isUpdate) await refreshPanel();
  }
  if (step.verb === 'resolve-conflict') await settleConflictChoice(step.args.conflict_id, result);
  return result;
}

async function runMove(intent, form) {
  const plan = completionPlan(intent, form);
  if (plan.errors.length) return { ok: false, errors: plan.errors };

  const [phaseStep, ...followUps] = plan.steps;
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
    const phase = columnByValue(state.deals.get(intent.deal)?.phase)?.slug || '';
    const returnTo = state.panelDeal === intent.deal && !$('recordPanel')?.hidden
      ? $('detailPhase') : document.querySelector(`.kanban-card[data-id="${CSS.escape(intent.deal)}"]`)
        || document.querySelector(`[data-collapse-stage="${CSS.escape(phase)}"]`);
    if (returnTo?.id === 'detailPhase') returnTo.value = phase;
    returnTo?.focus({ preventScroll: !returnTo.dataset.collapseStage });
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
let panelEmailFollowups = null;
let emailMountSequence = 0;
function disposePanelEmailFollowups() {
  emailMountSequence++;
  panelEmailFollowups?.dispose(); panelEmailFollowups = null;
}
async function mountPanelEmailFollowups(id) {
  const container = $('panelEmailFollowups'), sequence = ++emailMountSequence;
  try {
    const { mountEmailFollowups } = await import('./email-followups.js');
    if (sequence !== emailMountSequence || state.panelDeal !== id || !container?.isConnected) return;
    panelEmailFollowups = mountEmailFollowups({ container, client: state.client, deal: id,
      onChange: () => { if (state.panelDeal === id) void refreshPanel({ changed: true }); } });
    void panelEmailFollowups.refresh();
  } catch {
    if (sequence === emailMountSequence && container?.isConnected) container.innerHTML = '<p role="status">Could not load email follow-ups.</p><button class="btn" type="button" data-refresh-detail>Retry email follow-ups</button>';
  }
}
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
  clearMarketTermsViews();
  state.panelDetail = null;
  bindDraftActor(null);
  disposeEvidence?.(); disposeEvidence = null;
  disposePanelEmailFollowups();
  setContextOpenVisible(false);
  $('contextDrawer').close();
  $('contextDrawerBody').replaceChildren();
  $('panelTitle').textContent = 'Deal';
  $('workspaceFacts').replaceChildren();
  $('panelBody').innerHTML = '<p role="status">Unavailable. Sign in to reload this record. <a href="/auth/login">Sign in</a> <button class="btn" type="button" data-refresh-detail>Retry</button></p>';
  return true;
}
function syncUpdateForm() {
  const form = $('detailUpdateForm');
  if (!form || !state.panelDeal) return;
  const pending = pendingCommand(commandState, updateKey(state.panelDeal));
  const pendingStep = pendingCommand(commandState, nextStepKey(state.panelDeal));
  bindDraftActor(state.selfActor);
  const requirementFieldset = $('requirementEmailForm')?.querySelector('fieldset');
  if (requirementFieldset) requirementFieldset.disabled = !state.selfActor;
  if (!updateDraft || updateDraft.id !== state.panelDeal) {
    updateDraft = updateDrafts.get(state.panelDeal) || {id:state.panelDeal,text:'', step:noteText(state.panelDetail.deal.next_step), date:state.panelDetail.deal.next_date || '', reviewed:{next_step:state.panelDetail.deal.next_step, next_date:state.panelDetail.deal.next_date}, noteSaved:false};
    updateDrafts.set(state.panelDeal, updateDraft);
  }
  form.elements.text.value = pending ? pending.request.text : updateDraft.text;
  form.elements.text.disabled = Boolean(pending) || updateDraft.noteSaved || !state.selfActor;
  form.elements.step.value = updateDraft.step;
  form.elements.date.value = updateDraft.date;
  form.elements.step.disabled = form.elements.date.disabled = Boolean(pending || pendingStep) || !state.selfActor;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = pending?.status === 'pending' || pendingStep?.status === 'pending' || !state.selfActor;
  button.textContent = pending || pendingStep ? 'Check outcome' : 'Add update';
  form.querySelector('[data-review-update-step]').hidden = !updateDraft.conflict;
  form.querySelector('[data-discard-update]').disabled = Boolean(pending || pendingStep) || !updateDraft.text;
  if (!pending) $('detailUpdateStatus').textContent = updateDraft.noteSaved ? updateDraft.message || 'Update added; next step still needs to be saved.' : updateDraft.text ? 'Unsent draft · kept while this page is open' : updateDraft.message || '';
  if (pending) $('detailUpdateStatus').textContent = pending.message || 'Saving update…';
}
function validateDetail(detail, id) {
  if (!detail?.deal || detail.deal.id !== id || typeof detail.deal.name !== 'string') throw new Error('Invalid detail');
  for (const field of ['activities','thread','next_actions','critical_dates','participants','premises','negotiation_rounds','documents','history']) {
    if (detail[field] !== undefined && (!Array.isArray(detail[field]) || detail[field].some(row => !row || typeof row !== 'object'))) throw new Error('Invalid detail section');
  }
  return prepareDealDetail(detail);
}
function readDealDetail(id) {
  return readWithDeadline(signal => state.client.getDeal(id, { signal })).then(detail => validateDetail(detail, id));
}
function validateUpdateStep(draft, form) {
  if (!draft.step.trim()) { $('detailUpdateStatus').textContent = 'Enter a next step'; form.elements.step.focus(); return false; }
  if (draft.date && draft.date < todayIso()) {
    $('detailUpdateStatus').textContent = draft.date === draft.reviewed.next_date
      ? 'Current next date is overdue. Enter a new date today or later.'
      : 'Next date must be today or later';
    form.elements.date.focus(); return false;
  }
  return true;
}
async function saveUpdate(id) {
  const key = updateKey(id);
  const pending = pendingCommand(commandState, key);
  if (pending?.status === 'pending' || !state.selfActor || draftActor !== state.selfActor) return;
  const form = $('detailUpdateForm');
  const text = form?.elements.text.value.trim();
  if (!pending && !text) { $('detailUpdateStatus').textContent = 'Enter an update'; return; }
  const draft = updateDraft;
  const actor = state.selfActor;
  const step = draft.step.trim();
  const changed = step !== noteText(draft.reviewed.next_step).trim() || draft.date !== (draft.reviewed.next_date || '');
  const pendingStep = pendingCommand(commandState, nextStepKey(id));
  if (changed && !pendingStep && !validateUpdateStep(draft, form)) return;
  if (draft.sending) return;
  if (!draft.stepStarted && pendingCommand(commandState, nextStepKey(id))) { $('detailUpdateStatus').textContent = 'Resolve the pending next step before adding an update.'; return; }
  draft.sending = true;
  try {
    if (!draft.noteSaved) {
      const args = pending?.request || {deal:id,text};
      const promise = runFollowUp(key,{verb:'add-deal-note',args,summary:'Deal update'});
      syncUpdateForm();
      const result = await promise;
      state.boardSync.requestRefresh('deal-update');
      if (result?.status !== 'ok') {
        if (state.panelDeal === id && $('detailUpdateStatus')) $('detailUpdateStatus').textContent = result?.message || 'Update not confirmed';
        return;
      }
      if (actor !== state.selfActor || draftActor !== actor) return;
      draft.noteSaved = true;
    }
    if (changed) {
      if (!pendingStep && !validateUpdateStep(draft, form)) return;
      draft.stepStarted = true;
      const result = await runFollowUp(nextStepKey(id), {verb:'set-next-step', args:{deal:id,text:step,next_date:draft.date || null}, reviewed:draft.reviewed, summary:'Next step'});
      if (result?.status !== 'ok') {
        draft.conflict = result?.status === 'conflict';
        draft.message = `Update added; next step not saved. ${result?.message || 'Review the current next step and retry.'}`;
        if (state.panelDeal === id && $('detailUpdateStatus')) {
          syncUpdateForm();
          $('detailUpdateStatus').textContent = draft.message;
          if (draft.conflict) $('detailUpdateForm').querySelector('[data-review-update-step]').focus();
          else $('detailUpdateStatus').scrollIntoView({block:'center'});
        }
        return;
      }
    }
    if (actor !== state.selfActor || draftActor !== actor) return;
    discardUpdate(id);
    if (changed) state.boardSync.requestRefresh('deal-update');
    if (state.panelDeal === id) {
      await refreshPanel();
      if (actor === state.selfActor && updateDraft?.id === id) {
        updateDraft.message = 'Update added';
        syncUpdateForm();
      }
    }
  } finally { draft.sending = false; }
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
const workspaceTabs = [
  {id:'overview', label:'Overview'},
  {id:'market-terms', label:'Compare terms'},
  {id:'timeline', label:'Timeline'},
  {id:'correspondence', label:'Correspondence & notes'},
];
let workspaceTab = 'overview';
let boardScroll = 0;
let timelineType = '';
history.scrollRestoration = 'manual';
function renderWorkspaceFacts(detail) {
  const d = detail.deal;
  const dates = dealTimeline(detail).dates;
  const active = dates.filter(date => !['cleared','passed'].includes(date.status));
  const next = active.find(date => date.day >= todayIso()) || active[0] || dates[0];
  $('workspaceFacts').innerHTML = `<dl class="workspace-facts"><div><dt>Client</dt><dd title="${esc(d.client_name || d.client_ref || 'Not recorded')}">${esc(d.client_name || d.client_ref || 'Not recorded')}</dd></div><div><dt>Phase</dt><dd>${esc(columnByValue(d.phase)?.label || d.phase || 'Not recorded')}</dd></div><div><dt>Owner</dt><dd>${esc(actorName(d.owner) || 'Unassigned')}</dd></div><div><dt>Next critical date</dt><dd>${next ? `<span class="workspace-date-label">${esc(next.label)} · </span><time datetime="${esc(next.day)}">${esc(dateCaption(next.day))}</time>${['cleared','passed'].includes(next.status) ? ` · ${esc(next.status)}` : next.day < todayIso() ? ' · overdue' : ''}` : 'Not recorded'}</dd></div></dl>`;
}
function selectWorkspaceTab(id) {
  workspaceTab = id;
  for (const tab of workspaceTabs) {
    const selected = tab.id === id;
    $(`tab-${tab.id}`).setAttribute('aria-selected', String(selected));
    $(`tab-${tab.id}`).tabIndex = selected ? 0 : -1;
    if ($(`workspace-${tab.id}`)) $(`workspace-${tab.id}`).hidden = !selected;
  }
  if (id === 'market-terms') void marketTermsPanel?.load();
  $('panelContextOpenWrap').hidden = id !== 'overview' || !state.panelDetail;
  if (id === 'correspondence' && state.panelDetail) {
    $('panelEvidenceSection').open = true;
  }
}
function workspaceNotesHtml(detail) {
  return `<section aria-label="Deal notes"><h3>Deal notes</h3>${(detail.thread || []).map(note => `<article class="workspace-note"><b>${esc(actorName(note.actor))}</b> <time datetime="${esc(note.at || note.created_at || note.recorded_at || '')}">${esc(sourceTime(note.at || note.created_at || note.recorded_at, undefined, 'Date not recorded'))}</time><p class="note-original">${esc(noteText(note.text))}</p></article>`).join('') || '<p>No notes recorded.</p>'}</section>`;
}
function workspaceEventsHtml(detail) {
  const view = dealTimeline(detail);
  const events = [
    ...view.entries.filter(e => e.day).map(e => ({type:e.type, day:e.day, text:[...new Set([e.summary,e.original].filter(Boolean))].join('\n\n')})),
    ...(detail.items || detail.deal.items || []).filter(e => calendarDay(e.due_on)).map(e => ({type:'Deal item', day:calendarDay(e.due_on), text:noteText(e.title)})),
    ...view.dates.map(e => ({type:'Critical date', day:e.day, text:[e.label,e.original].filter(Boolean).join(' · ')})),
    ...view.phases.filter(e => e.day).map(e => ({type:'Phase', day:e.day, text:e.label})),
    ...(calendarDay(detail.deal.next_date) && noteText(detail.deal.next_step) && !(detail.next_actions || []).some(e => calendarDay(e.due_on) === calendarDay(detail.deal.next_date) && noteText(e.description) === noteText(detail.deal.next_step)) ? [{type:'Action', day:calendarDay(detail.deal.next_date), text:`Due · ${noteText(detail.deal.next_step)}`}] : []),
    ...(detail.next_actions || []).flatMap(e => [['due_on','Due'],['hold_until','Held until']].filter(([key]) => calendarDay(e[key])).map(([key,label]) => ({type:'Action', day:calendarDay(e[key]), text:`${label} · ${noteText(e.description)}`}))),
    ...(detail.history || []).filter(e => calendarDay(e.recorded_at) && !view.entries.some(entry => entry.id === e.id)).map(e => ({type:'Change', day:calendarDay(e.recorded_at), text:noteText(e.summary) || `${fieldLabel(e.field)} · ${readableValue(e.field, e.new_value)}`})),
  ].sort((a,b) => b.day.localeCompare(a.day));
  if (!events.some(event => event.type === timelineType)) timelineType = '';
  return `<h2>Dated events</h2><label for="timelineType">Filter by type</label><select id="timelineType"><option value="">All types</option>${[...new Set(events.map(e => e.type))].map(type => `<option${type === timelineType ? ' selected' : ''}>${esc(type)}</option>`).join('')}</select><ol class="workspace-events">${events.map(e => `<li data-event-type="${esc(e.type)}"${timelineType && e.type !== timelineType ? ' hidden' : ''}><time datetime="${esc(e.day)}">${esc(dateCaption(e.day))}</time><small>${esc(e.type)}</small><p class="note-original">${esc(e.text)}</p></li>`).join('')}</ol>${events.length ? '' : '<p>No dated events recorded.</p>'}`;
}
let factReviewPanel, marketTermsPanel;
// Each deal's comparison is kept for the session and reattached when its tab reopens; an access change discards them all.
const marketTermsViews = new Map();
function clearMarketTermsViews() {
  for (const view of marketTermsViews.values()) view.mounted?.dispose();
  marketTermsViews.clear();
}

function workspaceHtml(detail) {
  const d = detail.deal;
  const nextStep = noteText(d.next_step);
  const items = detail.items || d.items || [];
  const showNextStep = nextStep && !items.some(item => item.status === 'open' && item.title === nextStep);
  const prospect = state.deals.get(d.id);
  const pendingProspect = engagementWriterFor(state.client).get(prospect?.client_id, state.selfActor);
  const parked = d.operating_state === 'parked';
  const controlsAvailable = state.deals.has(d.id) && !isClosedDeal(d);
  return `<div class="deal-freshness"><time id="detailUpdated" title="Last updated"></time><button class="btn icon-btn" type="button" data-refresh-detail aria-label="Refresh deal" title="Refresh">↻</button></div><p id="detailReadStatus" role="status"></p>
    <section id="workspace-overview" role="tabpanel" aria-labelledby="tab-overview"><section class="deal-opening-snapshot" data-detail-read="snapshot" aria-label="Deal snapshot">
      <div class="deal-alert">${renderDealItems({...d,items:detail.items || d.items},{today:todayIso(),buttons:true})}</div>
      ${showNextStep ? `<p class="deal-current-action"><span>${d.next_date && d.next_date < todayIso() ? 'Overdue action' : 'Next action'}</span>: <strong>${esc(nextStep)}</strong>${d.next_date ? ` · <span>Due <time datetime="${esc(d.next_date)}">${esc(dateWords(d.next_date))}</time></span>` : ''}</p>` : ''}
      <dl class="deal-snapshot-facts">${d.workspace_kind === 'national_account' || d.account_client_id ? `<div><dt>Market agent</dt><dd>${esc(d.market_agent || 'Unassigned')}</dd></div>` : ''}${d.client_name ? `<div><dt>Client</dt><dd>${esc(d.client_name)}</dd></div>` : ''}${d.type ? `<div><dt>Type</dt><dd>${esc(d.type)}</dd></div>` : ''}${d.outcome ? `<div><dt>Outcome</dt><dd>${esc(d.outcome[0].toUpperCase()+d.outcome.slice(1))}</dd></div>` : ''}</dl>
    </section>
    <section data-detail-read="next-actions" aria-label="Next actions"><h2>Next actions</h2><ul>${(detail.next_actions || []).filter(action => action.status === 'open').map(action => `<li>${esc(noteText(action.description))}${calendarDay(action.due_on) ? ` · <time datetime="${esc(action.due_on)}">${esc(dateCaption(calendarDay(action.due_on)))}</time>` : ''}</li>`).join('') || '<li>No next actions recorded.</li>'}</ul></section>
    <section id="panelTerms" aria-label="Terms"><h2>Terms</h2><button type="button" class="btn" data-open-terms>Show sourced terms</button></section>
    <div data-detail-read="checklist">${renderDealChecklist(detail.checklist)}</div>
    <form id="detailUpdateForm" class="deal-update-form" novalidate><label for="dealUpdate">Update</label><textarea id="dealUpdate" name="text" rows="2" maxlength="10000" required></textarea><label for="dealUpdateStep">Next step</label><input id="dealUpdateStep" name="step" maxlength="10000" autocomplete="off"><label for="dealUpdateDate">Next date</label><input id="dealUpdateDate" name="date" type="date" min="${todayIso()}"${d.next_date && d.next_date < todayIso() ? ' aria-describedby="detailUpdateDateHint"' : ''}>${d.next_date && d.next_date < todayIso() ? '<small id="detailUpdateDateHint">Current next date is overdue.</small>' : ''}<button class="btn btn-primary" type="submit">Add update</button><button class="btn" type="button" data-review-update-step hidden>Review current next step</button><button class="btn btn-quiet" type="button" data-discard-update>Discard draft</button><p id="detailUpdateStatus" role="status"></p></form>
    <section id="panelEmailFollowups" aria-label="Email follow-ups"><p role="status">Updating email follow-ups…</p></section>
    ${requirementEmailHtml(d)}
    <div data-detail-read="vendors">${renderDealVendors(d.vendors)}</div>
    ${clientPortalHtml(d, controlsAvailable)}
    <div data-detail-read="board-controls" data-available="${controlsAvailable}">${controlsAvailable ? `<div class="detail-actions"><div class="detail-controls"><label>Phase<select id="detailPhase">${COLUMNS.map(c => `<option value="${esc(c.slug)}"${c.value === d.phase ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label><label>Owner<select id="detailOwner"><option value="">Unassigned</option>${['joe','dell'].map(owner => `<option value="${owner}"${owner === d.owner ? ' selected' : ''}>${actorName(owner)}</option>`).join('')}</select></label></div><div data-detail-read="parking" data-parked="${parked}">${parked ? `<p>${esc(concise(d.parking_note) || 'Parked')}</p><button type="button" class="btn" data-revive="${esc(d.id)}">Revive</button>` : `<details class="park-options"><summary class="park-control">Park</summary><form id="detailParkForm"><label>Park reason<input name="reason" maxlength="500" required></label><button class="btn park-control" type="submit">Park deal</button></form></details>`}</div></div>` : ''}</div>
    <div data-detail-read="prospect">${controlsAvailable && prospect?.client_status === 'prospect' ? `<form id="detailInactiveForm"><p>Inactive prospects return to Leads.</p><label>Reason<input name="reason" maxlength="1000" required value="${esc(pendingProspect?.request.reason || '')}"${pendingProspect ? ' readonly' : ''}></label><button class="btn" type="submit">${pendingProspect ? 'Check outcome' : 'Mark inactive'}</button><p role="status" data-prospect-status>${pendingProspect ? 'Confirmation pending for this prospect. Check outcome to retry the same request.' : ''}</p></form>` : ''}</div>
    <h2>Critical dates</h2>${renderCriticalDates(detail)}
    <div data-detail-read="updates">${renderDealUpdates(detail)}</div></section>
    <section id="workspace-market-terms" role="tabpanel" aria-labelledby="tab-market-terms" hidden></section>
    <section id="workspace-timeline" role="tabpanel" aria-labelledby="tab-timeline" hidden><div data-detail-read="events">${workspaceEventsHtml(detail)}</div>${renderDealTimeline(detail)}</section>
    <section id="workspace-correspondence" role="tabpanel" aria-labelledby="tab-correspondence" hidden><h2>Correspondence &amp; notes</h2><details id="panelEvidenceSection"><summary>Threads &amp; meetings</summary><div id="panelEvidence"></div></details><div data-detail-read="notes">${workspaceNotesHtml(detail)}</div></section>`;
}
function clientPortalHtml(d, canRegister) {
  if (d.client_portal_url) return `<div data-detail-read="client-portal">${renderClientPortalLink(d.client_portal_url)}</div>`;
  if (!canRegister) return '';
  return `<div data-detail-read="client-portal"><details class="client-portal-register"><summary>Set up client portal</summary><form id="detailClientPortalForm" class="client-portal-form"><label for="clientPortalSlug">Portal name</label><input id="clientPortalSlug" name="slug" required maxlength="63" pattern="[a-z0-9][a-z0-9\\-]*" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="practice-name" data-detail-focus="client-portal-slug"><label for="clientPortalPassword">Password</label><input id="clientPortalPassword" type="password" name="password" required maxlength="1024" autocomplete="off" autocapitalize="none" spellcheck="false" data-detail-focus="client-portal-password"><button class="btn" type="submit">Register portal</button></form></details><p id="detailClientPortalStatus" role="status"></p></div>`;
}
async function registerClientPortal(id, form) {
  const slug = String(form.get('slug')).trim().toLowerCase();
  const status = $('detailClientPortalStatus');
  status.textContent = 'Registering…';
  const result = await runFollowUp(`client-portal:${id}`, {
    verb: 'register-client-portal', args: { deal: id, slug, password: String(form.get('password')) },
    summary: 'Client portal',
  });
  if (state.panelDeal !== id) return;
  if (result?.status === 'ok') {
    await refreshPanel();
  } else if ($('detailClientPortalStatus')) {
    $('detailClientPortalStatus').textContent = result?.message || 'Client portal not confirmed';
  }
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
      renderWorkspaceFacts(detail);
      const template = document.createElement('div'); template.innerHTML = workspaceHtml(detail);
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
      void factReviewPanel?.refresh();
      void marketTermsPanel?.refresh();
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
  renderWorkspaceFacts(detail);
  factReviewPanel?.dispose();
  marketTermsPanel?.dispose();
  $('panelBody').innerHTML = workspaceHtml(detail);
  const terms = $('panelTerms');
  let disposed = false, loading = false, mounted;
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void loadTerms();
  });
  async function loadTerms() {
    if (disposed || loading) return;
    loading = true;
    observer.disconnect();
    terms.textContent = 'Loading terms…';
    try {
      const { mountFactReview } = await import('./ui.generated.js');
      if (disposed) return;
      terms.replaceChildren();
      mounted = mountFactReview(terms, { client: state.client, entityRef: detail.deal.id, terms: FACT_TERMS });
    } catch {
      if (!disposed) terms.textContent = 'Terms unavailable. Reopen this deal to try again.';
    }
  }
  terms.querySelector('[data-open-terms]').addEventListener('click', loadTerms);
  observer.observe(terms);
  factReviewPanel = {
    refresh() { return mounted?.refresh(); },
    dispose() { disposed = true; observer.disconnect(); mounted?.dispose(); },
  };
  disposeEvidence?.(); disposeEvidence = null;
  disposePanelEmailFollowups();
  syncUpdateForm();
  updateDetailTimestamp();
  let marketDisposed = false, marketLoading = false;
  marketTermsPanel = {
    async load() {
      if (marketDisposed || marketLoading) return;
      const root = $('workspace-market-terms');
      const cached = marketTermsViews.get(detail.deal.id);
      if (cached) { root.replaceChildren(cached.element); return; }
      marketLoading = true;
      root.textContent = 'Loading comparable terms…';
      try {
        const { mountMarketTerms } = await import('./ui.generated.js');
        if (marketDisposed) return;
        const element = document.createElement('div');
        const mounted = mountMarketTerms(element, { client: state.client, entityRef: detail.deal.id, submarket: detail.deal.submarket, useType: detail.deal.use_type, dealName: ref => state.deals.get(ref)?.name });
        marketTermsViews.set(detail.deal.id, { element, mounted });
        root.replaceChildren(element);
      } catch { if (!marketDisposed) root.textContent = 'Could not load comparable terms. Try again.'; }
      finally { marketLoading = false; }
    },
    refresh() { return marketTermsViews.get(detail.deal.id)?.mounted.refresh(); },
    dispose() { marketDisposed = true; },
  };
  selectWorkspaceTab(workspaceTab);
  void mountPanelEmailFollowups(detail.deal.id);
}
async function openWorkspace(dealId, trigger, { fromHistory = false } = {}) {
  factReviewPanel?.dispose();
  factReviewPanel = null;
  marketTermsPanel?.dispose();
  marketTermsPanel = null;
  selectDocRecord('deal', dealId);
  const panel = $('recordPanel');
  disposeEvidence?.(); disposeEvidence = null;
  disposePanelEmailFollowups();
  setContextOpenVisible(false);
  if (!state.panelDeal) boardScroll = history.state?.boardScroll ?? scrollY;
  workspaceTab = 'overview'; timelineType = '';
  state.panelDeal = dealId; state.panelDetail = null; updateDraft = null;
  const url = new URL(location.href);
  if (!fromHistory && url.searchParams.get('deal') !== dealId) {
    url.searchParams.set('deal',dealId);
    history.replaceState({...history.state, boardScroll:scrollY}, '', location.href);
    history.pushState({doctorcreDealWorkspace:true},'',url);
  }
  state.panelReturnTo = trigger?.closest('.kanban-card')?.dataset.id || dealId;
  $('panelTitle').textContent = state.deals.get(dealId)?.name || 'Deal';
  $('panelBody').innerHTML = '<p>Updating…</p>';
  $('workspaceFacts').replaceChildren();
  $('workspaceTabs').innerHTML = workspaceTabs.map(tab => `<button class="workspace-tab" type="button" role="tab" id="tab-${tab.id}" aria-controls="workspace-${tab.id}" aria-selected="${tab.id === workspaceTab}" tabindex="${tab.id === workspaceTab ? 0 : -1}" data-workspace-tab="${tab.id}">${tab.label}</button>`).join('');
  $('main').hidden = true; panel.hidden = false;
  document.body.classList.add('workspace-open');
  scrollTo(0, 0);
  $('panelTitle').focus({preventScroll:true});
  await refreshPanel();
}
function closeWorkspace({ fromHistory = false } = {}) {
  factReviewPanel?.dispose();
  factReviewPanel = null;
  marketTermsPanel?.dispose();
  marketTermsPanel = null;
  if (!fromHistory && history.state?.doctorcreDealWorkspace) { history.back(); return; }
  selectDocRecord('deal', null);
  pageDocContext?.release('getDeal');
  ++panelReadSequence; ++contextReadSequence;
  $('contextDrawer').close(); $('contextDrawerBody').replaceChildren();
  const id = state.panelReturnTo;
  disposeEvidence?.(); disposeEvidence=null;
  disposePanelEmailFollowups();
  if (!fromHistory) { const url = new URL(location.href); url.searchParams.delete('deal'); history.replaceState({},'',url); }
  $('recordPanel').hidden = true; $('main').hidden = false;
  document.body.classList.remove('workspace-open');
  state.panelDeal = null; state.panelDetail = null;
  scrollTo(0, history.state?.boardScroll ?? boardScroll);
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
    if (state.panelDeal === id) closeWorkspace();
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
    if (state.panelDeal === id) closeWorkspace();
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
  if (wrap) wrap.hidden = !visible || workspaceTab !== 'overview';
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

  board.addEventListener('click', (event) => {
    if (event.target.closest('[data-toggle-empty-stages]')) { state.showEmptyStages = !state.showEmptyStages; renderBoard(); return; }
    const toggle = event.target.closest('[data-collapse-stage]');
    if (!toggle) return;
    const slug = toggle.dataset.collapseStage;
    if (state.collapsedColumns.has(slug)) state.collapsedColumns.delete(slug);
    else state.collapsedColumns.add(slug);
    renderBoard();
  });

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
    if (event.target.closest('button,input,select,a,.deal-vendor-details')) return;
    if (state.view === 'list' || card.classList.contains('parked-card')) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openWorkspace(card.dataset.id, card); } return; }
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
    const item = event.target.closest('[data-deal-item]');
    if (item) { itemSheet.open(item.dataset.itemDeal,item.dataset.dealItem,item); return; }
    const revive = event.target.closest('button[data-revive]');
    if (revive) { setOperatingState(revive.dataset.revive, {state:'active'}); return; }
    const open = event.target.closest('button[data-open]');
    if (open) { openWorkspace(open.dataset.open, open); return; }
    const retry = event.target.closest('button[data-retry-write]');
    if (retry) { retryFieldWrite(retry.dataset.retryWrite); return; }
    const undo = event.target.closest('button[data-undo]');
    if (undo) { runUndo(undo.dataset.undo); return; }
    const openDeal = event.target.closest('button[data-open-deal]');
    const card = event.target.closest('.kanban-card');
    if (card && card.dataset.dragging !== 'true' && !event.target.closest('button,input,select,a,.deal-vendor-details')) { openWorkspace(card.dataset.id, card); return; }
    if (openDeal) {
      openWorkspace(openDeal.dataset.openDeal, null);
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
    if (deal) void openWorkspace(deal, null, {fromHistory:true});
    else closeWorkspace({fromHistory:true});
  });
  $('panelClose')?.addEventListener('click', () => closeWorkspace());
  $('workspaceTabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-workspace-tab]');
    if (tab) { selectWorkspaceTab(tab.dataset.workspaceTab); scrollTo(0,0); }
  });
  $('workspaceTabs').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const index = workspaceTabs.findIndex(tab => tab.id === workspaceTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? workspaceTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + workspaceTabs.length) % workspaceTabs.length;
    selectWorkspaceTab(workspaceTabs[next].id);
    $(`tab-${workspaceTab}`).focus();
    scrollTo(0,0);
  });
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
  phoneBoard?.addEventListener('change', renderBoard);
  $('parkedToggle').addEventListener('click', () => { state.parkedOpen = !state.parkedOpen; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); renderBoard(); });
  $('kanban').addEventListener('toggle', e => { if(e.target.classList.contains('parked-lane')) { state.parkedOpen=e.target.open; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); } },true);
  $('panelBody').addEventListener('toggle', event => {
    if (event.target.id !== 'panelEvidenceSection') return;
    if (!event.target.open) { disposeEvidence?.(); disposeEvidence = null; return; }
    if (state.panelDetail) void refreshEvidence(state.panelDetail, state.panelDeal, panelReadSequence);
  }, true);
  $('panelBody').addEventListener('click', e => {
    if (e.target.closest('[data-discard-update]') && !pendingCommand(commandState, updateKey(state.panelDeal)) && !pendingCommand(commandState, nextStepKey(state.panelDeal))) { discardUpdate(state.panelDeal); syncUpdateForm(); }
    if (e.target.closest('[data-review-update-step]') && updateDraft?.conflict) {
      const draft = updateDraft;
      void readDealDetail(draft.id).then(detail => {
        if (updateDraft !== draft || draftActor !== state.selfActor) return;
        draft.reviewed = {next_step:detail.deal.next_step, next_date:detail.deal.next_date};
        draft.conflict = false;
        draft.message = `Current next step: ${noteText(detail.deal.next_step) || 'None'} (${detail.deal.next_date || 'no date'}). Retry to replace it.`;
        syncUpdateForm();
      }).catch(() => { if (updateDraft === draft) $('detailUpdateStatus').textContent = 'Could not read the current next step.'; });
    }
    if (e.target.closest('[data-refresh-detail]')) {
      void refreshPanel();
      if (panelEmailFollowups) void panelEmailFollowups.refresh();
      else if (state.panelDetail) void mountPanelEmailFollowups(state.panelDeal);
    }
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
    if (e.target.closest('#detailUpdateForm') && updateDraft && ['text','step','date'].includes(e.target.name)) { updateDraft[e.target.name] = e.target.value; syncUpdateForm(); }
  });
  $('panelBody').addEventListener('change', async e => {
    if (e.target.id === 'timelineType') {
      timelineType = e.target.value;
      $('workspace-timeline').querySelectorAll('[data-event-type]').forEach(row => { row.hidden = Boolean(e.target.value && row.dataset.eventType !== e.target.value); });
      return;
    }
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
    if (e.target.id === 'detailClientPortalForm') await registerClientPortal(id, form);
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
      else if (entry?.args) runFollowUp(operationKey, { verb: entry.verb, args: entry.verb === 'register-client-portal' ? pendingCommand(commandState, operationKey)?.request || entry.args : entry.args, summary: entry.summary });
    },
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.kind === 'field') retryFieldWrite(operationKey);
      else if (entry?.kind === 'outcome-read') return runOutcomeWrite(operationKey, entry.step, entry.intent);
      else if (entry?.kind === 'follow-up-read') return runFollowUp(operationKey, entry.step);
      else if (entry?.args && entry?.send) {
        runFollowUp(operationKey, { verb: entry.verb, args: entry.verb === 'register-client-portal' ? pendingCommand(commandState, operationKey)?.request || entry.args : entry.args, summary: entry.summary });
      }
    },
    onUndo: null,
  });
  dock.mount();
}


let itemSheet;
async function boot() {
  mountPrefs();

  mountDock();
  wire();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: '', search: '' });
  state.client = resolved.mode === 'live' ? createLiveClient() : await (await import("./fixture-client.js")).createFixtureClient(resolved.options);
  mountNotificationBadge(state.client);
  itemSheet = mountDealItemSheet({document,today:todayIso,read:readDealDetail,send:runFollowUp,pending:key => pendingCommand(commandState,key),refresh:() => {state.boardSync.requestRefresh('deal-item');refreshPanel();}});
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
  if (linkedDeal) void openWorkspace(linkedDeal).then(() => {
    if (incomingScope.get('item') && state.panelDeal === linkedDeal) void itemSheet.open(linkedDeal,incomingScope.get('item'));
  });
  void loadBoard();
  mountVisibilityPoll({ poll: refreshPanel });
  mountVisibilityPoll({ poll: () => { pollOnce().catch(() => { /* the badge already says the feed failed */ }); } });
  mountVisibilityPoll({ poll: () => { state.boardSync.requestRefresh('periodic'); } });


}

if (globalThis.document) boot();

export { state };
/** Read-only view of the command dock's entries, for tests that prove what it retains. */
export const dockEntries = () => dock.entries ?? new Map();
