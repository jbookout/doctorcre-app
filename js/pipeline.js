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
import { createCommandState, performCommand } from './command-feedback.mjs';
import { createFixtureClient } from './fixture-client.js';
import { createLiveClient } from './live-client.js';
import { deploymentIdentity, resolveDealroomBoot } from './boot-mode.js';
import { ACTOR_LABEL } from './client.js';
import { mountDocDock, mountNotificationBadge, mountPrefs } from './shell.js';
import { formatCalendarDate } from './visual-system.js';
import {
  createBoardSync, batchTouchesBoard, SYNC_STATES,
} from './board-sync.mjs';
import {
  cellKey, createFieldWriteState, performFieldWrite, unresolvedFieldWrites,
  pendingFieldWrite, fieldWriteMessage, nextCellBase,
} from './field-write-reconciliation.mjs';
import {
  escapeText, fieldLabel, ingestChangeEvents, receiptViews,
  receiptListHtml, receiptsSignature, createFeedProgress, observeChangeBatch,
  createUndoState, performUndo,
} from './change-receipts.mjs';
import {
  CLOSED_SLUG, COLUMNS, COMPLETION_CAPTIONS, closedColumnCaption, columnBySlug, columnByValue,
  columnLabel, completionPlan, contextDrawerSections, filterDeals, groupByColumn, keyboardTarget,
  loadDealContext, moveIntent, moveSummary, moveTitle, orderColumn, presenceChip,
  recordPanelSections, typeFilters,
} from './pipeline-model.js';
import { uuidv4 } from './uuid.js';

const POLL_MS = 1400;
/** The ceiling on how long this board goes without ASKING again. Not a freshness claim. */
const BOARD_REFRESH_MS = 15000;

const $ = (id) => document.getElementById(id);
const esc = escapeText;
const actorName = (slug) => ACTOR_LABEL[slug] || slug || 'Unassigned';

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
  fieldWrites: createFieldWriteState(),
  presence: [],
  receipts: [],
  undo: createUndoState(),
  feed: createFeedProgress(),
  receiptSignature: null,
  filter: 'all',
  /** Ids, never rows: a lifted card, a chosen column, an open panel, a move in hand. */
  lifted: null,
  target: null,
  panelDeal: null,
  panelPinned: false,
  panelReturnTo: null,
  intent: null,
  boardStatus: 'starting',
  unplaced: 0,
};

let commandState = createCommandState();
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

function cardHtml(deal) {
  const label = columnLabel(deal.phase);
  const chip = presenceChip(state.presence, deal.id, {
    selfActor: state.selfActor, field: 'phase', actorLabel: actorName,
  });
  const pending = pendingFieldWrite(state.fieldWrites, cellKey(deal.id, 'phase'));
  return `<article class="kanban-card" data-id="${esc(deal.id)}" data-type="${esc(deal.type || 'other')}"
    draggable="true" tabindex="0"${pending ? ' data-pending="true"' : ''}${state.lifted === deal.id ? ' data-lifted="true"' : ''}
    aria-label="${esc(deal.name)}, ${esc(label)}. Press Enter to lift and move.">
    <h4><button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(deal.name)}</button></h4>
    <div class="work-meta">
      <span class="kanban-lane-label">${esc(deal.type || 'Deal')}</span>
      <span class="owner"><span class="avatar" data-partner="${esc(deal.owner || '')}" aria-hidden="true">${esc(actorName(deal.owner).slice(0, 1))}</span><span>${esc(actorName(deal.owner))}</span></span>
      ${deal.attention ? '<span class="pin" aria-label="Flagged for attention">★</span>' : ''}
    </div>
    <p class="small">${esc(deal.next_step || 'No next step recorded')}</p>
    ${chip ? `<p class="presence-chip">${esc(chip)}</p>` : ''}
  </article>`;
}

function renderBoard() {
  const board = $('kanban');
  if (!board) return;
  const rows = filterDeals([...state.deals.values()], state.filter);
  const grouped = groupByColumn(rows);
  state.unplaced = grouped.unplaced.length;
  board.innerHTML = grouped.columns.map((column) => {
    const cards = orderColumn(column.deals);
    const chosen = state.lifted && state.target === column.slug;
    return `<section class="kanban-column glass" data-column="${esc(column.slug)}"${chosen ? ' data-drop="true"' : ''}
      aria-label="${esc(column.label)}, ${cards.length} cards">
      <h3>${esc(column.label)}<small>${cards.length}</small></h3>
      ${cards.map(cardHtml).join('')}
    </section>`;
  }).join('');
  const note = $('boardNote');
  if (note) {
    note.hidden = state.unplaced === 0;
    note.textContent = state.unplaced
      ? `${state.unplaced} record(s) hold a phase this board has no column for; they are not shown and nothing was guessed about them.`
      : '';
  }
  renderPendingWrites();
}

function renderChips() {
  const bar = $('boardChips');
  if (!bar) return;
  const filters = typeFilters([...state.deals.values()]);
  if (!filters.some((entry) => entry.value === state.filter)) state.filter = 'all';
  bar.innerHTML = filters.map((entry) => `<button class="chip" type="button" data-filter="${esc(entry.value)}"
    aria-pressed="${String(entry.value === state.filter)}">${esc(entry.label)}</button>`).join('');
}

function renderStatus(status) {
  state.boardStatus = status.state;
  const live = state.mode === 'live';
  const label = status.state === SYNC_STATES.OFFLINE ? 'Offline'
    : status.state === SYNC_STATES.ERROR ? 'Board view error'
    : status.state === SYNC_STATES.RECONNECTING ? (live ? 'Reconnecting' : 'Fixture unavailable')
    : status.state === SYNC_STATES.READY ? (live ? 'Read from the record layer' : 'Fixture ready')
    : 'Reading the record…';
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
      ? `${state.deals.size} record(s) from the last board read · ${deploymentIdentity(state.mode).detail}`
      : `Reading the record layer… · ${deploymentIdentity(state.mode).detail}`;
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
}

async function loadBoard() {
  const outcome = await state.boardSync.refreshBoard({ reason: 'load-board' });
  if (!outcome.applied && state.boardSync.status().snapshots === 0) {
    say('The board could not be read. Nothing here has been inferred, and no record is shown.');
    return;
  }
  await pollOnce(true);
  say(`${state.deals.size} record(s) read from the record layer.`);
}

async function pollOnce(initial = false) {
  const outcome = await state.boardSync.pollChanges();
  if (!outcome.applied) return;
  const result = outcome.changes;
  state.presence = result.presence || [];
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
async function sendPhaseWrite(dealId, value, extra = null) {
  const cell = cellKey(dealId, 'phase');
  const result = await performFieldWrite({
    deal: dealId,
    field: 'phase',
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
  'add-deal-note': (request) => state.client.addDealNote(request),
  'set-next-step': (request) => state.client.setNextStep(request),
  'add-critical-date': (request) => state.client.addCriticalDate(request),
};

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
      summary: step.summary, status: 'failed', undo: false,
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
  const send = FOLLOW_UP_SENDERS[step.verb];
  if (!send) return null;
  operations.set(operationKey, { kind: 'command', verb: step.verb, args: step.args, send, summary: step.summary });
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
    summary: step.summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
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
  operations.set(cell, { kind: 'field', deal: intent.deal, value: phaseStep.args.value, summary: moveSummary(intent) });
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

  const token = uuidv4();
  for (const step of followUps) {
    const operationKey = `${step.verb}:${intent.deal}:${token}`;
    if (step.verb === 'update-deal') await runOutcomeWrite(operationKey, step, intent);
    else await runFollowUp(operationKey, step);
  }
  return { ok: true, errors: [] };
}

async function retryFieldWrite(cell) {
  const entry = pendingFieldWrite(state.fieldWrites, cell);
  if (!entry) { renderBoard(); return; }
  const { deal, value } = entry.request;
  const row = state.deals.get(deal);
  const result = await sendPhaseWrite(deal, value);
  const subject = `${fieldLabel('phase')} on ${row?.name || 'this record'}`;
  dock.record(cell, {
    summary: `${row?.name || 'This record'} → ${columnLabel(value)}`,
    status: result.status, reason: fieldWriteMessage(result, subject) || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.status === 'ok' && !result.superseded) confirmLocalWrite(deal, { phase: value });
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
  $('completionFrom').textContent = `Cancel leaves it in ${intent.from_label}.`;
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
  const display = (value) => (typeof value === 'string' ? columnLabel(value) : value ?? '(empty)');
  $('conflictTitle').textContent = `Choose the value for ${fieldLabel(conflict.field)}`;
  $('conflictChoices').innerHTML = ['a', 'b'].map((side) => `<label class="field">
    <input type="radio" name="winner" value="${side}"${side === 'a' ? ' checked' : ''}>
    <span>${esc(actorName(conflict[side].actor))}: ${esc(display(conflict[side].value))}</span></label>`).join('');
  dialog.dataset.conflict = conflict.conflict_id;
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

async function resolveConflictChoice() {
  const dialog = $('conflictDialog');
  const conflictId = dialog?.dataset.conflict;
  if (!conflictId) return;
  const winner = dialog.querySelector('input[name="winner"]:checked')?.value || 'a';
  dialog.close();
  await state.client.resolveConflict({ conflict_id: conflictId, winner, idempotency_key: uuidv4() });
  state.boardSync.requestRefresh('after-conflict');
  showToast('Conflict resolved with both values kept in history');
}

/* ------------------------------------------------------------- record panel */

async function openPanel(dealId, trigger) {
  const panel = $('recordPanel');
  if (!panel) return;
  state.panelDeal = dealId;
  state.panelDetail = null;
  state.panelReturnTo = trigger?.closest('.kanban-card')?.dataset.id || dealId;
  panel.hidden = false;
  $('panelTitle').textContent = state.deals.get(dealId)?.name || 'Record';
  $('panelBody').innerHTML = '<div class="state-block" data-state="loading"><h3>Reading the record…</h3></div>';
  setContextOpenVisible(false);
  $('panelClose')?.focus();
  let detail = null;
  try {
    detail = await state.client.getDeal(dealId);
  } catch {
    $('panelBody').innerHTML = '<div class="state-block" data-state="offline"><h3>This record could not be read. Nothing here has been inferred.</h3></div>';
    return;
  }
  // The panel may have moved on while the read was open; a late answer never
  // paints over a record the person has since opened.
  if (state.panelDeal !== dealId) return;
  state.panelDetail = detail;
  $('panelTitle').textContent = detail.deal?.name || 'Record';
  $('panelBody').innerHTML = recordPanelSections(detail, { actorLabel: actorName, dateLabel: dateWords })
    .map((section) => `<div class="panel-section"${section.state ? ` data-state="${esc(section.state)}"` : ''}>
      <h3>${esc(section.title)}</h3>${section.lines.map((line) => `<p>${esc(line)}</p>`).join('')}</div>`).join('');
  // V5-UX-B04: the context drawer reuses this same read, so it opens only
  // once there is a detail to open it on.
  setContextOpenVisible(true);
}

function closePanel() {
  const panel = $('recordPanel');
  if (!panel || panel.hidden) return;
  if (state.panelPinned) return;
  panel.hidden = true;
  const returnTo = state.panelReturnTo;
  state.panelDeal = null;
  state.panelDetail = null;
  state.panelReturnTo = null;
  setContextOpenVisible(false);
  if (returnTo) document.querySelector(`.kanban-card[data-id="${CSS.escape(returnTo)}"]`)?.focus();
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
  $('contextDrawerBody').innerHTML = '<div class="state-block" data-state="loading"><h3>Reading the record…</h3></div>';
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  const dealId = state.panelDeal;
  const context = await loadDealContext(state.client, detail);
  // Same late-answer guard as the record panel: a slower client read must
  // never paint over a drawer the person has since moved on from.
  if (state.panelDeal !== dealId || !dialog.open) return;
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
  announce(`${intent.name} dropped in ${intent.to_label}.`);
  openCompletion(intent);
}

function wireBoard() {
  const board = $('kanban');
  if (!board) return;

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
    const id = card.dataset.id;
    const deal = state.deals.get(id);
    if (!deal) return;
    const here = columnByValue(deal.phase);

    if ((event.key === 'Enter' || event.key === ' ') && state.lifted !== id) {
      // The card title is its own button and opens the record; the card body is
      // what lifts, so Enter on the title must not do both.
      if (event.target.closest('.card-open')) return;
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
    state.filter = chip.dataset.filter;
    renderChips();
    renderBoard();
    say(`Showing ${state.filter === 'all' ? 'every deal type' : state.filter} on the board.`);
  });

  document.addEventListener('click', (event) => {
    const open = event.target.closest('button[data-open]');
    if (open) { openPanel(open.dataset.open, open); return; }
    const retry = event.target.closest('button[data-retry-write]');
    if (retry) { retryFieldWrite(retry.dataset.retryWrite); return; }
    const undo = event.target.closest('button[data-undo]');
    if (undo) { runUndo(undo.dataset.undo); return; }
    const openDeal = event.target.closest('button[data-open-deal]');
    if (openDeal) {
      $('receiptsDialog')?.close();
      openPanel(openDeal.dataset.openDeal, null);
    }
  });

  $('panelClose')?.addEventListener('click', () => { state.panelPinned = false; closePanel(); });
  $('panelPin')?.addEventListener('click', () => {
    state.panelPinned = !state.panelPinned;
    $('panelPin').setAttribute('aria-pressed', String(state.panelPinned));
    $('recordPanel')?.setAttribute('data-pinned', String(state.panelPinned));
  });

  $('receiptsOpen')?.addEventListener('click', () => {
    renderReceipts();
    const dialog = $('receiptsDialog');
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  });
  $('receiptsClose')?.addEventListener('click', () => $('receiptsDialog')?.close());

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

  globalThis.addEventListener?.('online', () => state.boardSync.setOnline(true));
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
      else if (entry?.args) runFollowUp(operationKey, { verb: entry.verb, args: entry.args, summary: entry.summary });
    },
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.kind === 'field') retryFieldWrite(operationKey);
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
  mountDocDock('Deals');
  mountDock();
  wire();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: '', search: '' });
  state.client = resolved.mode === 'live' ? createLiveClient() : await createFixtureClient(resolved.options);
  mountNotificationBadge(state.client);
  state.mode = state.client.mode;
  state.selfActor = state.client.selfActor || null;
  state.boardSync = createBoardSync({
    readBoard: () => state.client.getBoard({ workspace: 'all' }),
    readChanges: (cursor) => state.client.getChanges(cursor),
    // Only a snapshot that is still current reaches this callback, and it
    // already carries any value a confirmed local write is holding.
    applyBoard: (board) => { applyBoardSnapshot(board); },
    onStatus: renderStatus,
  });
  await loadBoard();
  setInterval(() => { pollOnce().catch(() => { /* the badge already says the feed failed */ }); }, POLL_MS);
  setInterval(() => state.boardSync.requestRefresh('periodic'), BOARD_REFRESH_MS);
}

if (globalThis.document) boot();

export { state };
