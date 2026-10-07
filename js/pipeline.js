import { pageDocContext, selectDocRecord, setDocFilters, publishDocRead } from './doc-context.js';
// V5-UX-B03 — Deals: the Kanban board's DOM wiring, and nothing else.
//
// Every decision about columns, payloads and words lives in
// ./pipeline-model.js. Every decision about what a write DID lives in the
// shared kernels: ./field-write-reconciliation.mjs for the one cell this board
// edits, ./command-feedback.mjs for the optional follow-ups, ./board-sync.mjs
// for what may be shown, ./change-receipts.mjs for what was seen and what can
// be undone. This file reads the board, paints it, and turns a drag into one
// move.
//
// Three rules govern it, and they are why it is shaped this way:
//
//   1. THE BOARD IS READ IN ONE PLACE. Every displayed value comes from an
//      authoritative snapshot the coordinator applied. The changes feed drives
//      presence, receipts and one coalesced re-read — it never supplies a
//      value, because the cursor walks the whole log from the beginning and an
//      early page carries values that are months old.
//   2. IDENTITY IS THE id. A snapshot replaces every row object, so nothing
//      here holds a row across an await: a lifted card, an open panel and an
//      unfinished move all hold ids and resolve them at the moment of use.
//   3. THE MOVE IS THE MOVE. The phase patch goes first and alone; the note,
//      the next step and the critical date are separate operations with
//      separate keys that run only after the server accepted the phase. A
//      follow-up that fails leaves the card where the server put it and says so
//      on its own receipt. Nothing here is a gate, because the record layer has
//      none to report.

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
  createBoardSync, batchTouchesBoard, SYNC_STATES,
} from './board-sync.mjs';
import {
  cellKey, performFieldWrite, unresolvedFieldWrites, fieldWriteMessage, nextCellBase,
} from './field-write-reconciliation.mjs';
import {
  escapeText, fieldLabel, readableValue, ingestChangeEvents, receiptViews, receiptListHtml,
  receiptsSignature, createFeedProgress, observeChangeBatch, performUndo,
} from './change-receipts.mjs';
import {
  CLOSED_SLUG, COLUMNS, COMPLETION_CAPTIONS, closedColumnCaption, columnBySlug, columnByValue,
  columnLabel, completionPlan, contextDrawerSections, groupByColumn, keyboardTarget,
  loadDealContext, moveIntent, moveSummary, moveTitle, noteText, presenceChip,
  dealInsightLines,
} from './pipeline-model.js';
import { localDeals, needsAttention, urgencyOrder, concise, automaticMove, OWNER_FILTERS, PHASE_TRIGGERS } from './local-deals-model.js';
import { DATE_KINDS, renderPhaseTimeline, renderCriticalDates, renderDealTimeline, updateCountdowns } from './deal-timeline.js';
import { uuidv4 } from './uuid.js';

const POLL_MS = 1400;
/** The ceiling on how long this board goes without ASKING again. Not a freshness claim. */
const BOARD_REFRESH_MS = 15000;

const $ = (id) => document.getElementById(id);
const esc = escapeText;
const actorName = (slug) => ACTOR_LABEL[slug] || slug || 'Unassigned';
const incomingScope = new URLSearchParams(globalThis.location?.search);

/** One place holds what this page believes; nothing else keeps a copy. */
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
  view: incomingScope.get('view') === 'list' ? 'list' : 'board',
  parkedOpen: false,
  timelineFull: true,
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
/** What each open operation would send again: the dock's two buttons need it. */
const operations = new Map();

function announce(text) {
  const live = $('dragLive');
  if (live) live.textContent = text;
}

function say(text) {
  const live = $('boardLive');
  if (live && live.textContent !== text) live.textContent = text;
}

function showToast(text) {
  document.querySelectorAll('.toast').forEach((node) => node.remove());
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.textContent = text;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 4100);
}

const dateWords = (value) => (value ? formatCalendarDate(value) || value : 'no date recorded');

/* ------------------------------------------------------------------ painting */

function autoHtml(deal) {
  const move = automaticMove(deal);
  return move ? `<div class="auto-move"><span>${esc(move.text.slice(0, move.text.lastIndexOf(' ')))}</span> <time>${esc(move.text.slice(move.text.lastIndexOf(' ') + 1))}</time><button class="btn btn-quiet" type="button" data-undo="${esc(move.eventId)}" aria-label="Undo phase change on ${esc(deal.name)}">Undo</button></div>` : '';
}
function cardHtml(deal) {
  const attention = needsAttention(deal);
  const pending = pendingCommand(state.fieldWrites, cellKey(deal.id, 'phase'));
  return `<article class="kanban-card" data-id="${esc(deal.id)}" data-attention="${attention}" data-phase="${esc(deal.phase)}" draggable="true" tabindex="0"${pending ? ' data-pending="true"' : ''}${state.lifted === deal.id ? ' data-lifted="true"' : ''} aria-label="${esc(deal.name)}, ${esc(columnLabel(deal.phase))}">
    <h4><button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(deal.name)}</button></h4>
    <div class="work-meta"><span class="owner">${esc(actorName(deal.owner))}</span>${attention ? '<span class="attention-dot" aria-label="Needs attention"></span>' : ''}</div>
    <p class="next-line">${esc(concise(deal.next_step) || 'Next step pending')}</p>
    ${autoHtml(deal)}
  </article>`;
}
function rowHtml(deal) {
  return `<article class="kanban-card deal-row" data-id="${esc(deal.id)}" tabindex="0" data-attention="${needsAttention(deal)}">
    <h4>${esc(deal.name)}</h4><span>${esc(columnLabel(deal.phase))}</span>
    <p class="next-line">${esc(concise(deal.next_step) || 'Next step pending')}</p><span>${esc(actorName(deal.owner))}</span>${autoHtml(deal)}</article>`;
}
function parkedHtml(deal) {
  return `<article class="kanban-card parked-card" data-id="${esc(deal.id)}" tabindex="0"><h4>${esc(deal.name)}</h4><p class="next-line">${esc(deal.parking_note || deal.parking_reason?.replaceAll('_',' ') || 'Parked')}</p><button class="btn btn-quiet" type="button" data-revive="${esc(deal.id)}">Revive</button></article>`;
}

function renderBoard() {
  const board = $('kanban');
  // Fresh snapshots still enter state; dragend paints them without detaching the drag origin.
  if (!board || board.querySelector('[data-dragging="true"]')) return;
  const rows = localDeals([...state.deals.values()], state.personalScope ? state.selfActor : state.filter)
    .filter(d => state.scopeFilter !== 'flagged' || d.attention === true);
  setDocFilters({ owner: state.personalScope ? state.selfActor : state.filter, filter: state.scopeFilter });
  publishDocRead('getBoard', { deals: rows });
  const active = rows.filter(d => d.operating_state !== 'parked');
  const parked = rows.filter(d => d.operating_state === 'parked');
  const grouped = groupByColumn(active);
  state.unplaced = grouped.unplaced.length;
  preserveBoardFocus({ board, document, announce, paint() {
    board.innerHTML = state.view === 'list' ? `<div class="deal-list">${urgencyOrder(state.parkedOpen ? rows : active).map(d => d.operating_state === 'parked' ? parkedHtml(d) : rowHtml(d)).join('')}</div>` : grouped.columns.map((column) => {
      const cards = urgencyOrder(column.deals);
      const chosen = state.lifted && state.target === column.slug;
      return `<section class="kanban-column glass" data-column="${esc(column.slug)}"${chosen ? ' data-drop="true"' : ''}
        aria-label="${esc(column.label)}, ${cards.length} cards">
        <h3 title="${esc(PHASE_TRIGGERS[column.slug])}">${esc(column.label)}<small>${cards.length}</small></h3>
        ${cards.map(cardHtml).join('')}
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
    asOf.textContent = status.last_read_at
      ? `Updated ${new Date(status.last_read_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',hour12:true})}`
      : [SYNC_STATES.ERROR,SYNC_STATES.OFFLINE,SYNC_STATES.RECONNECTING].includes(status.state) ? 'Board unavailable' : 'Updating…';
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
  list.innerHTML = views.length ? receiptListHtml(views)
    : '<li class="receipt"><p class="receipt-line">Nothing has changed in this session yet.</p></li>';
}

/* ------------------------------------------------------------------- reading */

function noteCellBase(cell, event) {
  if (!event?.id) return;
  // Identity and time only. A feed event carries values too, and none of them
  // belong in this map: this is a base, not a value.
  const seen = { id: event.id, recorded_at: event.recorded_at ?? null };
  state.fieldBase.set(cell, nextCellBase(state.fieldBase.get(cell) || null, seen));
}

function applyBoardSnapshot(board) {
  state.selfActor = board.actor || state.client.selfActor || state.selfActor;
  if (state.personalScope && ['joe','dell'].includes(state.selfActor)) state.filter = state.selfActor;
  state.deals = new Map((board.deals || []).map((deal) => [deal.id, deal]));
  // The base for each editable cell, from the same read as the values, through
  // the forward-only rule — a read already open when a write was confirmed
  // carries an OLDER base and must not walk this cell backwards.
  for (const deal of state.deals.values()) {
    for (const [field, seen] of Object.entries(deal.field_base || {})) {
      noteCellBase(cellKey(deal.id, field), seen);
    }
  }
  renderChips();
  renderBoard();
  if (state.panelDeal && $('recordPanel')?.open) refreshPanel();
}

async function loadBoard() {
  const outcome = await state.boardSync.refreshBoard({ reason: 'load-board' });
  if (!outcome.applied && state.boardSync.status().snapshots === 0) {
    say('The board could not be read. Nothing here has been inferred, and no record is shown.');
    return;
  }
  await pollOnce(true);
  say(`${state.deals.size} deals`);
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
    // NO VALUE IS TAKEN FROM AN EVENT. What an event does here is name the base
    // for the next write to that cell, and — below — ask for a fresh snapshot.
    if (event.field) noteCellBase(cellKey(event.subject_id, event.field), event);
    if (!initial && state.feed.caught_up && event.actor !== state.selfActor && event.field === 'phase') {
      const deal = state.deals.get(event.subject_id);
      if (deal) showToast(`${actorName(event.actor)} moved ${deal.name}`);
    }
  }
  if (state.feed.caught_up && batchTouchesBoard(batch)) state.boardSync.requestRefresh('change-feed');
  state.receipts = ingestChangeEvents(state.receipts, batch, {
    dealName: (dealId) => state.deals.get(dealId)?.name || null,
    actorLabel: actorName,
  });
  renderReceipts();
  if (!document.querySelector('dialog[open]')) renderBoard();
}

/* ------------------------------------------------------------------- writing */

/** A write the server confirmed, put on screen and HELD against an open read. */
function confirmLocalWrite(dealId, patch) {
  const deal = state.deals.get(dealId) || null;
  if (deal) Object.assign(deal, patch);
  state.boardSync.noteLocalWrite(dealId, patch);
  state.boardSync.requestRefresh('after-write');
  return deal;
}

/**
 * Send one phase change — or put the one that was never answered back out.
 *
 * The key is minted per intended action, not per attempt, and the retained
 * request is re-sent unchanged: same value, same base, same key. That is what
 * makes a retry a replay at the server rather than a second write colliding
 * with the first.
 */
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

/**
 * The outcome write, and the fresh read it is built on.
 *
 * Three things make this NOT an ordinary follow-up. It carries a
 * `base_version`, which only a read taken AFTER the phase patch can supply —
 * a version captured when the dialog opened would name a row the move itself
 * has since changed. Its refusals are the concurrency ones: a version_conflict
 * goes to the crossed-edits path and a key_reuse is the kernel replaying an
 * answer, and neither is ever re-sent blind. And it is last, so a refusal here
 * leaves the card exactly where the server put it, and says so on its own
 * receipt rather than pretending the move failed.
 */
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
  // Every next-step control shares one operation for the deal, including moves.
  if (step.verb === 'set-next-step') operationKey = nextStepKey(step.args.deal);
  const send = FOLLOW_UP_SENDERS[step.verb];
  if (!send) return null;
  if (!pendingCommand(commandState, operationKey)) operations.set(operationKey, { kind: 'command', verb: step.verb, args: step.args, send, summary: step.summary });
  dock.record(operationKey, { summary: step.summary, status: 'sending', undo: false });
  const result = await performCommand({
    operationKey,
    args: step.args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  dock.record(operationKey, {
    summary: operations.get(operationKey).summary,
    status: result.status === 'blocked' ? 'unknown' : result.status,
    reason: result.message || null,
    retry: result.status === 'blocked' || result.retry, undo: false, request: result.request,
  });
  if (step.verb === 'set-next-step' && operationKey === nextStepKey(state.panelDeal) && state.panelDetail) {
    if (result.status === 'ok') nextDraft = null;
    syncNextForm();
    if (result.status === 'ok') await refreshPanel();
  }
  if (step.verb === 'resolve-conflict') await settleConflictChoice(step.args.conflict_id, result);
  return result;
}

/**
 * The whole Move, in the order the record layer's own contract implies.
 *
 * The phase patch first and alone, because it is what the person did. Only an
 * accepted answer opens the follow-ups: a refused or unanswered move must not
 * leave a note claiming a phase change that never happened.
 */
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

  // Only the two optional partner fields travel as extras. `deal`, `field` and
  // `value` are the kernel's own, and a retry replays the retained request, so
  // these ride on the first attempt or on none.
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
    if (message) { showToast(message); say(message); }
    return { ok: false, errors: [] };
  }
  if (result.superseded) {
    // The server accepted it and this board has since learned something newer
    // about the same cell. The value is NOT written to the row: the read
    // decides what it holds.
    state.boardSync.requestRefresh('after-write');
    renderBoard();
    const message = fieldWriteMessage(result, `${fieldLabel('phase')} on ${intent.name}`);
    if (message) showToast(message);
  } else {
    confirmLocalWrite(intent.deal, { phase: phaseStep.args.value });
    renderBoard();
    showToast(`${intent.name} moved to ${intent.to_label}`);
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
  if (message) showToast(message);
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
  showToast(result.outcome.message);
}

/* ----------------------------------------------------------- the two dialogs */

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
  // Today, as the calendar picker's own value. There is no typed-date box: the
  // ruling is a picker or nothing, and a default of today is what a person
  // closing a record almost always means.
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

/** Won value belongs to a won record and to nothing else, so it appears there. */
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
  if (intent) document.querySelector(`.kanban-card[data-id="${CSS.escape(intent.deal)}"]`)?.focus();
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

/* ------------------------------------------------------------- record panel */

let disposeEvidence = null;
let dateDraft = null;
function closeDateEditor() {
  dateDraft = null;
  const form = $('dealDateForm');
  form.reset();
  form.querySelector('button[type="submit"]').disabled = true;
  $('dealDateTitle').textContent = 'Add date';
  $('dealDateStatus').textContent = '';
  $('dealDateDialog').close();
}
let panelReadSequence = 0;
let contextReadSequence = 0;
// The next-step draft remembers the read behind each edited field. Pristine
// fields follow current reads; edited fields keep their original comparison.
let nextDraft = null;
const nextReads = new Set();
const stepValues = deal => ({text:noteText(deal.next_step),date:deal.next_date || ''});
function refusePanelDetail(error) {
  if (![401,403].includes(error?.status) && !['unauthorized','not_authenticated','forbidden'].includes(error?.payload?.error)) return false;
  ++panelReadSequence;
  ++contextReadSequence;
  state.panelDetail = null;
  nextDraft = null;
  closeDateEditor();
  disposeEvidence?.(); disposeEvidence = null;
  setContextOpenVisible(false);
  $('contextDrawer').close();
  $('contextDrawerBody').replaceChildren();
  $('panelTitle').textContent = 'Deal';
  $('panelBody').innerHTML = '<p role="status">Unavailable. <button class="btn" type="button" data-refresh-detail>Retry</button></p>';
  return true;
}
function syncNextForm(deal = null) {
  const form = $('detailNextForm');
  if (!form || !state.panelDeal) return;
  const pending = pendingCommand(commandState, nextStepKey(state.panelDeal));
  if (deal) {
    const values = stepValues(deal);
    if (!nextDraft || nextDraft.id !== deal.id) nextDraft = {id:deal.id,base:{...values},dirty:new Set(),comparison:null};
    for (const name of ['text','date']) {
      if (!nextDraft.dirty.has(name)) {
        nextDraft.base[name] = values[name];
        form.elements.namedItem(name).value = values[name];
      }
    }
  }
  for (const name of ['text','date']) {
    const field = form.elements.namedItem(name);
    field.disabled = Boolean(pending) || nextReads.has(state.panelDeal);
    if (pending) field.value = name === 'text' ? pending.request.text : pending.request.next_date || '';
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = pending?.status === 'pending' || nextReads.has(state.panelDeal);
  button.textContent = pending ? 'Check outcome' : 'Save next step';
  if (pending) $('detailNextStatus').textContent = pending.message || 'Saving next step…';
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
async function saveNextStep(id) {
  const key = nextStepKey(id);
  const pending = pendingCommand(commandState, key);
  if (pending?.status === 'pending' || nextReads.has(id)) return;
  const form = $('detailNextForm');
  const draft = nextDraft;
  if (!form || !draft) return;
  const proposed = {text:form.elements.namedItem('text').value.trim(),date:form.elements.namedItem('date').value};
  if (!pending && !proposed.text) { $('detailNextStatus').textContent = 'Enter a next step'; return; }
  if (!pending) {
    nextReads.add(id); syncNextForm();
    try {
      const fresh = await readDealDetail(id).catch(error => {
        if (state.panelDeal === id && nextDraft === draft) refusePanelDetail(error);
        throw error;
      });
      if (state.panelDeal !== id || nextDraft !== draft) return;
      const recorded = stepValues(fresh.deal);
      const crossed = ['text','date'].some(name => draft.dirty.has(name) && recorded[name] !== draft.base[name]);
      if (crossed) {
        // Choice buttons apply the comparison they display, even if a poll
        // reads another value before the person makes that choice.
        draft.comparison = recorded;
        $('detailNextStatus').innerHTML = `Next step changed since you began editing. Recorded: ${esc(recorded.text)} · ${esc(dateWords(recorded.date))}. Your draft: ${esc(proposed.text)} · ${esc(dateWords(proposed.date))}. <button type="button" class="btn" data-next-keep>Keep my draft</button> <button type="button" class="btn" data-next-recorded>Use recorded value</button>`;
        return;
      }
      // Unedited fields come from this read, even when no poll ran first.
      for (const name of ['text','date']) if (!draft.dirty.has(name)) proposed[name] = recorded[name];
    } catch {
      if (state.panelDeal === id && nextDraft === draft) $('detailNextStatus').textContent = 'Next step is updating. Your draft is saved here.';
      return;
    } finally { nextReads.delete(id); if (state.panelDeal === id) syncNextForm(); }
  }
  const args = pending?.request || {deal:id,text:proposed.text,next_date:proposed.date || null};
  const promise = runFollowUp(key,{verb:'set-next-step',args,summary:'Next step'});
  syncNextForm();
  const result = await promise;
  // The command receipt and readback outlive a closed or refused detail form.
  state.boardSync.requestRefresh('next-step');
  if (state.panelDeal !== id || !state.panelDetail || !form.isConnected) return;
  syncNextForm();
  $('detailNextStatus').textContent = result.status === 'ok' ? 'Next step confirmed' : result.message || 'Change not confirmed';
}
function fullRecordHtml(detail) {
  const section = (title, rows, describe) => `<section><h3>${title}</h3>${rows.map(row => `<p>${esc(describe(row))}</p>`).join('') || '<p>None recorded</p>'}</section>`;
  return `<details class="full-record" data-detail-read="full"><summary>Full record</summary>
    ${section('Open next actions',(detail.next_actions || []).filter(a => a.status === 'open'), a => `${a.description} · ${actorName(a.owner)} · ${dateWords(a.due_on)}`)}
    ${section('Premises',detail.premises || [], p => [p.label,p.address,p.suite,p.city,p.state,p.area_amount ? `${p.area_amount} ${p.area_basis || 'SF'}` : null].filter(Boolean).join(' · '))}
    ${section('Negotiation rounds',detail.negotiation_rounds || [], n => `Round ${n.round_no} · ${n.side} · ${n.rate_amount ?? 'Rate not captured'} ${n.rate_basis || ''} · ${n.term_months ? `${n.term_months} months` : 'Term not captured'}`)}
    ${section('Documents',detail.documents || [], d => `${String(d.sent_status || 'Prepared').replaceAll('_',' ')} · ${dateWords(d.prepared_at)}`)}
    ${section('Change history',detail.history || [], e => `${e.summary || `${fieldLabel(e.field)} changed`} · ${actorName(e.actor)} · ${dateWords(e.recorded_at)}`)}
  </details>`;
}
function detailHtml(detail) {
  const d = detail.deal;
  const parked = d.operating_state === 'parked';
  return `<div class="deal-freshness"><time id="detailUpdated" title="Last updated"></time><button class="btn icon-btn" type="button" data-refresh-detail aria-label="Refresh deal" title="Refresh">↻</button></div><p id="detailReadStatus" role="status"></p><div class="detail-actions"><div class="detail-controls"><label>Phase<select id="detailPhase">${COLUMNS.map(c => `<option value="${esc(c.slug)}"${c.value === d.phase ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label><label>Owner<select id="detailOwner"><option value="">Unassigned</option>${['joe','dell'].map(owner => `<option value="${owner}"${owner === d.owner ? ' selected' : ''}>${actorName(owner)}</option>`).join('')}</select></label></div><div data-detail-read="parking" data-parked="${parked}">${parked ? `<p>${esc(d.parking_note || 'Parked')}</p><button type="button" class="btn" data-revive="${esc(d.id)}">Revive</button>` : `<details class="park-options"><summary class="park-control">Park</summary><form id="detailParkForm"><label>Park reason<input name="reason" maxlength="500" required></label><button class="btn park-control" type="submit">Park deal</button></form></details>`}</div></div>${renderPhaseTimeline(detail)}${renderCriticalDates(detail)}${renderDealTimeline(detail,Date.now(),state.timelineFull)}
    <div class="detail-grid"><section>

      <h3>Next step</h3><p class="detail-next">${esc(noteText(d.next_step) || 'Next step pending')}</p>
      <form id="detailNextForm" class="detail-controls"><label>Next step<textarea name="text" rows="3">${esc(noteText(d.next_step))}</textarea></label><label>Due date<input name="date" type="date" value="${esc(d.next_date || '')}"></label><button class="btn" type="submit">Save next step</button></form><p id="detailNextStatus" role="status"></p>
      <button class="btn" type="button" data-jev-deal="${esc(d.id)}">Deal outlook</button><p data-jev-result></p><div data-detail-read="people"><h3>People</h3>${(detail.participants || []).map(p => `<p>${esc(p.name || actorName(p.actor))}</p>`).join('')}</div>
      <div data-detail-read="automatic">${autoHtml(d)}</div>

    </section><section>${fullRecordHtml(detail)}</section></div><div id="panelEvidence"></div>`;
}
async function refreshPanel() {
  const id = state.panelDeal;
  if (!id) return;
  const seq = ++panelReadSequence;
  try {
    const detail = await readDealDetail(id);
    if (state.panelDeal !== id || seq !== panelReadSequence) return;
    state.panelDetail = detail;
    setContextOpenVisible(true);
    updateDetailTimestamp();
    // A poll preserves drafts, expanded entries and the dialog scroll position.
    if (!$('panelBody').querySelector('.detail-grid')) paintPanel(detail);
    else {
      if (document.activeElement !== $('detailPhase')) $('detailPhase').value = columnByValue(detail.deal.phase)?.slug || '';
      if (document.activeElement !== $('detailOwner')) $('detailOwner').value = detail.deal.owner || '';
      const next = $('panelBody').querySelector('.detail-next');
      if (next) next.textContent = noteText(detail.deal.next_step) || 'Next step pending';
      syncNextForm(detail.deal);
      $('detailReadStatus').textContent = '';
      $('panelTitle').textContent = detail.deal.name;
      const template = document.createElement('div'); template.innerHTML = detailHtml(detail);
      for (const fresh of template.querySelectorAll('[data-detail-read]')) {
        const current = $('panelBody').querySelector(`[data-detail-read="${fresh.dataset.detailRead}"]`);
        if (!current) continue;
        if (fresh.dataset.detailRead === 'parking' && current.dataset.parked === 'false' && fresh.dataset.parked === 'false') continue;
        if (current.innerHTML !== fresh.innerHTML) {
          const expanded = new Set([...current.querySelectorAll('.deal-note details[open]')].map(n => n.closest('.deal-note').dataset.id));
          const focused = current.contains(document.activeElement) ? document.activeElement : null;
          const focusIdentity = focused?.dataset.detailFocus;
          const wasOpen = current.open;
          const dateOpens = new Set([...current.querySelectorAll('[data-date-id] details[open]')].map(n => n.closest('[data-date-id]').dataset.dateId));
          const chartScroll = current.querySelector('.timeline-viewport')?.scrollLeft;
          const oldScroll = current.scrollLeft;
          current.replaceWith(fresh);
          fresh.scrollLeft = oldScroll;
          if (wasOpen) fresh.open = true;
          if (chartScroll !== undefined) fresh.querySelector('.timeline-viewport').scrollLeft = chartScroll;
          fresh.querySelectorAll('[data-date-id]').forEach(n => { if (dateOpens.has(n.dataset.dateId)) n.querySelector('details').open = true; });
          fresh.querySelectorAll('.deal-note').forEach(n => { if (expanded.has(n.dataset.id)) n.querySelector('details').open = true; });
          if (focusIdentity) [...fresh.querySelectorAll('[data-detail-focus]')].find(n => n.dataset.detailFocus === focusIdentity)?.focus({preventScroll:true});
          else if (focused?.id) document.getElementById(focused.id)?.focus({preventScroll:true});
        }
      }
      const evidence = await loadEvidence(state.client, detail);
      if (state.panelDeal !== id || seq !== panelReadSequence) return;
      const root = $('panelEvidence');
      const html = renderEvidence(evidence);
      const evidenceTemplate = document.createElement('div'); evidenceTemplate.innerHTML = html;
      if (root.innerHTML !== evidenceTemplate.innerHTML) {
        const expanded = new Set([...root.querySelectorAll('details[open]')].map(n => n.querySelector('summary')?.textContent));
        disposeEvidence?.(); disposeEvidence = null;
        root.innerHTML = html;
        root.querySelectorAll('details').forEach(n => { if (expanded.has(n.querySelector('summary')?.textContent)) n.open = true; });
      }
    }
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
function centerCurrentPhase() {
  const rail = $('panelBody').querySelector('.phase-scroll');
  const phase = rail?.querySelector('[aria-current="step"]');
  if (phase) rail.scrollLeft = phase.offsetLeft - rail.offsetLeft - (rail.clientWidth-phase.clientWidth)/2;
}
function paintPanel(detail) {
  $('panelTitle').textContent = detail.deal.name;
  $('panelBody').innerHTML = detailHtml(detail);
  disposeEvidence?.();
  disposeEvidence = mountEvidence($('panelEvidence'), {client:state.client,detail});
  syncNextForm(detail.deal);
  updateDetailTimestamp();
  centerCurrentPhase();
}
async function openPanel(dealId, trigger) {
  selectDocRecord('deal', dealId);
  const panel = $('recordPanel');
  disposeEvidence?.(); disposeEvidence = null;
  setContextOpenVisible(false);
  state.panelDeal = dealId; state.panelDetail = null; nextDraft = null; state.timelineFull = true;
  const url = new URL(location.href); url.searchParams.set('deal',dealId); history.replaceState({},'',url);
  state.panelReturnTo = trigger?.closest('.kanban-card')?.dataset.id || dealId;
  $('panelTitle').textContent = state.deals.get(dealId)?.name || 'Deal';
  $('panelBody').innerHTML = '<p>Updating…</p>';
  if (!panel.open) panel.showModal();
  await refreshPanel();
}
function closePanel() {
  selectDocRecord('deal', null);
  pageDocContext?.release('getDeal');
  ++panelReadSequence;
  closeDateEditor();
  const id = state.panelReturnTo;
  disposeEvidence?.(); disposeEvidence=null;
  const url = new URL(location.href); url.searchParams.delete('deal'); history.replaceState({},'',url);
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
  else { showToast(fieldWriteMessage(result,'Operating state') || 'Change not confirmed'); state.boardSync.requestRefresh('operating-state'); }
  renderPendingWrites();
}

function setContextOpenVisible(visible) {
  const wrap = $('panelContextOpenWrap');
  if (wrap) wrap.hidden = !visible;
}

/* ------------------------------------------------- V5-UX-B04: context drawer */

/**
 * Read-only client/vendor/calendar context for whichever deal the record
 * panel currently holds. It never re-reads the deal itself — `state.panelDetail`
 * is the same `get-deal-room` answer the panel already painted — and its one
 * further read (the linked client's contact record) is made fresh every open,
 * because a fixed drawer that is opened, closed, and reopened without a page
 * reload must not go on showing a read that has since gone stale.
 */
async function openContextDrawer() {
  const dialog = $('contextDrawer');
  const detail = state.panelDetail;
  if (!dialog || !detail) return;
  const seq = ++contextReadSequence;
  $('contextDrawerBody').innerHTML = '<div class="state-block" data-state="loading"><h3>Updating…</h3></div>';
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  const dealId = state.panelDeal;
  const context = await loadDealContext(state.client, detail);
  // Same late-answer guard as the record panel: a slower client read must
  // never paint over a drawer the person has since moved on from.
  if (state.panelDeal !== dealId || seq !== contextReadSequence || !dialog.open) return;
  $('contextDrawerBody').innerHTML = contextDrawerSections(context, { dateLabel: dateWords })
    .map((section) => `<div class="panel-section"${section.state ? ` data-state="${esc(section.state)}"` : ''}>
      <h3>${esc(section.title)}</h3>${section.lines.map((line) => `<p>${esc(line)}</p>`).join('')}</div>`).join('');
}

/* -------------------------------------------------------- drag and keyboard */

/**
 * A lift takes a presence lease on this record's phase, exactly as a partner's
 * cursor in a cell does, so the other board can say "is editing" while a move is
 * being chosen. It is a courtesy signal and never a lock: nothing waits on it.
 */
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
    if (event.target.closest('button,input,select,a')) return;
    const card = event.target.closest('.kanban-card');
    if (card && card.dataset.dragging !== 'true') openPanel(card.dataset.id, card);
  });

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
    // Buttons own their Enter/Space action; the card's lift keys apply only to
    // the card itself, even while a keyboard move is already lifted.
    if (event.target.closest('button')) return;
    if (state.view === 'list' || card.classList.contains('parked-card')) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(card.dataset.id, card); } return; }
    const id = card.dataset.id;
    const deal = state.deals.get(id);
    if (!deal) return;
    const here = columnByValue(deal.phase);

    if ((event.key === 'Enter' || event.key === ' ') && state.lifted !== id) {
      // The card body lifts; nested controls already handled their own keys.
      event.preventDefault();
      state.lifted = id;
      state.target = here ? here.slug : COLUMNS[0].slug;
      leasePhase(id);
      announce(`${deal.name} lifted from ${columnLabel(deal.phase)}. Use the arrow keys to choose a column, Enter to drop, Escape to cancel.`);
      renderBoard();
      document.querySelector(`.kanban-card[data-id="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    if (state.lifted !== id) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      state.lifted = null;
      state.target = null;
      announce(`Move cancelled. ${deal.name} stays in ${columnLabel(deal.phase)}.`);
      renderBoard();
      document.querySelector(`.kanban-card[data-id="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    const next = keyboardTarget(state.target, event.key, COLUMNS);
    if (next) {
      event.preventDefault();
      state.target = next;
      announce(`${columnBySlug(next).label} selected. Enter drops ${deal.name} here.`);
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

/* -------------------------------------------------------------------- wiring */

function wire() {
  wireBoard();

  $('boardChips')?.addEventListener('click', (event) => {
    const chip = event.target.closest('button[data-filter]');
    if (!chip) return;
    state.personalScope = false; state.filter = chip.dataset.filter;
    renderChips();
    renderBoard();
    say(`Showing ${state.filter === 'all' ? 'all owners' : actorName(state.filter)} on the board.`);
  });

  document.addEventListener('click', async (event) => {
    const outlook = event.target.closest('[data-jev-deal]');
    if(outlook) { const id=state.panelDeal; outlook.disabled=true; try { const answer=await state.client.getJevDealReading(id); if(state.panelDeal===id && outlook.isConnected) $('panelBody').querySelector('[data-jev-result]').textContent=dealInsightLines(answer).join(' · '); } catch { if(outlook.isConnected) $('panelBody').querySelector('[data-jev-result]').textContent=dealInsightLines(null).join(' · '); } finally { if(outlook.isConnected) outlook.disabled=false; } return; }
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
    if (card && !event.target.closest('button')) { openPanel(card.dataset.id, card); return; }
    if (openDeal) {
      openPanel(openDeal.dataset.openDeal, null);
    }
  });

  $('recordPanel')?.addEventListener('cancel', (event) => { event.preventDefault(); closePanel(); });
  $('panelClose')?.addEventListener('click', closePanel);
  $('dealDateCancel').onclick = closeDateEditor;
  $('dealDateDialog').addEventListener('cancel', closeDateEditor);
  $('dealDateForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form);
    const draft = dateDraft;
    if (!draft || !$('dealDateDialog').open || state.panelDeal !== draft.deal || state.panelDetail?.deal.id !== draft.deal) return;
    const {deal:id, kind} = draft;
    // Lost responses retain exactly the same request and key in the command dock.
    const args = {deal:id,kind,due_on:String(values.get('date')),source:String(values.get('evidence'))};
    form.querySelector('button[type="submit"]').disabled = true;
    const result = await runFollowUp(`critical-date:${id}:${kind}`,{verb:'add-critical-date',args,summary:'Date added'});
    if (dateDraft === draft && $('dealDateDialog').open) {
      form.querySelector('button[type="submit"]').disabled = false;
      if (result?.status === 'ok') closeDateEditor();
      else $('dealDateStatus').textContent = 'Date not confirmed';
    }
    if (result?.status === 'ok' && state.panelDeal === id && state.panelDetail?.deal.id === id) await refreshPanel();
  });

  $('receiptsOpen')?.addEventListener('click', () => {
    renderReceipts();
    document.dispatchEvent(new Event('doctorcre:open-today'));
  });

  $('panelContextOpen')?.addEventListener('click', () => { openContextDrawer(); });
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
  });

  $('conflictCancel')?.addEventListener('click', () => $('conflictDialog')?.close());
  $('conflictForm')?.addEventListener('submit', (event) => { event.preventDefault(); resolveConflictChoice(); });

  $('retryRead')?.addEventListener('click', () => loadBoard());
  const changeView = view => {
    state.view = view;
    const url = new URL(location.href); url.searchParams.set('view',view); history.replaceState({},'',url);
    $('boardView').setAttribute('aria-pressed', String(view === 'board'));
    $('listView').setAttribute('aria-pressed', String(view === 'list')); renderBoard();
  };
  $('boardView').addEventListener('click', () => changeView('board'));
  $('listView').addEventListener('click', () => changeView('list'));
  $('parkedToggle').addEventListener('click', () => { state.parkedOpen = !state.parkedOpen; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); renderBoard(); });
  $('kanban').addEventListener('toggle', e => { if(e.target.classList.contains('parked-lane')) { state.parkedOpen=e.target.open; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); } },true);
  $('panelBody').addEventListener('click', e => {
    if (e.target.closest('[data-refresh-detail]')) refreshPanel();
    const add = e.target.closest('[data-add-date]');
    if (add) {
      if (!state.panelDetail || state.panelDetail.deal.id !== state.panelDeal) return;
      const definition = DATE_KINDS.find(d => d.kind === add.dataset.addDate);
      $('dealDateTitle').textContent = definition.label;
      dateDraft = {deal:state.panelDeal,kind:definition.kind};
      const form = $('dealDateForm'); form.reset();
      form.querySelector('button[type="submit"]').disabled = false;
      $('dealDateStatus').textContent = ''; $('dealDateDialog').showModal();
    }
    const day = e.target.closest('[data-timeline-day]');
    if (day) {
      const entry = [...$('panelBody').querySelectorAll('.timeline-entry')].find(n => n.querySelector('time')?.dateTime === day.dataset.timelineDay);
      const target = entry || [...$('panelBody').querySelectorAll('[data-countdown]')].find(n => n.dataset.countdown === day.dataset.timelineDay)?.closest('.critical-date');
      target?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}); (entry || target?.querySelector('summary'))?.focus({preventScroll:true});
    }
    if (e.target.closest('[data-next-keep]') && nextDraft?.comparison) {
      nextDraft.base = {...nextDraft.comparison};
      nextDraft.comparison = null;
      $('detailNextStatus').textContent = 'Draft reviewed against the recorded value. Save to apply it.';
    }
    if (e.target.closest('[data-next-recorded]') && nextDraft?.comparison) {
      const recorded = nextDraft.comparison;
      nextDraft.comparison = null;
      nextDraft.dirty.clear();
      syncNextForm({id:nextDraft.id,next_step:recorded.text,next_date:recorded.date});
      $('detailNextStatus').textContent = 'Recorded next step restored';
    }
  });
  $('panelBody').addEventListener('input', e => {
    if (e.target.closest('#detailNextForm') && nextDraft) nextDraft.dirty.add(e.target.name);
  });
  $('panelBody').addEventListener('change', async e => {
    const id = state.panelDeal;
    if (e.target.id === 'timelineRange') {
      state.timelineFull = e.target.value === 'full';
      const current = $('panelBody').querySelector('[data-detail-read="timeline"]');
      current.outerHTML = renderDealTimeline(state.panelDetail,Date.now(),state.timelineFull);
      $('timelineRange').focus({preventScroll:true});
    }
    if (e.target.id === 'detailPhase') {
      const intent = moveIntent(state.deals.get(id), e.target.value);
      if (intent) { const result = await sendPhaseWrite(id,intent.value); if(result.status === 'ok' && !result.superseded) { confirmLocalWrite(id,{phase:result.request?.value ?? intent.value}); await refreshPanel(); } else if(result.conflict) showConflict(result.conflict); else showToast(fieldWriteMessage(result,'Phase') || 'Change not confirmed'); renderPendingWrites(); }
    }
    if (e.target.id === 'detailOwner') { const value = e.target.value || null; const result = await sendFieldWrite(id,'owner',value); if(result.status === 'ok' && !result.superseded) confirmLocalWrite(id,{owner:result.request.value}); else if(result.conflict) showConflict(result.conflict); else showToast(fieldWriteMessage(result,'Owner') || 'Change not confirmed'); renderPendingWrites(); }
  });
  $('panelBody').addEventListener('submit', async e => {
    e.preventDefault(); const id=state.panelDeal; const form = new FormData(e.target);
    if (e.target.id === 'detailParkForm') await setOperatingState(id,{state:'parked',reason:'other',note:String(form.get('reason'))});
    if (e.target.id === 'detailNextForm') await saveNextStep(id);
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
      else if (entry?.args) runFollowUp(operationKey, { verb: entry.verb, args: entry.args, summary: entry.summary });
    },
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.kind === 'field') retryFieldWrite(operationKey);
      else if (entry?.kind === 'outcome-read') return runOutcomeWrite(operationKey, entry.step, entry.intent);
      else if (entry?.args && entry?.send) {
        runFollowUp(operationKey, { verb: entry.verb, args: entry.args, summary: entry.summary });
      }
    },
    onUndo: null,
  });
  dock.mount();
}

/* ------------------------------------------------------------------------ boot */

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
    // Only a snapshot that is still current reaches this callback, and it
    // already carries any value a confirmed local write is holding.
    applyBoard: (board) => { applyBoardSnapshot(board); },
    onStatus: renderStatus,
  });
  $('boardView').setAttribute('aria-pressed',String(state.view === 'board'));
  $('listView').setAttribute('aria-pressed',String(state.view === 'list'));
  await loadBoard();
  setInterval(() => { refreshPanel(); }, BOARD_REFRESH_MS);
  setInterval(() => updateCountdowns($('panelBody')),1000);
  setInterval(() => { pollOnce().catch(() => { /* the badge already says the feed failed */ }); }, POLL_MS);
  setInterval(() => state.boardSync.requestRefresh('periodic'), BOARD_REFRESH_MS);
  // Home record links address a deal directly, including records outside the
  // current board scope. The existing detail read enforces identity and shows
  // failures; its outcome must not hold up board/feed polling.
  const linkedDeal = incomingScope.get('deal');
  if (linkedDeal) openPanel(linkedDeal);
}

if (globalThis.document) boot();

export { state };
