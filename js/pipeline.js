import { createMcpRequests } from './mcp-requests.mjs';
import { mountWatchControl } from './ui-watches.generated.js';
import { workCard } from './work-card.js';
import {
  autoHtml, automaticPhaseReceipt, dealDueDate, dealNextStep, dealTypeFacts, lossReasonLabel, renderDealFacts, renderDealItemButton,
  renderDealItems, renderEndedDealList, renderInvoiceClose, renderOverdueFlag, renderPhaseReceipt,
} from './deal-items.js';
import { mountDealItemSheet } from './deal-item-sheet.js';
import { OWNER_FILTERS } from './owner-filters.js';
import { engagementWriterFor } from './prospect-engagement.mjs';
import { showToast } from './toast.js';
import { renderDealVendors } from './deal-vendors.js';
import { openEngineClientWebsite, renderClientPortalLink, saveEngineClientWebsite } from './client-portal-link.js';
import { sessionFetch } from './private-session.js';
import { pageDocContext, selectDocRecord, setDocFilters, publishDocRead } from './doc-context.js';
import { createCommandDock } from './command-dock.js';
import { readWithDeadline } from './auto-refresh.mjs';
import { fetchRead } from './current-read.mjs';
import { preserveBoardFocus } from './board-focus.mjs';
import { performCommand, pendingCommand } from './command-feedback.mjs';
import { createLiveClient, dealTypeLabel } from './live-client.js';
import { emailSubject, emailPlaceholderText, loadEvidence, renderCorrespondence, renderEvidence } from './correspondence.js';
import { dealsSaveToEngine, deploymentIdentity, resolveDealroomBoot } from './boot-mode.js';
import { ACTOR_LABEL, FACT_TERMS, authorLabel } from './client.js';
import { mountNotificationBadge, mountPrefs } from './shell.js';
import { formatCalendarDate } from './visual-system.js';
import { BUSINESS_TIME_ZONE, businessDay } from './business-date.js';
import {
  createBoardSync, batchTouchesBoard, HEALTH, SYNC_STATES,
} from './board-sync.mjs';
import {
  cellKey, performFieldWrite, unresolvedFieldWrites, fieldWriteMessage, nextCellBase, prepareAutomaticPhaseUndo,
} from './field-write-reconciliation.mjs';
import {
  escapeText, fieldLabel, readableValue, ingestChangeEvents, receiptViews, receiptListHtml,
  receiptsSignature, createFeedProgress, observeChangeBatch, performUndo,
} from './change-receipts.mjs';
import {
  CLOSED_SLUG, COLUMNS, OPEN_COLUMNS, COMPLETION_CAPTIONS, closedColumnCaption, columnBySlug, columnByValue,
  boardHeadline, columnLabel, completionPlan, contextDrawerSections, groupByColumn, keyboardTarget,
  loadDealContext, moveIntent, moveSummary, moveTitle, noteText, dealName,
} from './pipeline-model.js';
import { isClosedDeal, localDeals, needsAttention, overdueLabel, overdueSince } from './deal-review-model.js';
import { lostDeals, closedDeals, urgencyOrder, concise, invoiceClose, isPhaseMoveReceipt, isEngineDealDetail, prepareDealDetail, dealStepVersion, nationalMarketLabel, ordinaryOpenSteps, partnerDealStep, PARKING_REASONS, PHASE_TRIGGERS } from './local-deals-model.js';
import { sourceTime, stepOriginLabel } from './email-source-line.js';
import {
  mountActivityAttribution, renderDealTimeline, renderDealUpdates, renderCriticalDates,
  dealTimeline, engineTimelineEntries, renderImportedDealHistory, criticalDateLabel, dateCaption, calendarDay, CRITICAL_DATE_OPTIONS,
} from './deal-timeline.js';
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
  panelStepId: null,
  panelReturnTo: null,
  intent: null,
  boardStatus: 'starting',
  nextDealSaves: false,
  boardFromEngine: false,
  prospectCount: null,
  unplaced: 0,
};

let prospects;

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

const automaticPhase = prepareAutomaticPhaseUndo({
  state, performCommand, newKey: uuidv4, render: renderPhaseUndo, report: announce, refreshedMessage: 'The deal page was refreshed.',
});

function detailPhaseMoveHtml(detail) {
  const deal = detail.deal;
  if (!isEngineDealDetail(detail)) return isClosedDeal(deal) ? '' : autoHtml(deal);
  const receipt = automaticPhaseReceipt(deal, automaticPhase.feedback(deal.id), {
    showEngineMoves: isPhaseMoveReceipt(deal.phase_change), canUndo: detail.next_deal_saves === true,
  });
  return renderPhaseReceipt(deal, receipt, '');
}

function renderPhaseUndo() {
  renderBoard();
  const host = $('panelBody').querySelector('[data-phase-move]');
  if (!host || !state.panelDetail) return;
  const html = detailPhaseMoveHtml(state.panelDetail);
  if (host.innerHTML === html) return;
  const focused = host.contains(document.activeElement);
  host.innerHTML = html;
  if (focused) (host.querySelector('button') || $('panelBody').querySelector('[data-refresh-detail]'))?.focus({ preventScroll: true });
}

const dealTitle = (deal) => dealName(deal.name);
function parkingAttributionHtml(deal) {
  if (deal.parked_automatically === true) return '<p>Parked automatically</p>';
  const parker = Object.hasOwn(ACTOR_LABEL, deal.parked_by) ? actorName(deal.parked_by) : '';
  return parker ? `<p>Parked by ${esc(parker)}</p>` : '';
}
function parkingNoteText(deal) {
  return deal.parking_note === 'unverified import — 2026-10-01 records audit; revive if active' ? 'Imported Oct 1, not yet confirmed. Revive if still active.' : deal.parking_note;
}
function parkingDetailsHtml(deal) {
  const note = parkingNoteText(deal);
  const reason = PARKING_REASONS.get(deal.parking_reason);
  const timestamp = deal.parked_at ? new Date(deal.parked_at) : null;
  const day = Number.isFinite(timestamp?.getTime()) ? businessDay(timestamp) : null;
  return (reason ? `<p>${reason}</p>` : '<p>Parked</p>')
    + (note ? `<p class="note-original">${esc(note)}</p>` : '')
    + (day ? `<p>Parked on <time datetime="${day}">${esc(dateWords(day))}</time></p>` : '')
    + parkingAttributionHtml(deal);
}
function parkFormHtml(nextDealSaves) {
  const fields = nextDealSaves
    ? `<label>Park reason<select name="reason" required><option value="">Choose a reason</option>${Array.from(PARKING_REASONS, ([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label>Parking note (optional)<textarea name="note" maxlength="500"></textarea></label>`
    : '<label>Park reason<input name="reason" maxlength="500" required></label>';
  return `<details class="park-options"><summary class="park-control">Park</summary><form id="detailParkForm">${fields}<button class="btn park-control" type="submit">Park deal</button></form></details>`;
}
function dealOwnerFirstSteps(deal, actions) {
  const steps = ordinaryOpenSteps(actions);
  const ownerStep = steps.find(step => step.owner === deal.owner);
  return ownerStep ? [ownerStep, ...steps.filter(step => step !== ownerStep)] : steps;
}
function listNextStepHtml(deal) {
  const [step] = dealOwnerFirstSteps(deal, deal.open_actions);
  if (!step) return '<p class="deal-list-next-step">No next step set</p>';
  return `<p class="deal-list-next-step"><span>${esc(step.description.trim())}</span> · ${dueDateHtml(calendarDay(step.due_on), businessDay())}</p>`;
}
function dealAttentionHtml(deal) {
  return state.boardFromEngine && deal.attention === true ? '<span class="deal-attention-label">Needs attention</span>' : '';
}
function cardAttentionHtml(deal) {
  const steps = ordinaryOpenSteps(deal.open_actions ?? []);
  const step = steps.find(step => step.owner === deal.owner);
  const legacyDue = !state.boardFromEngine && !steps.length && noteText(deal.next_step).trim() ? deal.next_date : null;
  const due = step?.due_on ?? legacyDue;
  const late = dealDueDate(due, businessDay())?.late;
  const reasons = [deal.attention === true && 'Flagged by a partner', late && `Step ${late}`].filter(Boolean);
  if (!reasons.length) return '';
  const reason = esc(reasons.join('. '));
  const reasonId = `board-attention-${esc(deal.id)}`;
  return `<button class="deal-board-attention" type="button" aria-label="Needs attention: ${reason}" aria-expanded="false" aria-controls="${reasonId}"><span class="deal-board-badge">Needs attention</span></button>
    <span class="deal-board-reason" id="${reasonId}" hidden>${reason}</span>`;
}
function cardHtml(deal) {
  const parked = deal.operating_state === 'parked';
  const pending = pendingCommand(state.fieldWrites, cellKey(deal.id, 'phase'));
  const moveAttrs = parked ? 'tabindex="-1"' : `draggable="true" tabindex="0" data-phase="${esc(deal.phase)}"${pending ? ' data-pending="true"' : ''}${state.lifted === deal.id ? ' data-lifted="true"' : ''}`;
  const parkingLabel = deal.parking_reason === 'other' ? 'Parked' : PARKING_REASONS.get(deal.parking_reason) || 'Parked';
  const badge = parked ? `<span class="deal-board-badge">${parkingLabel}</span>` : cardAttentionHtml(deal);
  return workCard({ variant: 'tile', className: `kanban-card${parked ? ' parked-card' : ''}`, heading: 'h4',
    attributes: `data-id="${esc(deal.id)}" ${moveAttrs} aria-label="${esc(dealTitle(deal))}, ${esc(parked ? 'Parked' : columnLabel(deal.phase))}"`,
    title: `<button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(dealTitle(deal))}</button>`,
    meta: `<span class="owner">${esc(actorName(deal.owner))}</span>${badge}` });
}
function legacyRowStepHtml(deal) {
  const nextStep = noteText(deal.next_step);
  const today = todayIso();
  const overdue = overdueLabel(overdueSince(deal, today), today);
  return `<p class="next-line" title="${esc(nextStep)}">${nextStep.trim() ? esc(nextStep) : 'Next step missing'}</p>${renderOverdueFlag(deal.id, dealTitle(deal), overdue)}`;
}
function rowHtml(deal) {
  const parked = deal.operating_state === 'parked';
  const summary = state.boardFromEngine ? listNextStepHtml(deal) : legacyRowStepHtml(deal);
  const attention = state.boardFromEngine ? deal.attention === true : needsAttention(deal);
  const parking = parked ? parkingSummaryHtml(deal) : '';
  const website = parked && state.nextDealSaves ? renderClientPortalLink(deal.client_portal_url, deal.id) : '';
  const revive = parked ? `<button class="btn btn-quiet" type="button" data-revive="${esc(deal.id)}">Revive</button>` : '';
  const move = automaticPhaseReceipt(deal, null, { showEngineMoves: state.boardFromEngine, canUndo: false });
  return workCard({ variant: 'row', className: `kanban-card deal-row${parked && !state.boardFromEngine ? ' parked-card' : ''}`, heading: 'h4', attributes: `data-id="${esc(deal.id)}" tabindex="0" data-attention="${attention}"`,
    title: `<button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(dealTitle(deal))}</button>`,
    meta: `<span class="owner">${esc(actorName(deal.owner))}</span>${dealAttentionHtml(deal)}`,
    body: `<span class="deal-stage">${esc(columnLabel(deal.phase))}</span><div class="deal-row-next">${summary}${parking}${renderDealVendors(deal.vendors)}${website}${renderPhaseReceipt(deal, move, autoHtml(deal))}${revive}</div>` });
}
function parkingSummaryHtml(deal) {
  return state.nextDealSaves ? parkingDetailsHtml(deal)
    : `<p class="next-line">${esc(parkingNoteText(deal) || deal.parking_reason?.replaceAll('_',' ') || 'Parked')}</p>${state.boardFromEngine ? parkingAttributionHtml(deal) : ''}`;
}
let dealCreation = null;
let nextDealCreation = false;
let prospectConversion = null;
let unmountDealClientPicker;
let creatingDeal = false;
function syncDealCreation() {
  $('addDealFields').disabled = creatingDeal || Boolean(dealCreation);
  $('addDealSubmit').disabled = creatingDeal;
  $('addDealCancel').disabled = creatingDeal;
  $('addDealSubmit').textContent = creatingDeal ? 'Saving…' : dealCreation ? 'Check creation outcome' : 'Create deal';
}
async function openAddDeal(client = null, conversion = null) {
  const dialog = $('addDealDialog');
  if (dialog.open) return;
  if (!dealCreation) {
    const prospect = conversion?.prospect;
    const next = state.nextDealSaves;
    const usePicker = Boolean(prospect || next);
    let mountDealClientPicker;
    if (usePicker) {
      try {
        ({ mountDealClientPicker } = await import('./ui-deal-prospects.generated.js'));
      } catch {
        showToast('Could not open Add deal. Try again.', { error: true });
        return;
      }
      if (dialog.open) return;
    }

    prospectConversion = conversion;
    nextDealCreation = next;
    unmountDealClientPicker?.();
    $('addDealForm').reset();
    $('addDealLegacyClient').hidden = usePicker;
    $('addDealClient').disabled = usePicker;
    const picker = $('addDealClientPicker');
    picker.hidden = !usePicker;
    unmountDealClientPicker = mountDealClientPicker?.(picker, {
      ...(prospect ? { prospect } : { client: client ?? undefined }),
      labels: { kind: fieldLabel('kind'), reason: fieldLabel('reason') },
      request: fetchRead, leaseDate: formatCalendarDate, onPick: () => { $('addDealError').textContent = ''; },
    });
    $('addDealOwner').value = prospect ? prospect.owner ?? '' : state.selfActor || 'joe';
    $('addDealStageLabel').textContent = usePicker ? 'Phase' : 'Stage';
    $('addDealStage').selectedIndex = prospect ? 0 : 1;
    const legacyType = $('addDealType');
    dialog.classList.toggle('add-deal-with-terms', next);
    $('addDealTypeField').hidden = next;
    legacyType.disabled = next;
    legacyType.selectedIndex = 1;
    if (prospect) {
      $('addDealName').value = prospect.name;
      $('addDealNotes').value = prospect.latest_note?.summary ?? '';
    } else if (client) {
      $('addDealClient').value = client.name;
      $('addDealName').value = client.name;
    }
    $('addDealError').textContent = '';
  }
  syncDealCreation();
  dialog.showModal();
}
async function submitDeal(event) {
  event.preventDefault();
  if (creatingDeal) return;
  const errorBox = $('addDealError');
  if (!dealCreation) {
    const { client_id, kind, reason, renews_lease_id, ...args } = Object.fromEntries(new FormData($('addDealForm')));
    for (const name of ['name','client','notes']) args[name] = args[name].trim();
    if (!args.name || !args.client) {
      errorBox.textContent = 'Enter a deal name and an existing client.'; errorBox.focus(); return;
    }
    if ((nextDealCreation || prospectConversion) && !client_id) {
      errorBox.textContent = 'Choose a client from the matches.'; errorBox.focus(); return;
    }
    dealCreation = {...args, client_id, prospect_id: prospectConversion?.prospect.party_id,
      kind:kind || undefined, reason:reason || undefined, renews_lease_id,
      lane:'territory', next_deal_save:nextDealCreation, idempotency_key:uuidv4()};
  }
  const request = dealCreation;
  creatingDeal = true; syncDealCreation(); errorBox.textContent = '';
  try {
    const result = await state.client.createDeal(request);
    if (result?.status !== 'ok') throw new Error('Creation receipt unavailable');
    dealCreation = null;
    state.filter = request.owner; state.personalScope = false; state.scopeFilter = 'all';
    const url = new URL(location.href); url.searchParams.set('owner',request.owner); url.searchParams.delete('filter');
    if (request.prospect_id) {
      url.searchParams.delete('prospect');
      url.searchParams.delete('focus');
    }
    writeWorkspaceHistory({},url);
    await loadBoard();
    $('boardView').click();
    $('addDealDialog').close();
    const id = result.deal_id || result.deal?.id;
    if (request.prospect_id) {
      prospectConversion.completed();
      await openWorkspace(id);
    } else document.querySelector(`.kanban-card[data-id="${CSS.escape(id || '')}"] .card-open`)?.focus();
    showToast('Deal created');
  } catch (error) {
    if (error.creationRefused) {
      dealCreation = null;
      const clientOptions = 'Check the spelling or pick an existing client.';
      const reasons = {
        deal_save_unavailable: 'Adding a deal is temporarily unavailable.',
        subject_not_found: `There’s no client named “${request.client}”. ${clientOptions}`,
        not_a_client: `“${request.client}” is not an existing client. ${clientOptions}`,
        needs_disambiguation: 'More than one client matches. Use the client reference.',
        deal_name_exists: 'A deal with this name already exists. Use a distinct name.',
      };
      errorBox.textContent = error.creationHint || ((request.next_deal_save || error.payload?.error === 'reload_deals') && error.payload?.hint)
        || reasons[error.payload?.error] || 'Deal creation was refused. Check the client, name, type, and stage.';
    } else errorBox.textContent = 'Creation not confirmed. The original request is retained. Check creation outcome to finish the same deal, owner, and notes.';
    errorBox.focus();
  } finally { creatingDeal = false; syncDealCreation(); }
}

function renderClosedDeals() {
  const lost = state.view === 'lost';
  $('closedDealsTitle').textContent = lost ? 'Lost deals' : 'Closed deals';
  document.querySelector('label[for=closedSearch]').textContent = lost ? 'Search lost deals' : 'Search closed deals';
  const archived = lost ? state.lostDeals : state.closedDeals;
  let rows;
  if (state.boardFromEngine) {
    rows = (archived || []).filter(deal => deal.workspace_kind !== 'national_account' && !deal.account_client_id
      && (state.filter === 'all' || deal.owner === state.filter));
  } else {
    const records = new Map(state.deals);
    for (const deal of archived || []) records.set(deal.id, {...records.get(deal.id), ...deal});
    rows = (lost ? lostDeals : closedDeals)([...records.values()], state.filter, $('closedSearch').value);
  }
  renderEndedDealList($('closedDealsView'), {
    rows, dealTypeLabel, lost, fromEngine: state.boardFromEngine, canUndo: state.nextDealSaves, feedback: automaticPhase.feedback, unavailable: archived === null, unavailableMessage: '',
  });
  renderHistoryStatus(state.boardSync.status());
}

function renderHistoryStatus(status) {
  const archived = state.view === 'lost' ? state.lostDeals : state.closedDeals;
  const failed = !status.online || status.board_health === HEALTH.FAILED;
  const missing = status.board_health === HEALTH.OK && archived === null;
  const retry = (failed || missing) && (state.boardFromEngine || status.board_error_code === 'engine_unavailable');
  $('retryHistory').hidden = !retry;
  const message = retry ? `Could not load ${state.view} deals.`
    : archived === null ? (failed || missing ? 'Closed history is unavailable. Refresh to try again.' : 'Updating…') : '';
  const readStatus = $('closedReadStatus');
  if (readStatus.textContent !== message) readStatus.textContent = message;
  readStatus.hidden = !message;
}

function visibleBoardDeals() {
  return localDeals([...state.deals.values()], state.personalScope ? state.selfActor : state.filter)
    .filter(d => state.scopeFilter !== 'flagged' || (state.boardFromEngine ? d.attention === true : needsAttention(d)));
}
function renderBoardMessage(status = state.boardSync?.status()) {
  if (status && (!status.online || [HEALTH.FAILED,HEALTH.RENDER_FAILED].includes(status.board_health))) {
    say('The board is unavailable. Refresh to try again.');
    return;
  }
  const headline = boardHeadline(groupByColumn(visibleBoardDeals()));
  const count = state.prospectCount;
  say(typeof count === 'number' ? `${headline} · ${count} prospect${count === 1 ? '' : 's'}` : headline);
}

function dealListHtml(rows, parked) {
  const fromEngine = state.boardFromEngine;
  const phase = fromEngine ? 'Phase' : 'Stage';
  const visible = !fromEngine && state.parkedOpen ? rows : rows.filter(deal => deal.operating_state !== 'parked');
  const mainRows = urgencyOrder(visible).map(rowHtml).join('');
  const parkedGroup = fromEngine && state.parkedOpen ? `<section class="deal-list-parked" aria-labelledby="parkedListHeading">
    <h3 id="parkedListHeading">Parked · ${parked.length}</h3>${urgencyOrder(parked).map(rowHtml).join('')}</section>` : '';
  return `<div class="deal-list"><div class="deal-list-head" aria-hidden="true"><span>Deal</span><span>${phase}</span><span>Next step</span><span>Owner</span></div>${mainRows}${parkedGroup}</div>`;
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
  renderBoardMessage();
  const grouped = groupByColumn(rows);
  state.unplaced = grouped.unplaced.length;
  const focusedStage = board.contains(document.activeElement) ? document.activeElement?.dataset?.collapseStage : null;
  const lane = $('prospectsLane');
  const list = state.view === 'list';
  preserveBoardFocus({ board, document, announce, paint() {
    for (const child of [...board.children]) if (child !== lane) child.remove();
    const insert = list ? 'beforebegin' : 'afterend';
    (lane ?? board).insertAdjacentHTML(lane ? insert : 'afterbegin', list ? dealListHtml(rows, grouped.parked) : grouped.columns.map((column) => {
      const cards = urgencyOrder(column.deals);
      const collapsed = state.collapsedColumns.has(column.slug);
      const content = collapsed
        ? `<p class="stage-preview">${cards.slice(0,2).map(d => `<span>${esc(dealTitle(d))}</span>`).join('')}${cards.length > 2 ? `<span>${cards.length - 2} more</span>` : ''}</p>`
        : cards.map(cardHtml).join('');
      const chosen = state.lifted && state.target === column.slug;
      return `<section class="kanban-column" data-column="${esc(column.slug)}" ${!state.boardFromEngine && !cards.length && !state.showEmptyStages ? 'data-hide-empty="true" ' : ''}data-collapsed="${collapsed}"${chosen ? ' data-drop="true"' : ''}
        aria-label="${esc(column.label)}, ${cards.length} cards">
        <h3 title="${esc(PHASE_TRIGGERS[column.slug])}"><button type="button" data-collapse-stage="${esc(column.slug)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(column.label)}"><span>${esc(column.label)}</span><small>${cards.length}</small></button></h3>
        ${content}
      </section>`;
    }).join('') + (state.boardFromEngine ? '' : emptyStagesNote(grouped.columns.filter(c => !c.deals.length).length)) + `<details class="parked-lane"${state.parkedOpen ? ' open' : ''}><summary>Parked · ${grouped.parked.length}</summary><div class="parked-cards">${grouped.parked.map(cardHtml).join('')}</div></details>`);
  } });
  const note = $('boardNote');
  if (note) {
    note.hidden = state.unplaced === 0;
    note.textContent = state.unplaced
      ? `${state.unplaced} deals need a phase`
      : '';
  }
  showProspects();
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
  if (state.view === 'closed' || state.view === 'lost') {
    // A failed first read must reveal the history view so Retry is visible.
    if (status.board_error_code === 'engine_unavailable' && $('closedDealsView').hidden) renderBoard();
    else renderHistoryStatus(status);
  }
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
  badge.dataset.state = orbState;
  badge.hidden = !['urgent', 'attention'].includes(orbState);
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
  const engineDeals = state.boardFromEngine || state.nextDealSaves;
  const views = !engineDeals && state.feed.caught_up
    ? receiptViews(state.receipts, { selfActor: state.selfActor, undo: state.undo, now: Date.now() })
    : [];
  const count = $('receiptsCount');
  if (count) count.textContent = String(views.length);
  const signature = engineDeals ? 'engine-deals' : receiptsSignature(views);
  if (signature === state.receiptSignature) return;
  state.receiptSignature = signature;
  list.innerHTML = views.length ? receiptListHtml(views.map(view => ({...view, can_undo:false})))
    : `<li class="receipt"><p class="receipt-line">${engineDeals ? 'Open a deal to see its recent changes.' : 'Nothing has changed in this session yet.'}</p></li>`;
}


function noteCellBase(cell, event) {
  if (!event?.id) return;
  const seen = { id: event.id, recorded_at: event.recorded_at ?? null };
  state.fieldBase.set(cell, nextCellBase(state.fieldBase.get(cell) || null, seen));
}

function applyBoardSnapshot(board) {
  const previousPanelRow = state.deals.get(state.panelDeal);
  const previousActor = state.selfActor;
  const saveSwitchChanged = Boolean(state.nextDealSaves) !== (board.next_deal_saves === true);
  state.selfActor = board.actor || state.client.selfActor || state.selfActor;
  state.nextDealSaves = board.next_deal_saves === true;
  const boardFromEngine = board.board_from_engine === true;
  const boardSourceChanged = state.boardFromEngine !== boardFromEngine;
  state.boardFromEngine = boardFromEngine;
  $('mondayReviewLink').hidden = !state.nextDealSaves;
  syncProspects(board.engine_prospects === true);
  if (boardSourceChanged || saveSwitchChanged) renderReceipts();
  const actorChanged = previousActor && previousActor !== state.selfActor;
  bindDraftActor(state.selfActor);
  if (actorChanged || saveSwitchChanged) automaticPhase.clear();
  if (actorChanged) {
    clearMarketTermsViews();
    pageDocContext?.clear();
    const contextRead = pageDocContext?.begin('getBoard');
    pageDocContext?.finish(contextRead, board);
    ++panelReadSequence; ++contextReadSequence;
    state.panelDetail = null;
    disposeChecklist();
    disposeWatchControl();
    disposeActivityAttribution();
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
  if (state.panelDeal && !$('recordPanel')?.hidden && ((state.panelDetail && saveSwitchChanged)
    || (previousPanelRow && JSON.stringify(previousPanelRow) !== JSON.stringify(state.deals.get(state.panelDeal))))) {
    void refreshPanel({changed:true});
  }
}

function showProspects() {
  prospects?.show(state.filter, state.scopeFilter === 'flagged', state.selfActor, state.nextDealSaves, state.view === 'list' ? 'row' : 'tile');
}

function prospectClient() {
  return { prospectRequest: fetchRead, saveProspect: (path, operation, receipt, args) =>
    state.client.savePartnerRecord(path, `prospect:${operation}`, receipt, args) };
}

function syncProspects(enabled) {
  let lane = $('prospectsLane');
  if (!enabled) {
    prospects?.dispose();
    lane?.remove();
    prospects = undefined;
    state.prospectCount = null;
    return;
  }
  if (lane) { prospects?.refresh(); return; }
  lane = document.createElement('section');
  lane.id = 'prospectsLane';
  lane.className = 'kanban-column';
  lane.setAttribute('aria-labelledby', 'prospects-title');
  $('kanban').prepend(lane);
  void import('./ui-deal-prospects.generated.js').then(({ mountProspects }) => {
    if (!lane.isConnected) return;
    prospects = mountProspects(lane, prospectClient(), count => {
      state.prospectCount = count;
      renderBoardMessage();
    }, authorLabel, stepOriginLabel, {
      addDeal: openAddDeal,
      turnIntoDeal: (prospect, completed) => openAddDeal(null, { prospect, completed }),
      backToReview: incomingScope.has('prospect') && dealsPageOrigin('review') ? () => returnToDealsPage(dealsPageOrigin('review')) : null,
    });
    showProspects();
  });
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
}


function confirmLocalWrite(dealId, patch) {
  const deal = state.deals.get(dealId) || null;
  // The engine read supplies parking state and attribution together.
  if (!state.nextDealSaves || !Object.hasOwn(patch, 'operating_state')) {
    if (deal) Object.assign(deal, patch);
    state.boardSync.noteLocalWrite(dealId, patch);
  }
  state.boardSync.requestRefresh('after-write');
  if (state.panelDeal === dealId && Number.isSafeInteger(state.panelDetail?.deal?.seen)) void refreshPanel({ changed: true });
  return deal;
}

async function sendPhaseWrite(dealId, value, extra = null) { return sendFieldWrite(dealId, 'phase', value, extra); }
async function sendFieldWrite(dealId, field, value, extra = null) {
  const cell = cellKey(dealId, field);
  const snapshot = state.panelDeal === dealId ? state.panelDetail?.deal : state.deals.get(dealId);
  if (field !== 'phase' && Number.isSafeInteger(snapshot?.seen)) extra = { ...extra, seen_change_id: snapshot.seen };
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
  'confirm-critical-date': request => state.client.confirmCriticalDate(request),
  'resolve-critical-date': request => state.client.resolveCriticalDate(request),
  'decide-engine-deal-email': request => state.client.decideDealEmail(request),
  'update-deal': (request) => state.client.updateDeal(request),
  'register-client-portal': (request) => state.client.registerClientPortal(request),
  'undo-invoice-close': (request) => state.client.undoInvoiceClose(request),
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
      // eslint-disable-next-line no-restricted-syntax -- Failed post-move read offers a manual retry button; 0 automatic outcome writes after the failed version read.
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
    // eslint-disable-next-line no-restricted-syntax -- Only a manual retry resends the retained outcome command; receipt metadata schedules no attempts.
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
  if (['add-deal-note', 'set-next-step', 'record-deal-item', 'complete-deal-item', 'add-critical-date'].includes(step.verb)) {
    const deal = (state.panelDeal === args.deal ? state.panelDetail?.deal : state.deals.get(args.deal)) ?? step.reviewed;
    const seen = pending ? pending.request.seen_change_id
      : step.verb === 'add-critical-date' && !state.nextDealSaves ? undefined : deal?.seen;
    if (Number.isSafeInteger(seen)) {
      args = { ...args, seen_change_id: seen };
      if (step.verb === 'add-deal-note') args.happened_at = pending?.request.happened_at ?? new Date().toISOString();
    }
  }
  if (step.verb === 'set-next-step') {
    if (pending) args = { ...pending.request, ...args };
    else {
      operations.set(operationKey, { kind: 'follow-up-read', step, summary: step.summary });
      const fromEngine = Number.isSafeInteger(args.seen_change_id);
      let detail;
      try { detail = await state.client.getDeal(args.deal); }
      catch { /* A missing current version cannot authorize a replacement. */ }
      const current = detail?.deal;
      const reviewed = step.reviewed || state.deals.get(args.deal);
      const seen = fromEngine && detail ? dealStepVersion(partnerDealStep(detail, state.selfActor)) : undefined;
      const previous = fromEngine ? dealStepVersion(reviewed?.currentStep) : undefined;
      if (current?.id !== args.deal || (fromEngine
        ? !state.selfActor || seen === undefined || previous === undefined
        : !Number.isSafeInteger(current.version) || current.version < 1)) {
        // eslint-disable-next-line no-restricted-syntax -- Only the manual retry button can reread the step after this failure.
        dock.record(operationKey, { summary: step.summary, status: 'failed', retry: true, undo: false,
          reason: 'The current next step could not be read. Try again before saving it.' });
        return null;
      }
      const changed = fromEngine ? previous?.next_step_id !== seen?.next_step_id || previous?.change_id !== seen?.change_id
        : !reviewed || noteText(reviewed.next_step) !== noteText(current.next_step) ||
          (reviewed.next_date || null) !== (current.next_date || null);
      if (changed) {
        const message = fromEngine ? 'The next step changed. Review it before saving again.'
          : `Current next step: ${noteText(current.next_step) || 'None'} (${current.next_date || 'no date'}). Review before retrying.`;
        // eslint-disable-next-line no-restricted-syntax -- Conflict metadata only sets retry=false; it never automatically replaces changed next-step fields.
        dock.record(operationKey, { summary: step.summary, status: 'conflict', retry: false, undo: false, reason: message });
        return { status: 'conflict', message };
      }
      args = fromEngine ? { ...args, seen_current_step: seen } : { ...args, base_version: current.version };
    }
  }
  const decidesEmail = step.verb === 'decide-engine-deal-email';
  const fromEngine = decidesEmail || Number.isSafeInteger(args.seen_change_id);
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
  const reload = decidesEmail
    ? ['already_decided', 'not_found', 'deal_email_routing_changed'].includes(result.code)
    : fromEngine && result.code === 'version_conflict';
  dock.record(operationKey, {
    summary: operations.get(operationKey).summary,
    status: result.status === 'blocked' ? 'unknown' : result.status,
    reason: (fromEngine && result.hint) || result.message || null,
    // eslint-disable-next-line no-restricted-syntax -- Only another dock action can resend the retained follow-up; this receipt exposes retry state.
    retry: !reload && (result.status === 'blocked' || result.retry), reload, canDispatch: !decidesEmail, undo: false, request: dockRequest,
  });
  if (step.verb === 'register-client-portal' && result.status === 'ok') state.boardSync.requestRefresh('client-portal');
  if (fromEngine && result.status === 'ok') {
    state.boardSync?.requestRefresh('after-write');
    if (state.panelDeal === args.deal) await refreshPanel({ changed: true });
  }
  if (step.verb === 'set-next-step' && reload && state.panelDeal === args.deal) await refreshPanel({ changed: true });
  if (step.verb === 'add-deal-note' && operationKey === updateKey(state.panelDeal) && state.panelDetail) {
    if ([401,403].includes(result.http_status)) { refusePanelDetail({status:result.http_status}); return result; }
    syncUpdateForm();
    if (!fromEngine && result.status === 'ok' && !isUpdate) await refreshPanel();
  }
  if (step.verb === 'resolve-conflict') await settleConflictChoice(step.args.conflict_id, result);
  return result;
}

async function runMove(intent, form) {
  const plan = completionPlan(intent, form);
  if (plan.errors.length) return { ok: false, errors: plan.errors };

  const [phaseStep, ...followUps] = plan.steps;
  const replacement = followUps.find(step => step.verb === 'set-next-step');
  if (replacement) {
    replacement.reviewed = await intent.reviewedStep;
    if (state.intent !== intent) return { ok: false, errors: [] };
    if (dealStepVersion(replacement.reviewed?.currentStep) === undefined) {
      return { ok: false, errors: ['The current next step could not be read. Reopen the move to try again.'] };
    }
  }
  if (phaseStep.verb === 'update-deal') {
    const result = await runFollowUp(`close-deal:${intent.deal}`, phaseStep);
    if (result.code === 'version_conflict') return { ok: false, errors: [], reload: true };
    if (result.status !== 'ok') return { ok: false, errors: [result.hint || result.message] };
    showToast(phaseStep.args.fields.outcome === 'won' ? 'Deal marked won' : 'Deal marked lost');
    return { ok: true, errors: [] };
  }
  const cell = cellKey(intent.deal, 'phase');
  if (!pendingCommand(state.fieldWrites, cell)) {
    operations.set(cell, { kind: 'field', deal: intent.deal, value: phaseStep.args.value,
      summary: moveSummary(intent), intent: { ...intent }, followUps, followUpToken: uuidv4(), followUpsStarted: false });
  }
  dock.record(cell, { summary: moveSummary(intent), status: 'sending', undo: false });
  renderBoard();

  const phaseExtra = Number.isSafeInteger(intent.seen) ? { seen_change_id: intent.seen, phase_from: intent.from } : {};
  if (phaseStep.args.change_reason) phaseExtra.change_reason = phaseStep.args.change_reason;
  if (phaseStep.args.human_quote) phaseExtra.human_quote = phaseStep.args.human_quote;

  const result = await sendPhaseWrite(intent.deal, phaseStep.args.value, Object.keys(phaseExtra).length ? phaseExtra : null);
  const reload = recordFieldReceipt(cell, moveSummary(intent), `${fieldLabel('phase')} on ${intent.name}`, result);

  if (result.status === 'conflict') {
    renderBoard();
    if (reload) return { ok: false, errors: [], reload };
    if (result.conflict) showConflict(result.conflict);
    return { ok: false, errors: result.conflict ? [] : [fieldWriteMessage(result) || 'Reload the deal before saving.'] };
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
  // eslint-disable-next-line no-restricted-syntax -- Move follow-ups run once per finite move.followUps entry; followUpsStarted prevents a second automatic pass.
  for (const step of move.followUps) {
    const operationKey = `${step.verb}:${move.intent.deal}:${move.followUpToken}`;
    if (step.verb === 'update-deal') await runOutcomeWrite(operationKey, step, move.intent);
    else await runFollowUp(operationKey, step);
  }
}

function recordFieldReceipt(cell, summary, subject, result) {
  const reload = result.code === 'version_conflict';
  dock.record(cell, {
    summary, status: result.status, reason: fieldWriteMessage(result, subject) || null,
    // eslint-disable-next-line no-restricted-syntax -- Only an explicit receipt click can resend a retained write.
    retry: !reload && result.retry, reload, request: result.request,
  });
  return reload;
}

async function retryFieldWrite(cell) {
  const entry = pendingCommand(state.fieldWrites, cell);
  if (!entry) { renderBoard(); return; }
  const { deal, field, value } = entry.request;
  const row = state.deals.get(deal);
  const result = await sendFieldWrite(deal, field, value);
  const subject = `${fieldLabel(field)} on ${row?.name || 'this deal'}`;
  recordFieldReceipt(cell, `${row?.name || 'Deal'} · ${fieldLabel(field)}`, subject, result);
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
  const replaceNextStep = state.nextDealSaves && Number.isSafeInteger(intent.seen) && intent.to !== CLOSED_SLUG;
  const actor = state.selfActor;
  const detail = state.panelDetail;
  const reviewedStep = replaceNextStep
    ? (detail?.deal.id === intent.deal ? Promise.resolve(detail) : readDealDetail(intent.deal))
      .then(current => actor && actor === state.selfActor ? reviewedDealStep(current) : null, () => null)
    : null;
  state.intent = { ...intent, reviewedStep };
  const dialog = $('completionDialog');
  if (!dialog) return;

  const isClosed = intent.to === CLOSED_SLUG;
  const closingInEngine = isClosed && Number.isSafeInteger(intent.seen);
  const wonOrLost = closingInEngine || intent.wonOrLost;
  $('completionTitle').textContent = wonOrLost ? `Close ${intent.name}` : moveTitle(intent);
  $('completionPaused').hidden = Boolean(wonOrLost);
  $('completionMoveDetails').hidden = Boolean(wonOrLost);
  $('completionLostReason').value = '';
  const closed = $('completionClosedNote');
  if (closed) {
    closed.hidden = !isClosed;
    closed.textContent = closedColumnCaption();
  }
  const outcomeField = $('completionOutcomeField');
  if (outcomeField) outcomeField.hidden = !isClosed;
  for (const radio of outcomeRadios()) radio.checked = false;
  const closedOn = $('completionClosedOn');
  if (closedOn) {
    closedOn.value = isClosed ? (closingInEngine ? businessDay() : todayIso()) : '';
    closedOn.max = closingInEngine ? closedOn.value : '';
  }
  const wonValue = $('completionWonValue');
  if (wonValue) wonValue.value = '';
  renderOutcomeState();
  const confirm = $('completionConfirm');
  if (confirm) confirm.textContent = wonOrLost ? 'Save outcome' : `Move to ${intent.to_label}`;
  $('completionEvidence').value = '';
  $('completionReason').value = '';
  $('completionQuote').value = '';
  const nextStep = $('completionNextStep');
  nextStep.labels[0].textContent = replaceNextStep ? 'Your next step' : 'Next item (2–4 words)';
  nextStep.maxLength = replaceNextStep ? 10000 : 100;
  nextStep.value = '';
  $('completionNextWhen').value = '';
  $('completionDate').value = '';
  $('completionCritical').checked = false;
  $('completionSource').value = '';
  const errors = $('completionErrors');
  if (errors) { errors.hidden = true; errors.textContent = ''; }
  renderCriticalState();
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  if (!wonOrLost) $('completionEvidence')?.focus();
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
  $('completionLostReasonField').hidden = !Number.isSafeInteger(state.intent?.seen) || chosenOutcome() !== 'lost';
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


let activityAttribution = null;
function disposeActivityAttribution() { activityAttribution?.dispose(); activityAttribution = null; }
function mountPanelActivityAttribution() {
  disposeActivityAttribution();
  const root = $('panelBody').querySelector('.deal-updates');
  if (root) activityAttribution = mountActivityAttribution(root, { onDenied: refusePanelDetail });
}
let watchControl = null, watchElement = null, watchSubject = null;
let panelEmailFollowups = null;
let emailMountSequence = 0;
function disposePanelEmailFollowups() {
  emailMountSequence++;
  panelEmailFollowups?.dispose(); panelEmailFollowups = null;
}
async function mountPanelEmailFollowups(id) {
  if (isEngineDealDetail(state.panelDetail)) return;
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
  disposeChecklist();
  disposeWatchControl();
  clientPublicationsPanel?.dispose(); clientPublicationsPanel = null;
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose(); dealToursPanel = null;
  bindDraftActor(null);
  disposeActivityAttribution();
  disposePanelEmailFollowups();
  setContextOpenVisible(false);
  $('contextDrawer').close();
  $('contextDrawerBody').replaceChildren();
  $('panelTitle').textContent = 'Deal';
  $('workspaceFacts').replaceChildren();
  $('panelBody').innerHTML = '<p role="status">Unavailable. Sign in to reload this record. <a href="/auth/login">Sign in</a> <button class="btn" type="button" data-refresh-detail>Retry</button></p>';
  return true;
}
function canEditOwnDealStep(detail) {
  return (state.nextDealSaves || detail.next_deal_saves) && Number.isSafeInteger(detail.deal.seen);
}
function reviewedDealStep(detail) {
  if (!canEditOwnDealStep(detail)) return detail.deal;
  const currentStep = partnerDealStep(detail, state.selfActor);
  return { currentStep, next_step: currentStep?.description, next_date: currentStep?.due_on };
}
function editableStepDate(reviewed) {
  const date = reviewed.next_date || '';
  return reviewed.currentStep !== undefined && date < businessDay() ? '' : date;
}
function updateStepChanged(draft) {
  return draft.step.trim() !== noteText(draft.reviewed.next_step).trim() || draft.date !== editableStepDate(draft.reviewed);
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
    const reviewed = reviewedDealStep(state.panelDetail);
    updateDraft = updateDrafts.get(state.panelDeal) || {id:state.panelDeal,text:'', step:noteText(reviewed.next_step), date:editableStepDate(reviewed), reviewed, noteSaved:false};
    updateDrafts.set(state.panelDeal, updateDraft);
  }
  form.elements.text.value = pending ? pending.request.text : updateDraft.text;
  form.elements.text.disabled = Boolean(pending) || updateDraft.noteSaved || !state.selfActor;
  form.elements.step.value = updateDraft.step;
  form.elements.date.value = updateDraft.date;
  const canSaveStepOnly = updateDraft.reviewed.currentStep !== undefined;
  const changed = updateStepChanged(updateDraft);
  const overdue = !isClosedDeal(state.panelDetail.deal)
    && Boolean(updateDraft.reviewed.next_date && updateDraft.reviewed.next_date < (canSaveStepOnly ? businessDay() : todayIso()));
  $('detailUpdateDateHint').hidden = !overdue;
  if (overdue) form.elements.date.setAttribute('aria-describedby', 'detailUpdateDateHint');
  else form.elements.date.removeAttribute('aria-describedby');
  form.elements.step.disabled = form.elements.date.disabled = Boolean(pending || pendingStep) || !state.selfActor;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = pending?.status === 'pending' || pendingStep?.status === 'pending' || !state.selfActor;
  const noteOnly = updateDraft.text.trim() && !changed && !updateDraft.noteSaved;
  const saveLabel = canSaveStepOnly ? (noteOnly ? 'Save note' : 'Save next step') : 'Add update';
  button.textContent = pending || pendingStep ? 'Check outcome' : saveLabel;
  form.querySelector('[data-review-update-step]').hidden = !updateDraft.conflict;
  const discard = form.querySelector('[data-discard-update]');
  discard.hidden = !(pending || pendingStep || updateDraft.text || changed);
  discard.disabled = Boolean(pending || pendingStep);
  if (!pending) $('detailUpdateStatus').textContent = updateDraft.noteSaved ? updateDraft.message || 'Update added; next step still needs to be saved.' : updateDraft.text ? 'Unsent draft · kept while this page is open' : updateDraft.message || '';
  if (pending) $('detailUpdateStatus').textContent = pending.message || 'Saving update…';
}
function validateDetail(detail, id) {
  if (!detail?.deal || detail.deal.id !== id || typeof detail.deal.name !== 'string') throw new Error('Invalid detail');
  for (const field of ['activities','thread','next_actions','critical_dates','participants','premises','negotiation_rounds','documents','history','email_follow_ups','correspondence']) {
    if (detail[field] !== undefined && (!Array.isArray(detail[field]) || detail[field].some(row => !row || typeof row !== 'object'))) throw new Error('Invalid detail section');
  }
  return prepareDealDetail(detail);
}
function readDealDetail(id, signal) {
  return readWithDeadline(current => state.client.getDeal(id, { signal: current }), { signal })
    .then(detail => validateDetail(detail, id));
}
function validateUpdateStep(draft, form) {
  $('detailNextStepEditor').open = true;
  if (!draft.step.trim()) { $('detailUpdateStatus').textContent = 'Enter a next step'; form.elements.step.focus(); return false; }
  if (draft.date && draft.date < (draft.reviewed.currentStep !== undefined ? businessDay() : todayIso())) {
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
  const draft = updateDraft;
  const actor = state.selfActor;
  const step = draft.step.trim();
  const changed = updateStepChanged(draft);
  const stepOnly = draft.reviewed.currentStep !== undefined && changed;
  if (!pending && !text && !draft.noteSaved && !stepOnly) {
    $('detailUpdateStatus').textContent = draft.reviewed.currentStep !== undefined
      ? 'Enter a new next step or change the date.' : 'Enter an update';
    return;
  }
  if (changed && draft.conflict) { form.querySelector('[data-review-update-step]').focus(); return; }
  const pendingStep = pendingCommand(commandState, nextStepKey(id));
  if (changed && !pendingStep && !validateUpdateStep(draft, form)) return;
  if (draft.sending) return;
  if (!draft.stepStarted && pendingCommand(commandState, nextStepKey(id))) { $('detailUpdateStatus').textContent = 'Resolve the pending next step before adding an update.'; return; }
  draft.sending = true;
  try {
    if (!draft.noteSaved && (pending || text)) {
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
        draft.message = `${draft.noteSaved ? 'Update added; next step not saved. ' : ''}${result?.hint || result?.message || 'Review the current next step and retry.'}`;
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
        updateDraft.message = draft.noteSaved ? 'Update added' : 'Next step saved.';
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
export const workspaceTabs = [
  {id:'overview', label:'Overview'},
  {id:'market-terms', label:'Compare terms'},
  {id:'timeline', label:'Timeline'},
  {id:'correspondence', label:'Correspondence & notes'},
  {id:'tours', label:'Tours'},
  {id:'documents', label:'Documents'},
  {id:'client-view', label:'Client view'},
];
let workspaceTab = 'overview';
let boardScroll = 0;
let timelineType = '';
history.scrollRestoration = 'manual';
let workspaceHistoryIndex = history.state?.doctorcreWorkspaceIndex ?? 0;
function writeWorkspaceHistory(data, url, push = false) {
  if (push) ++workspaceHistoryIndex;
  history[push ? 'pushState' : 'replaceState']({...data, doctorcreWorkspaceIndex:workspaceHistoryIndex}, '', url);
}
writeWorkspaceHistory(history.state, location.href);
function renderNextCriticalDate(date) {
  const day = calendarDay(date?.due_on);
  if (!day) return '';
  return `<div class="workspace-critical-date"><dt>Next critical date</dt><dd>${esc(criticalDateLabel(date.kind))} · <time datetime="${day}">${dateWords(day)}</time></dd></div>`;
}
function renderWorkspaceFacts(detail) {
  const d = detail.deal;
  const fromEngine = isEngineDealDetail(detail);
  const client = d.client_name || d.client_ref;
  const parked = fromEngine && !isClosedDeal(d) && d.operating_state === 'parked';
  const phase = fromEngine && d.outcome === 'lost' ? 'Lost' : columnByValue(d.phase)?.label || d.phase || 'Not recorded';
  $('workspaceFacts').innerHTML = `<dl class="workspace-facts">
    ${client && (fromEngine || client !== dealTitle(d)) ? `<div class="workspace-client${fromEngine ? ' workspace-client-labeled' : ''}"><dt>Client</dt><dd title="${esc(client)}">${esc(client)}</dd></div>` : ''}
    <div><dt>Phase</dt><dd>${esc(phase)}${parked ? ' · Parked' : ''}</dd></div>
    <div><dt>Owner</dt><dd>${esc(actorName(d.owner) || 'Unassigned')}</dd></div>
    ${fromEngine ? renderNextCriticalDate(d.next_critical_date) : ''}
  </dl>`;
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
  if (id === 'documents') void dealDocumentsPanel?.load();
  if (id === 'client-view') {
    const strip = $('workspaceTabs');
    strip.scrollLeft += $('tab-client-view').getBoundingClientRect().left - strip.getBoundingClientRect().left;
    void clientPublicationsPanel?.load();
  }
  if (id === 'tours') void dealToursPanel?.load();
  $('panelContextOpenWrap').hidden = id !== 'overview' || !state.panelDetail;
  if (id === 'correspondence') {
    const legacyEvidence = $('panelEvidenceSection');
    if (legacyEvidence) legacyEvidence.open = true;
  }
}
function workspaceNotesHtml(detail) {
  return `<section aria-label="Deal notes"><h3>Deal notes</h3>${(detail.thread || []).map(note => `<article class="workspace-note"><b>${esc(authorLabel(note.actor))}</b> <time datetime="${esc(note.at || note.created_at || note.recorded_at || '')}">${esc(sourceTime(note.at || note.created_at || note.recorded_at, undefined, 'Date not recorded'))}</time><p class="note-original">${esc(noteText(note.text))}</p></article>`).join('') || '<p>No notes recorded.</p>'}</section>`;
}
function legacyTimelineEntries(detail, nextItem) {
  const view = dealTimeline(detail);
  return [
    ...view.entries.filter(e => e.day).map(e => ({type:e.type, day:e.day, text:[...new Set([e.summary,e.original].filter(Boolean))].join('\n\n')})),
    ...(detail.items || detail.deal.items || []).filter(e => e !== nextItem && calendarDay(e.due_on)).map(e => ({type:'Checklist item', day:calendarDay(e.due_on), text:noteText(e.title)})),
    ...view.dates.map(e => ({type:'Critical date', day:e.day, text:[e.label,e.original].filter(Boolean).join(' · ')})),
    ...view.phases.filter(e => e.day).map(e => ({type:'Phase', day:e.day, text:e.label})),
    ...(detail.next_actions || []).flatMap(e => [['due_on','Due'],['hold_until','Held until']].filter(([key]) => (key !== 'due_on' || e.status === 'done') && calendarDay(e[key])).map(([key,label]) => ({type:'Next step', day:calendarDay(e[key]), text:`${label} · ${noteText(e.description)}`}))),
    ...(detail.history || []).filter(e => calendarDay(e.recorded_at) && !view.entries.some(entry => entry.id === e.id)).map(e => ({type:'Change', day:calendarDay(e.recorded_at), text:noteText(e.summary) || `${fieldLabel(e.field)} · ${readableValue(e.field, e.new_value)}`})),
  ].sort((a,b) => b.day.localeCompare(a.day))
    .map(({ type, day, text }) => ({ type, when: day, caption: dateCaption(day), actor: '', text }));
}
function workspaceEventsHtml(detail, nextItem, fromEngine) {
  const events = fromEngine ? engineTimelineEntries(detail) : legacyTimelineEntries(detail, nextItem).filter(event => event.text.trim());
  if (!events.some(event => event.type === timelineType)) timelineType = '';
  return `<h2>Dated events</h2><label for="timelineType">Filter by kind</label><select id="timelineType"><option value="">All types</option>${[...new Set(events.map(e => e.type))].map(type => `<option${type === timelineType ? ' selected' : ''}>${esc(type)}</option>`).join('')}</select><ol class="workspace-events">${events.map(e => `<li data-event-type="${esc(e.type)}"${timelineType && e.type !== timelineType ? ' hidden' : ''}>${e.actor ? `<b>${esc(e.actor)}</b> ` : ''}<time datetime="${esc(e.when)}">${esc(e.caption)}</time><small>${esc(e.type)}</small><p class="note-original">${esc(e.text)}</p></li>`).join('')}</ol>${events.length ? '' : fromEngine ? '<p>No dated events yet.</p>' : '<p>No dated events recorded.</p>'}`;
}
let factReviewPanel, marketTermsPanel, dealToursPanel, dealDocumentsPanel, clientPublicationsPanel;
let checklistPanel;
function disposeChecklist() { checklistPanel?.dispose(); checklistPanel = null; }
function disposeWatchControl() { watchControl?.dispose(); watchControl = null; watchElement = null; watchSubject = null; }
function mountChecklist(detail) {
  disposeChecklist();
  const host = $('panelBody').querySelector('[data-detail-read="checklist"]');
  let retired = false, mounted, latest = detail;
  const params = new URL(location.href).searchParams;
  const props = value => ({dealId: value.deal.id, checklist: value.checklist, showProgress: isEngineDealDetail(value),
    focusedItem: params.get('deal') === value.deal.id ? params.get('checklist') : null});
  checklistPanel = {
    update(value) { latest = value; mounted?.update(props(value)); },
    dispose() { retired = true; mounted?.dispose(); },
  };
  void import('./ui-checklist.generated.js').then(({mountDealChecklist}) => {
    if (retired) return;
    mounted = mountDealChecklist(host, props(latest));
  }).catch(() => { if (!retired) host.textContent = 'Checklist unavailable. Reopen the deal to try again.'; });
}
// Each deal's comparison is kept for the session and reattached when its tab reopens; an access change discards them all.
const marketTermsViews = new Map();
function clearMarketTermsViews() {
  for (const view of marketTermsViews.values()) view.mounted?.dispose();
  marketTermsViews.clear();
}

function dueDateHtml(day, today) {
  const due = dealDueDate(day, today);
  return due ? `Due <time datetime="${due.day}">${due.date}</time>${due.late ? ` · ${due.late}` : ''}` : 'No due date';
}
function undoInvoiceClose() {
  const deal = state.panelDetail?.deal;
  const invoice = invoiceClose(deal);
  if (!state.nextDealSaves || !invoice) return;
  return runFollowUp(`invoice-undo:${invoice.event_id}`, {
    verb: 'undo-invoice-close', summary: 'Undo invoice close',
    args: { deal: deal.id, invoice_id: invoice.event_id, seen_change_id: deal.seen },
  });
}

function filedDocumentsHtml(documents) {
  return documents.length ? `<ul class="deal-document-list">${documents.map(file => {
    const version = `Version ${file.version}`;
    return `<li><h3><a href="/api/engine/documents/${encodeURIComponent(file.id)}" aria-label="${esc(`${file.name}, ${version}`)}" data-detail-focus="file-${esc(file.id)}">${esc(file.name)}</a></h3>
      <p>${esc(version)}${file.prepared_at ? ` · ${esc(sourceTime(file.prepared_at))}` : ''}</p></li>`;
  }).join('')}</ul>` : '<p>No documents filed for this deal.</p>';
}

const emailDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: BUSINESS_TIME_ZONE });

function dealEmailSender({ sender_name, sender, happened_at }) {
  const name = (sender_name || sender || '').split('<', 1)[0].trim().replace(/^["']|["']$/g, '').split(/\s+/, 1)[0];
  const from = name && !name.includes('@') ? `From ${name}` : 'Unknown sender';
  const date = Date.parse(happened_at);
  return Number.isFinite(date) ? `${from}, ${emailDay.format(date)}` : from;
}

function cleanEmailExcerpt(text) {
  const body = text.trim()
    .replace(/^Email from [^\n]+?:[^\n]*(?:\r?\n|$)/i, '')
    .replace(/^(?:(?:from|to|cc|bcc|sent|date|subject):[^\n]*(?:\n[ \t]+[^\n]*)*\n?)+/i, '')
    .split(/^[ \t]*(?:-+ Original Message -+|On .+ wrote:|--)[ \t]*\r?$/im, 1)[0];
  return body.split(/(\s+)/).filter(word => {
    const [local, domain] = word.split('@', 2);
    return !local || !domain?.includes('.');
  }).join('').trim();
}

function dealEmailFollowupsHtml({ correspondence, email_follow_ups, next_deal_saves }) {
  const today = businessDay();
  const filed = new Set(correspondence?.filter(entry => entry.kind === 'email' && entry.activity_id).map(entry => entry.activity_id));
  const followups = email_follow_ups.filter(row => row.kind !== 'file_to_deal' || !filed.has(row.email?.activity_id));
  return `<h2>Email follow-ups</h2>${followups.map(row => {
    const email = row.email || {};
    const subject = emailSubject(email.subject);
    const evidence = cleanEmailExcerpt(row.evidence || '');
    const preview = evidence || cleanEmailExcerpt(email.summary || '');
    const body = emailSubject(preview) === subject ? '' : preview;
    const title = subject === '(No subject)' ? concise(body, 72) || 'Email' : subject;
    const showBody = body && title !== body.replace(/\s+/g, ' ');
    const excerpt = evidence ? `<details><summary>Read email excerpt</summary><q>${esc(body)}</q></details>` : `<p>${esc(body)}</p>`;
    const change = row.kind === 'file_to_deal' ? 'File email to this deal'
      : row.kind === 'phase_move' ? `Move to ${columnBySlug(row.to_phase)?.label || 'the next phase'}`
      : row.what && emailPlaceholderText(row.what) || 'Review email';
    const owner = row.kind === 'next_step' ? ACTOR_LABEL[row.owner] : '';
    const id = esc(row.proposal_id);
    const actions = next_deal_saves ? `<form data-email-decision="${id}">
      ${row.kind === 'next_step' ? `<div class="deal-next-step-fields">
        <label>Next step<input name="what" value="${esc(row.what)}" maxlength="10000" required data-detail-focus="step-${id}"></label>
        <label>Due date<input type="date" name="due_on" value="${esc(row.due_on)}" data-detail-focus="date-${id}"></label>
      </div>` : ''}
      <button class="btn" type="submit" value="accept" data-detail-focus="accept-${id}">Accept</button>
      <button class="btn" type="submit" value="dismiss" formnovalidate data-detail-focus="dismiss-${id}">Dismiss</button>
    </form>` : '';
    return workCard({className:'email-proposal', title:esc(title), actions,
      meta:`<p>${esc(dealEmailSender(email))}</p>`,
      body:`<p>${esc(change)}${owner ? ` · ${esc(owner)}` : ''}${row.due_on ? ` · ${dueDateHtml(row.due_on, today)}` : ''}</p>
        ${showBody ? excerpt : ''}`});
  }).join('') || '<p>No email follow-ups.</p>'}`;
}

function renderSnapshotFacts(deal, fromEngine) {
  const facts = [];
  const national = deal.workspace_kind === 'national_account' || deal.account_client_id;
  const market = fromEngine && national ? nationalMarketLabel(deal.market) : deal.market;
  if (fromEngine && market) facts.push({ label: 'Market', value: market });
  if (national) {
    facts.push({ label: 'Market agent', value: deal.market_agent || 'Unassigned' });
  }
  if (fromEngine) facts.push(...dealTypeFacts(deal, dealTypeLabel));
  else if (deal.type) facts.push({ label: 'Type', value: deal.type });
  if (deal.outcome) facts.push({ label: 'Outcome', value: deal.outcome[0].toUpperCase() + deal.outcome.slice(1) });
  if (fromEngine && deal.outcome === 'lost') {
    facts.push(
      { label: 'Reason for loss', value: lossReasonLabel(deal.lost_reason) },
      { label: 'Close date', value: formatCalendarDate(calendarDay(deal.closed_on)) || 'Close date not recorded' },
    );
  }

  const value = Number(deal.closed_value);
  const closedValue = value > 0 && (!fromEngine || isClosedDeal(deal))
    ? { label: 'Closed value', value: value.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) }
    : null;
  if (fromEngine && closedValue) facts.push(closedValue);
  return `<dl class="deal-snapshot-facts">${renderDealFacts(facts)}</dl>
    ${!fromEngine && closedValue ? `<dl class="deal-snapshot-facts">${renderDealFacts([closedValue])}</dl>` : ''}`;
}

function stepFocusAttrs(step) {
  return step?.id ? ` tabindex="-1" data-detail-focus="next-step-${esc(step.id)}"` : '';
}

function stepOrigin(step) {
  const origin = stepOriginLabel(step, { showDateOnly: true });
  return origin ? `<small>${esc(origin)}</small>` : '';
}

const completeStepKey = id => `complete-step:${state.selfActor}:${id}`;

function openDealStepsHtml(detail, steps, today) {
  const heading = isClosedDeal(detail.deal) && steps.length ? 'Open before this deal ended' : 'Next steps';
  const groups = new Map();
  const ids = new Set();
  for (const step of steps) {
    if (step.id && ids.has(step.id)) continue;
    ids.add(step.id);
    const key = JSON.stringify([step.description.trim(), calendarDay(step.due_on)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(step);
  }
  const rows = [...groups.values()].map(group => {
    const [first] = group;
    const shared = group.length > 1;
    const title = `step-text-${esc(first.id)}`;
    return `<li${shared ? '' : stepFocusAttrs(first)}><strong id="${title}">${esc(first.description.trim())}</strong>
      ${group.map(step => {
        const id = esc(step.id);
        const canFinish = detail.next_deal_saves && Number.isSafeInteger(detail.deal.seen) && dealStepVersion(step);
        const saving = pendingCommand(commandState, completeStepKey(step.id))?.status === 'pending';
        const owner = `step-owner-${id}`;
        const label = `${title} ${owner}`;
        return `<div class="deal-step-assignment"${shared ? `${stepFocusAttrs(step)} role="group" aria-labelledby="${label}"` : ''}>
          <div><p id="${owner}">${esc(actorName(step.owner))} · ${dueDateHtml(calendarDay(step.due_on), today)}</p>
            ${stepOrigin(step)}</div>
          ${canFinish ? `<button class="btn" type="button" data-complete-step="${id}" data-detail-focus="done-${id}" aria-describedby="${label}"${saving ? ' aria-disabled="true"' : ''}>Done</button>` : ''}
        </div>`;
      }).join('')}
    </li>`;
  }).join('');
  return `<section class="deal-open-steps" aria-labelledby="deal-open-steps-heading">
    <h2 id="deal-open-steps-heading">${heading}</h2>
    ${rows ? `<ul aria-label="Open steps" role="list">${rows}</ul>` : '<p>No next step set.</p>'}
  </section>`;
}

async function completeDealStep(button) {
  const detail = state.panelDetail;
  const step = ordinaryOpenSteps(detail?.next_actions).find(row => row.id === button.dataset.completeStep);
  const version = dealStepVersion(step);
  if (!detail?.next_deal_saves || !version || button.getAttribute('aria-disabled') === 'true') return;
  const operationKey = completeStepKey(step.id);
  const notice = $('detailStepStatus');
  notice.textContent = 'Saving…';
  button.setAttribute('aria-disabled', 'true');
  const pending = pendingCommand(commandState, operationKey);
  const result = await performCommand({
    operationKey,
    args: pending?.request ?? { next_step_id: step.id, base_version: version.change_id },
    getState: () => commandState,
    setState: next => { commandState = next; },
    newKey: uuidv4,
    call: request => state.client.completeDealStep(request),
  });
  const saved = result.status === 'ok';
  const changed = ['version_conflict', 'step_ended', 'not_found'].includes(result.code);
  if (saved) state.boardSync.requestRefresh('after-write');
  if (!notice.isConnected) return;
  if (saved || changed) await refreshPanel({ changed: true });
  if (!notice.isConnected) return;
  $('panelBody').querySelector(`[data-complete-step="${CSS.escape(step.id)}"]`)?.removeAttribute('aria-disabled');
  notice.textContent = saved
    ? $('detailReadStatus').textContent ? 'Step marked done. Refresh to update this deal.' : 'Step marked done.'
    : changed ? 'This step changed. Review the latest version.'
    : result.status === 'unknown' ? 'Could not confirm this step is done. Choose Done again to check.'
    : 'Could not mark this step done. Try again.';
}

function workspaceHtml(detail) {
  const fromEngine = isEngineDealDetail(detail);
  const ownStep = canEditOwnDealStep(detail);
  const d = detail.deal;
  const items = detail.items || d.items || [];
  const { text: nextStep, dueOn, item: nextItem, otherActions } = fromEngine
    ? {} : dealNextStep(d, detail.next_actions || [], items);
  const today = fromEngine ? businessDay() : todayIso();
  const ended = isClosedDeal(d);
  const stepToday = ended ? undefined : today;
  const stepLabel = stepToday && dueOn && dueOn < stepToday ? 'Overdue action' : 'Next action';
  const stepSummary = fromEngine ? openDealStepsHtml(detail, dealOwnerFirstSteps(d, detail.next_actions), stepToday) : `
    ${nextStep ? `<p class="deal-current-action"><span>${stepLabel}</span>: <strong>${nextItem ? renderDealItemButton(d.id, nextItem, nextStep, 'btn btn-quiet') : esc(nextStep)}</strong> · <span>${dueDateHtml(dueOn)}</span></p>` : '<p>No next step or key date set.</p>'}
    ${otherActions.length ? `${ended ? '' : '<p class="deal-items-label">Also open:</p>'}<ul class="deal-items" aria-label="Other open steps">${otherActions.map(action =>
      `<li>${esc(action.description.trim())} · ${esc(actorName(action.owner))} · ${dueDateHtml(calendarDay(action.due_on), stepToday)}</li>`
    ).join('')}</ul>` : ''}`;
  const stepId = state.panelStepId;
  const completedStep = fromEngine && stepId && detail.next_actions?.find(step => step.id === stepId && step.status === 'done');
  const itemOwners = fromEngine ? new Map(detail.next_actions?.map(step => [step.id, step.owner])) : undefined;
  const prospect = state.deals.get(d.id);
  const pendingProspect = engagementWriterFor(state.client).get(prospect?.client_id, state.selfActor);
  const parked = !ended && d.operating_state === 'parked';
  const parker = fromEngine && parked ? parkingAttributionHtml(d) : '';
  const parkingNote = concise(parkingNoteText(d));
  const nextParking = detail.next_deal_saves === true;
  const engineSaves = nextParking || dealsSaveToEngine();
  const parkingSummary = nextParking && parked ? parkingDetailsHtml(d)
    : parkingNote ? `<p>${esc(parkingNote)}</p>${parker}` : parker || '<p>Parked</p>';
  const controlsAvailable = (state.deals.has(d.id) || (state.nextDealSaves && Number.isSafeInteger(d.seen))) && !ended;
  const canAddCriticalDate = detail.next_deal_saves === true && Number.isSafeInteger(d.seen);
  const websiteLink = fromEngine ? renderClientPortalLink(d.client_portal_url, d.id) || '<p>No client website linked.</p>' : '';
  const phaseMove = detailPhaseMoveHtml(detail);
  const websiteSetup = !d.client_portal_url && (fromEngine ? detail.next_deal_saves && d.client_id : controlsAvailable)
    ? clientPortalSetupHtml() : '';
  return `<div class="deal-freshness"><time id="detailUpdated" title="Last updated"></time><button class="btn icon-btn" type="button" data-refresh-detail aria-label="Refresh deal" title="Refresh">↻</button></div><p id="detailReadStatus" role="status"></p>
    <section id="workspace-overview" role="tabpanel" aria-labelledby="tab-overview">${fromEngine ? '<p id="detailStepStatus" role="status"></p>' : ''}<section class="deal-opening-snapshot" aria-label="Deal snapshot">
      <div data-detail-read="step-overview">
      ${websiteLink}
      ${renderInvoiceClose(d, state.nextDealSaves)}
      ${fromEngine || phaseMove ? `<div data-phase-move>${phaseMove}</div>` : ''}
      ${!fromEngine && ended && (nextStep || otherActions.length) ? `<section aria-labelledby="ended-deal-steps"><h3 id="ended-deal-steps">Open before this deal ended</h3>${stepSummary}</section>` : stepSummary}
      ${completedStep ? `<section aria-label="Completed step"${stepFocusAttrs(completedStep)}>
      <h2>Completed step</h2><p>${esc(completedStep.description)}</p>${stepOrigin(completedStep)}
    </section>` : ''}
      </div>
      ${ownStep ? `<details id="detailNextStepEditor" class="deal-step-editor"><summary>Add next step</summary>${dealUpdateFormHtml(true, today)}</details>` : ''}
      <div data-detail-read="snapshot">
    <div class="deal-alert">${renderDealItems({...d,items:items.filter(item => item !== nextItem)},{today:stepToday,buttons:true,empty:false,itemOwners})}</div>
      ${renderSnapshotFacts(d, fromEngine)}
      ${!fromEngine && d.client_portal_url ? renderClientPortalLink(d.client_portal_url) || '<p>Client website link is invalid.</p>' : ''}
      </div>
    </section>
    ${detail.next_deal_saves ? `<div data-detail-read="attention">${Number.isSafeInteger(d.seen) && !ended
      ? `<button class="btn" type="button" data-deal-attention data-detail-focus="attention">${d.attention === true ? 'Clear needs attention' : 'Mark needs attention'}</button>` : ''}</div>` : ''}
    ${fromEngine ? `<div data-detail-read="client-portal">${websiteSetup}</div>` : ''}
    ${engineSaves ? '' : '<section id="panelTerms" aria-label="Terms"><h2>Terms</h2><button type="button" class="btn" data-open-terms>Show sourced terms</button></section>'}
    <div data-detail-read="checklist"></div>
    ${ownStep ? '' : dealUpdateFormHtml(false, today)}
    <section id="panelEmailFollowups" aria-label="Email follow-ups"${fromEngine ? ' data-detail-read="email-followups"' : ''}>${fromEngine ? dealEmailFollowupsHtml(detail) : '<p role="status">Updating email follow-ups…</p>'}</section>
    ${requirementEmailHtml(d)}
    <div data-detail-read="vendors">${renderDealVendors(d.vendors)}</div>
    <div data-detail-read="board-controls" data-available="${controlsAvailable}">${controlsAvailable ? `<div class="detail-actions"><div class="detail-controls"><label>Phase<select id="detailPhase">${COLUMNS.map(c => `<option value="${esc(c.slug)}"${c.value === d.phase ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label><label>Owner<select id="detailOwner">${fromEngine ? '' : '<option value="">Unassigned</option>'}${['joe','dell'].map(owner => `<option value="${owner}"${owner === d.owner ? ' selected' : ''}>${actorName(owner)}</option>`).join('')}</select></label></div><div data-detail-read="parking" data-parked="${parked}" data-next-parking="${nextParking}">${parked ? `${parkingSummary}<button type="button" class="btn" data-revive="${esc(d.id)}">Revive</button>` : parkFormHtml(nextParking)}</div></div>` : fromEngine ? `<div data-detail-read="parking">${nextParking && parked ? parkingSummary : parker}</div>` : ''}</div>
    <div data-detail-read="prospect">${!engineSaves && controlsAvailable && prospect?.client_status === 'prospect' ? `<form id="detailInactiveForm"><p>Inactive prospects return to Leads.</p><label>Reason<input name="reason" maxlength="1000" required value="${esc(pendingProspect?.request.reason || '')}"${pendingProspect ? ' readonly' : ''}></label><button class="btn" type="submit">${pendingProspect ? 'Check outcome' : 'Mark inactive'}</button><p role="status" data-prospect-status>${pendingProspect ? 'Confirmation pending for this prospect. Check outcome to retry the same request.' : ''}</p></form>` : ''}</div>
    ${!fromEngine ? `<div data-detail-read="client-portal">${websiteSetup}</div>` : ''}
    <h2>Critical dates</h2>
    <div data-detail-read="add-critical-date" data-available="${canAddCriticalDate}">${canAddCriticalDate ? criticalDateFormHtml() : ''}</div>
    ${renderCriticalDates(detail, Date.now(), state.nextDealSaves && Number.isSafeInteger(d.seen))}
    <div data-detail-read="updates">${renderDealUpdates(detail)}</div></section>
    <section id="workspace-market-terms" role="tabpanel" aria-labelledby="tab-market-terms" hidden></section>
    <section id="workspace-documents" role="tabpanel" aria-labelledby="tab-documents" hidden>${fromEngine ? `<h2>Documents</h2>${detail.next_deal_saves ? '<div id="deal-document-upload"></div>' : ''}<div data-detail-read="filed-documents">${filedDocumentsHtml(detail.documents)}</div>` : ''}</section>
    <section id="workspace-client-view" role="tabpanel" aria-labelledby="tab-client-view" hidden>${fromEngine ? `<div data-detail-read="client-view">${websiteLink}</div>` : ''}</section>
    <section id="workspace-tours" role="tabpanel" aria-labelledby="tab-tours" hidden></section>
    <section id="workspace-timeline" role="tabpanel" aria-labelledby="tab-timeline" hidden><div data-detail-read="events">${workspaceEventsHtml(detail, nextItem, fromEngine)}</div>${fromEngine ? `<div data-detail-read="old-history">${renderImportedDealHistory(detail.imported_deal_history)}</div>` : renderDealTimeline(detail)}</section>
    <section id="workspace-correspondence" role="tabpanel" aria-labelledby="tab-correspondence" hidden><h2>Correspondence &amp; notes</h2>
      ${fromEngine ? `<div data-detail-read="correspondence">${renderCorrespondence(detail.correspondence, detail.email_follow_ups.filter(row => row.kind === 'file_to_deal').length)}</div>` : '<details id="panelEvidenceSection"><summary>Threads &amp; meetings</summary><div id="panelEvidence"></div></details>'}
      <div data-detail-read="notes">${workspaceNotesHtml(detail)}</div></section>`;
}
function dealUpdateFormHtml(stepEditor, today) {
  const stepFields = `<div class="deal-next-step-fields"><label for="dealUpdateStep">${stepEditor ? 'Your next step' : 'Next step'}</label><input id="dealUpdateStep" name="step" maxlength="10000" autocomplete="off"><label for="dealUpdateDate">Next date</label><input id="dealUpdateDate" name="date" type="date" min="${today}"><small id="detailUpdateDateHint" hidden>Current next date is overdue.</small></div>`;
  const noteField = `<label for="dealUpdate">${stepEditor ? 'Note' : 'Update'}</label><textarea id="dealUpdate" name="text" rows="2" maxlength="10000"${stepEditor ? '' : ' required'}></textarea>`;
  return `<form id="detailUpdateForm" class="deal-update-form" novalidate>
    ${stepEditor ? `${stepFields}<details id="detailNoteEditor"><summary>Add a note</summary>${noteField}</details>`
      : `${noteField}<details id="detailNextStepEditor"><summary>Change next step</summary>${stepFields}</details>`}
    <button class="btn btn-primary" type="submit">${stepEditor ? 'Save next step' : 'Add update'}</button>
    <button class="btn" type="button" data-review-update-step hidden>Review current next step</button>
    <button class="btn btn-quiet" type="button" data-discard-update hidden>Discard draft</button>
    <p id="detailUpdateStatus" role="status"></p>
  </form>`;
}
function criticalDateFormHtml() {
  return `<details class="add-critical-date"><summary>Add critical date</summary>
    <form id="detailAddDateForm">
      <div><label for="criticalDateKind">Kind</label><select id="criticalDateKind" name="kind" required><option value="">Choose a kind</option>
        ${CRITICAL_DATE_OPTIONS.map(([kind, label]) => `<option value="${kind}">${label}</option>`).join('')}
      </select></div>
      <label>Date<input name="due_on" type="date" required></label>
      <label>Where did this date come from?<input name="source" maxlength="1000" required></label>
      <label>Note (optional)<input name="note" maxlength="1000"></label>
      <button class="btn" type="submit">Save critical date</button>
      <p role="status"></p>
    </form>
  </details>`;
}

async function addCriticalDate(deal, form, values) {
  if (!state.panelDetail?.next_deal_saves) return;
  const source = String(values.get('source')).trim();
  const status = form.querySelector('[role="status"]');
  if (!source) {
    status.textContent = 'Enter where the date came from.';
    form.elements.source.focus();
    return;
  }
  const note = String(values.get('note')).trim();
  for (const control of form.elements) control.disabled = true;
  status.textContent = 'Saving…';
  try {
    const result = await runFollowUp(`add-critical-date:${deal}`, {
      verb: 'add-critical-date',
      args: { deal, kind: values.get('kind'), due_on: values.get('due_on'), source, note: note || undefined },
      summary: 'Add critical date',
    });
    if (result?.status !== 'ok') {
      status.textContent = result?.hint || result?.message || 'The date could not be confirmed.';
      return;
    }
    if (!form.isConnected) return;
    form.reset();
    status.textContent = '';
    const editor = form.closest('details');
    editor.open = false;
    editor.querySelector('summary').focus();
    showToast('Critical date added');
  } finally {
    for (const control of form.elements) control.disabled = false;
  }
}

function clientPortalSetupHtml() {
  return `<details class="client-portal-register"><summary>Set up client website</summary><form id="detailClientPortalForm" class="client-portal-form"><label for="clientPortalSlug">Website name</label><input id="clientPortalSlug" name="slug" required maxlength="63" pattern="[a-z0-9][a-z0-9\\-]*" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="practice-name" data-detail-focus="client-portal-slug"><label for="clientPortalPassword">Password</label><input id="clientPortalPassword" type="password" name="password" required maxlength="1024" autocomplete="off" autocapitalize="none" spellcheck="false" data-detail-focus="client-portal-password"><button class="btn" type="submit">Register website</button></form></details><p id="detailClientPortalStatus" role="status"></p>`;
}
async function registerClientPortal(id, form) {
  const slug = String(form.get('slug')).trim().toLowerCase();
  const status = $('detailClientPortalStatus');
  status.textContent = 'Registering…';
  if (state.panelDetail?.next_deal_saves) {
    const input = $('clientPortalPassword');
    const button = $('detailClientPortalForm').querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    input.value = '';
    const message = await saveEngineClientWebsite(id, slug, String(form.get('password')));
    button.disabled = false;
    if (state.panelDeal !== id) return;
    if (status.isConnected) status.textContent = message || 'Website saved.';
    if (!message) await refreshPanel({ changed: true });
    else if (input.isConnected) input.focus();
    return;
  }
  const result = await runFollowUp(`client-portal:${id}`, {
    verb: 'register-client-portal', args: { deal: id, slug, password: String(form.get('password')) },
    summary: 'Client website',
  });
  if (state.panelDeal !== id) return;
  if (result?.status === 'ok') {
    await refreshPanel();
  } else if ($('detailClientPortalStatus')) {
    $('detailClientPortalStatus').textContent = result?.message || 'Client website not confirmed';
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
    const wasEngineDetail = isEngineDealDetail(state.panelDetail);
    const savesChanged = state.panelDetail?.next_deal_saves !== detail.next_deal_saves;
    state.panelDetail = detail;
    const contextRead = pageDocContext?.begin('getDeal', [id]);
    pageDocContext?.finish(contextRead, detail);
    selectDocRecord('deal', id);
    updateDetailTimestamp();
    if (!$('panelBody').querySelector('.deal-opening-snapshot') || wasEngineDetail !== isEngineDealDetail(detail) || savesChanged) paintPanel(detail);
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
        if (fresh.dataset.detailRead === 'checklist') { checklistPanel?.update(detail); continue; }
        if (isEngineDealDetail(detail) && fresh.dataset.detailRead === 'client-portal'
            && current.querySelector('form') && fresh.querySelector('form')) continue;
        if (['board-controls', 'add-critical-date'].includes(fresh.dataset.detailRead) && current.dataset.available === fresh.dataset.available) continue;
        if (fresh.dataset.detailRead === 'parking' && fresh.dataset.parked === 'false'
            && current.dataset.parked === 'false' && current.dataset.nextParking === fresh.dataset.nextParking) continue;
        if (current.innerHTML !== fresh.innerHTML) {
          const expanded = new Set([...current.querySelectorAll('.deal-note details[open]')].map(n => n.closest('.deal-note').dataset.id));
          const focused = current.contains(document.activeElement) ? document.activeElement : null;
          const focusIdentity = focused?.dataset.detailFocus;
          const historyOpen = current.querySelector('.updates-history')?.open;
          const dateOpens = new Set([...current.querySelectorAll('[data-date-id] details[open]')].map(n => n.closest('[data-date-id]').dataset.dateId));
          const oldScroll = current.scrollLeft;
          if (fresh.dataset.detailRead === 'email-followups') {
            for (const input of current.querySelectorAll('[data-email-decision] input')) {
              const replacement = fresh.querySelector(`[data-detail-focus="${CSS.escape(input.dataset.detailFocus)}"]`);
              if (replacement && replacement.defaultValue === input.defaultValue) replacement.value = input.value;
            }
          }
          if (fresh.dataset.detailRead === 'updates') disposeActivityAttribution();
          current.replaceWith(fresh);
          if (fresh.dataset.detailRead === 'updates') mountPanelActivityAttribution();
          fresh.scrollLeft = oldScroll;
          fresh.querySelectorAll('[data-date-id] details').forEach(n => { n.open = dateOpens.has(n.closest('[data-date-id]').dataset.dateId); });
          if (historyOpen && fresh.querySelector('.updates-history')) fresh.querySelector('.updates-history').open = true;
          fresh.querySelectorAll('.deal-note').forEach(n => { if (expanded.has(n.dataset.id)) n.querySelector('details').open = true; });
          if (focusIdentity) {
            const target = [...fresh.querySelectorAll('[data-detail-focus]')].find(n => n.dataset.detailFocus === focusIdentity);
            if (target) target.focus({preventScroll:true});
            else $('panelBody').querySelector('.deal-freshness [data-refresh-detail]')?.focus();
          }
          else if (focused?.id) document.getElementById(focused.id)?.focus({preventScroll:true});
        }
      }
      void factReviewPanel?.refresh();
      void marketTermsPanel?.refresh();
      void dealToursPanel?.refresh();
      void dealDocumentsPanel?.refresh();
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
  const evidence = await loadEvidence(detail);
  if (state.panelDeal !== id || seq !== panelReadSequence) return;
  if (!$('panelEvidenceSection')?.open) return;
  const root = $('panelEvidence');
  const template = document.createElement('div'); template.innerHTML = renderEvidence(evidence);
  if (root.innerHTML === template.innerHTML) return;
  const expanded = new Set([...root.querySelectorAll('details[open]')].map(n => n.querySelector('summary')?.textContent));
  root.innerHTML = template.innerHTML;
  root.querySelectorAll('details').forEach(n => { if (expanded.has(n.querySelector('summary')?.textContent)) n.open = true; });
}
function mountSourcedTerms(terms, dealId) {
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
      const { mountFactReview } = await import('./ui-facts.generated.js');
      if (disposed) return;
      terms.replaceChildren();
      mounted = mountFactReview(terms, { client: state.client, entityRef: dealId, terms: FACT_TERMS });
    } catch {
      if (!disposed) terms.textContent = 'Terms unavailable. Reopen this deal to try again.';
    }
  }
  terms.querySelector('[data-open-terms]').addEventListener('click', loadTerms);
  observer.observe(terms);
  return {
    refresh() { return mounted?.refresh(); },
    dispose() { disposed = true; observer.disconnect(); mounted?.dispose(); },
  };
}

function paintPanel(detail) {
  $('panelTitle').textContent = dealTitle(detail.deal);
  renderWorkspaceFacts(detail);
  factReviewPanel?.dispose();
  marketTermsPanel?.dispose();
  disposeChecklist();
  clientPublicationsPanel?.dispose(); clientPublicationsPanel = null;
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose();
  $('panelBody').innerHTML = workspaceHtml(detail);
  mountChecklist(detail);
  if (watchSubject !== detail.deal.id) disposeWatchControl();
  watchElement ||= document.createElement('div');
  $('workspace-overview').prepend(watchElement);
  watchSubject = detail.deal.id;
  watchControl ||= mountWatchControl(watchElement, {subject:{subject_type:'deal',subject_id:detail.deal.id}});
  factReviewPanel = $('panelTerms') ? mountSourcedTerms($('panelTerms'), detail.deal.id) : null;
  disposeActivityAttribution();
  disposePanelEmailFollowups();
  syncUpdateForm();
  if ($('detailNoteEditor') && updateDraft) {
    $('detailNoteEditor').open = Boolean(updateDraft.text);
    $('detailNextStepEditor').open = !$('detailUpdateForm').querySelector('[data-discard-update]').hidden;
  }
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
        const { mountMarketTerms } = document.documentElement.hasAttribute('data-deals-saves-from-engine')
          ? await import('./ui-market-cutover.generated.js') : await import('./ui-market.generated.js');
        if (marketDisposed) return;
        const element = document.createElement('div');
        const mounted = mountMarketTerms(element, { client: state.client, entityRef: detail.deal.id, submarket: detail.deal.submarket, useType: detail.deal.use_type, dealName: ref => { const match = state.deals.get(ref); return match ? dealTitle(match) : null; } });
        marketTermsViews.set(detail.deal.id, { element, mounted });
        root.replaceChildren(element);
      } catch { if (!marketDisposed) root.textContent = 'Could not load comparable terms. Try again.'; }
      finally { marketLoading = false; }
    },
    refresh() { return marketTermsViews.get(detail.deal.id)?.mounted.refresh(); },
    dispose() { marketDisposed = true; },
  };
  const toursParams = new URLSearchParams(location.search);
  const property = toursParams.get('deal') === detail.deal.id ? toursParams.get('property') : null;
  const propertyRead = new AbortController();
  let toursDisposed = false, toursLoading = false, toursMounted;
  dealToursPanel = {
    async load() {
      if (toursDisposed || toursLoading || toursMounted) return;
      toursLoading = true;
      const root = $('workspace-tours');
      root.textContent = 'Loading tours…';
      if (property && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(property)) {
        const toursUrl = `/deals?deal=${encodeURIComponent(detail.deal.id)}&tab=tours`;
        root.innerHTML = `<section aria-label="Property from tour feedback"><h2 tabindex="-1">Property from tour feedback</h2><p role="status">Loading property…</p><a href="${esc(toursUrl)}">See deal tours</a></section>`;
        const section = root.firstElementChild;
        section.querySelector('h2').focus();
        const params = new URLSearchParams({ property_id: property, as_of: new Date().toISOString() });
        try {
          const [{ propertyPanelView }, { data }] = await Promise.all([
            import('../tours/property-panel.js'),
            readWithDeadline(async signal => {
              const response = await sessionFetch(`/api/tours/property-evidence/v1?${params}`, { signal });
              if (!response.ok) throw Error('Property unavailable');
              return response.json();
            }, { signal: propertyRead.signal }),
          ]);
          if (toursDisposed) return;
          if (data?.schema !== 'tour-property-evidence.v1' || data.property_id !== property) throw Error('Property unavailable');
          const facts = propertyPanelView(data).filter(fact => fact.status === 'reviewed');
          section.querySelector('[role="status"]').remove();
          section.insertAdjacentHTML('beforeend', facts.length
            ? `<dl>${facts.map(fact => `<dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd>`).join('')}</dl>`
            : '<p>No reviewed property details are recorded.</p>');
        } catch {
          if (!toursDisposed) section.querySelector('[role="status"]').textContent = 'Property details are unavailable.';
        }
        return;
      }
      try {
        const [{ mountDealTours }, { createPlannerClient }] = await Promise.all([
          import('./ui-deal-tours.generated.js'), import('../tours/planner-client.js'),
        ]);
        if (toursDisposed) return;
        root.replaceChildren();
        toursMounted = mountDealTours(root, { dealId: detail.deal.id, client: createPlannerClient(), readOnly: detail.next_deal_saves === true || dealsSaveToEngine(), initialTourId: new URLSearchParams(location.search).get('tour'), navigate: (url, push) => writeWorkspaceHistory({...history.state, ...(push ? {doctorcreTourWorkspace:detail.deal.id} : {})}, url, push) });
      } catch {
        if (!toursDisposed) {
          root.textContent = 'Tours unavailable. ';
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = 'Retry tours';
          retry.addEventListener('click', () => void dealToursPanel?.load()); root.append(retry);
        }
      } finally { toursLoading = false; }
    },
    refresh() { return toursMounted?.refresh(); },
    hasUnsavedChanges() { return toursMounted?.hasUnsavedChanges() || false; },
    confirmLeave() { return toursMounted?.confirmLeave() ?? Promise.resolve(true); },
    dispose() { toursDisposed = true; propertyRead.abort(); toursMounted?.dispose(); },
  };
  let documentsDisposed = false, documentsLoading = false, documentsMounted;
  const fromEngine = isEngineDealDetail(detail);
  dealDocumentsPanel = fromEngine && !detail.next_deal_saves ? null : {
    async load() {
      if (documentsDisposed || documentsLoading || documentsMounted) return;
      documentsLoading = true;
      const root = $(fromEngine ? 'deal-document-upload' : 'workspace-documents');
      root.textContent = fromEngine ? 'Loading upload form…' : 'Loading documents…';
      try {
        const { mountDealDocuments, mountDealDocumentUpload } = await import('./ui-deal-documents.generated.js');
        if (documentsDisposed) return;
        root.replaceChildren();
        documentsMounted = fromEngine ? mountDealDocumentUpload(root, {
          dealId: detail.deal.id,
          documents: state.panelDetail.documents,
          request: sessionFetch,
          async refreshDocuments() {
            await refreshPanel({ changed: true });
            return documentsDisposed ? [] : state.panelDetail.documents;
          },
        }) : mountDealDocuments(root, { dealId: detail.deal.id, client: state.client });
      } catch {
        if (!documentsDisposed) {
          root.textContent = fromEngine ? 'Upload form unavailable. ' : 'Documents unavailable. ';
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn';
          retry.textContent = fromEngine ? 'Retry upload form' : 'Retry documents';
          retry.addEventListener('click', () => void dealDocumentsPanel?.load()); root.append(retry);
        }
      } finally { documentsLoading = false; }
    },
    refresh() {
      if (fromEngine) documentsMounted?.update(state.panelDetail.documents);
      else return documentsMounted?.refresh();
    },
    hasUnsavedChanges() { return documentsMounted?.hasUnsavedChanges?.() || false; },
    confirmLeave() { return documentsMounted?.confirmLeave?.() ?? true; },
    dispose() { documentsDisposed = true; documentsMounted?.dispose(); },
  };
  let clientDisposed = false, clientLoading = false, clientMounted;
  clientPublicationsPanel = fromEngine ? null : {
    async load() {
      if (clientDisposed || clientLoading || clientMounted) return;
      clientLoading = true;
      const element = $('workspace-client-view');
      element.textContent = 'Loading client view…';
      try {
        const { mountClientPublications, createPublicationFixture } = await import('./ui-client-publications.generated.js');
        if (clientDisposed) return;
        const mcp = createMcpRequests();
        const request = resolveDealroomBoot(location).mode === 'fixture' ? createPublicationFixture() : async (name, args, { signal }) => {
          const result = await mcp(name, args, { signal, timeoutMs: 10000 });
          if (result.kind !== 'payload') throw Error('Client view unavailable');
          return result.payload;
        };
        element.replaceChildren();
        clientMounted = mountClientPublications(element, { dealId: detail.deal.id, request });
      } catch {
        if (!clientDisposed) {
          element.textContent = 'Client view unavailable. ';
          const retry = document.createElement('button'); retry.className = 'btn'; retry.textContent = 'Retry client view';
          retry.addEventListener('click', () => void clientPublicationsPanel?.load()); element.append(retry);
        }
      } finally { clientLoading = false; }
    },
    dispose() { clientDisposed = true; clientMounted?.dispose(); },
  };
  selectWorkspaceTab(workspaceTab);
  mountPanelActivityAttribution();
  void mountPanelEmailFollowups(detail.deal.id);
}
async function openWorkspace(dealId, trigger, { fromHistory = false } = {}) {
  if (!fromHistory && dealDocumentsPanel && !dealDocumentsPanel.confirmLeave()) return;
  if (!fromHistory && dealToursPanel && !await dealToursPanel.confirmLeave()) return;
  disposeChecklist();
  disposeWatchControl();
  clientPublicationsPanel?.dispose(); clientPublicationsPanel = null;
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose(); dealToursPanel = null;
  factReviewPanel?.dispose();
  factReviewPanel = null;
  marketTermsPanel?.dispose();
  marketTermsPanel = null;
  selectDocRecord('deal', dealId);
  const panel = $('recordPanel');
  disposeActivityAttribution();
  disposePanelEmailFollowups();
  setContextOpenVisible(false);
  if (!state.panelDeal) boardScroll = history.state?.boardScroll ?? scrollY;
  const scope = new URLSearchParams(location.search);
  const focusStep = scope.get('deal') === dealId && scope.get('focus') === 'next-step';
  state.panelStepId = focusStep ? scope.get('step') : null;
  workspaceTab = scope.get('deal') === dealId && scope.has('property') ? 'tours'
    : ['tours','client-view'].includes(scope.get('tab')) ? scope.get('tab') : 'overview';
  timelineType = '';
  state.panelDeal = dealId; state.panelDetail = null; updateDraft = null;
  const url = new URL(location.href);
  if (!fromHistory && url.searchParams.get('deal') !== dealId) {
    url.searchParams.delete('checklist');
    url.searchParams.delete('property');
    url.searchParams.set('deal',dealId);
    writeWorkspaceHistory({...history.state, boardScroll:scrollY}, location.href);
    writeWorkspaceHistory({doctorcreDealWorkspace:true},url,true);
  }
  state.panelReturnTo = trigger?.closest('.kanban-card')?.dataset.id || dealId;
  $('panelTitle').textContent = state.deals.get(dealId)?.name || 'Deal';
  $('panelBody').innerHTML = '<p>Updating…</p>';
  $('workspaceFacts').replaceChildren();
  $('workspaceTabs').innerHTML = workspaceTabs.map(tab => `<button class="workspace-tab" type="button" role="tab" id="tab-${tab.id}" aria-controls="workspace-${tab.id}" aria-selected="${tab.id === workspaceTab}" tabindex="${tab.id === workspaceTab ? 0 : -1}" data-workspace-tab="${tab.id}">${tab.label}</button>`).join('');
  $('main').hidden = true; panel.hidden = false;
  document.body.classList.add('workspace-open');
  scrollTo({ top: 0, behavior: 'instant' });
  $('panelTitle').focus({preventScroll:true});
  await refreshPanel();
  if (focusStep && state.panelDeal === dealId) {
    if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
    await document.fonts.ready;
    if (state.panelDeal !== dealId) return;
    const current = new URL(location.href);
    const step = state.panelStepId;
    const selector = step === null ? '' : CSS.escape(step);
    const target = step === null
      ? $('dealUpdateStep')
      : $('panelBody').querySelector(`[data-detail-focus="next-step-${selector}"], [data-deal-item="${selector}"]`);
    if (target) {
      if (step === null) $('detailNextStepEditor').open = true;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const observer = new ResizeObserver(() => {
        if (document.activeElement !== target) return observer.disconnect();
        const rect = target.getBoundingClientRect();
        if (rect.bottom > innerHeight || rect.top < 0) target.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      observer.observe($('recordPanel'));
      target.addEventListener('blur', () => observer.disconnect(), { once: true });
    }
    current.searchParams.delete('focus');
    current.searchParams.delete('step');
    writeWorkspaceHistory(history.state, current);
  }
}
async function closeWorkspace({ fromHistory = false } = {}) {
  if (!fromHistory && dealDocumentsPanel && !dealDocumentsPanel.confirmLeave()) return;
  if (!fromHistory && dealToursPanel && !await dealToursPanel.confirmLeave()) return;
  disposeChecklist();
  disposeWatchControl();
  clientPublicationsPanel?.dispose(); clientPublicationsPanel = null;
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose(); dealToursPanel = null;
  factReviewPanel?.dispose();
  factReviewPanel = null;
  marketTermsPanel?.dispose();
  marketTermsPanel = null;
  if (!fromHistory && history.state?.doctorcreDealWorkspace) { history.back(); return; }
  if (!fromHistory && incomingScope.has('deal')) {
    const origin = dealsPageOrigin('review') || dealsPageOrigin('national');
    if (origin) { returnToDealsPage(origin); return; }
  }
  selectDocRecord('deal', null);
  pageDocContext?.release('getDeal');
  ++panelReadSequence; ++contextReadSequence;
  $('contextDrawer').close(); $('contextDrawerBody').replaceChildren();
  const id = state.panelReturnTo;
  disposeActivityAttribution();
  disposePanelEmailFollowups();
  if (!fromHistory) { const url = new URL(location.href); url.searchParams.delete('deal'); url.searchParams.delete('checklist'); url.searchParams.delete('property'); writeWorkspaceHistory({},url); }
  $('recordPanel').hidden = true; $('main').hidden = false;
  document.body.classList.remove('workspace-open');
  state.panelDeal = null; state.panelStepId = null; state.panelDetail = null;
  scrollTo(0, history.state?.boardScroll ?? boardScroll);
  state.panelReturnTo = null;
  setContextOpenVisible(false);
  if (id) document.querySelector(`.kanban-card[data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});
}
function fieldPatch(field, value) {
  if (field !== 'operating_state') return {[field]:value};
  return {
    operating_state: value.state,
    parking_note: value.note || null,
    parking_reason: value.reason || null,
  };
}
async function toggleDealAttention(button) {
  const detail = state.panelDetail;
  const deal = detail?.deal;
  if (button.disabled || !detail?.next_deal_saves || !Number.isSafeInteger(deal?.seen) || isClosedDeal(deal)) return;
  button.disabled = true;
  try {
    const result = await sendFieldWrite(deal.id, 'attention', deal.attention !== true);
    recordFieldReceipt(cellKey(deal.id, 'attention'), button.textContent, 'Needs attention', result);
    if (result.status === 'ok' && !result.superseded) {
      confirmLocalWrite(deal.id, { attention: result.request.value });
      renderBoard();
      if (state.panelDeal === deal.id) await refreshPanel();
    }
    renderPendingWrites();
  } finally {
    button.disabled = false;
  }
}

async function setOperatingState(id, value) {
  const result = await sendFieldWrite(id, 'operating_state', value);
  if (result.status === 'ok' && !result.superseded) {
    const accepted = result.request.value;
    confirmLocalWrite(id, fieldPatch('operating_state', accepted));
    showToast(accepted.state === 'active' ? 'Deal revived' : 'Deal parked');
    if (state.panelDeal === id) closeWorkspace();
  } else if (result.conflict) showConflict(result.conflict);
  else if (result.code === 'version_conflict' && Number.isSafeInteger(result.request?.seen_change_id)) {
    recordFieldReceipt(cellKey(id, 'operating_state'), 'Park or revive deal', 'Operating state', result);
  } else { showToast(fieldWriteMessage(result,'Operating state') || 'Change not confirmed', {error:true}); state.boardSync.requestRefresh('operating-state'); }
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
  if (state.nextDealSaves) return;
  state.client.presenceLease({ deal: dealId, field: 'phase', idempotency_key: uuidv4() })
    .catch(() => { /* a courtesy, never a requirement */ });
}

function beginMove(dealId, toSlug, deal = state.deals.get(dealId), { wonOrLost = false } = {}) {
  const intent = moveIntent(deal, toSlug);
  state.lifted = null;
  state.target = null;
  if (!intent) { renderBoard(); return; }
  announce(`Reviewing ${intent.name} for ${intent.to_label}. Nothing has been saved yet.`);
  openCompletion({ ...intent, wonOrLost });
}


function wireBoard() {
  const board = $('kanban');
  if (!board) return;

  const openAttention = () => board.querySelector('.deal-board-attention[aria-expanded="true"]');
  const setAttention = (button, expanded) => {
    button.setAttribute('aria-expanded', String(expanded));
    $(button.getAttribute('aria-controls')).hidden = !expanded;
  };
  const showAttention = button => {
    const current = openAttention();
    if (current && current !== button) setAttention(current, false);
    setAttention(button, true);
  };
  board.addEventListener('focusin', event => {
    if (event.target.matches('.deal-board-attention:focus-visible')) showAttention(event.target);
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('.deal-board-attention');
    const current = openAttention();
    if (button && button !== current) showAttention(button);
    else if (current && !event.target.closest('.deal-board-reason')) setAttention(current, false);
  });

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
    // eslint-disable-next-line no-restricted-syntax -- 1 deferred board paint after pointer release, only when paintDeferred is set; 0 HTTP reads.
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
    const column = event.target.closest('.kanban-column[data-column]');
    if (!column) return;
    event.preventDefault();
    column.dataset.drop = 'true';
  });
  board.addEventListener('dragleave', (event) => {
    const column = event.target.closest('.kanban-column[data-column]');
    if (column) column.removeAttribute('data-drop');
  });
  board.addEventListener('drop', (event) => {
    const column = event.target.closest('.kanban-column[data-column]');
    if (!column) return;
    event.preventDefault();
    column.removeAttribute('data-drop');
    beginMove(event.dataTransfer.getData('text/plain'), column.dataset.column);
  });

  board.addEventListener('keydown', (event) => {
    const current = openAttention();
    if (event.key === 'Escape' && current) {
      event.preventDefault();
      setAttention(current, false);
      return;
    }
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
    writeWorkspaceHistory({},url);
    renderChips();
    renderBoard();
  });

  document.addEventListener('click', async (event) => {
    const website = event.target.closest('[data-open-client-website]');
    if (website) {
      const id = website.dataset.openClientWebsite;
      const onDealPage = $('panelBody').contains(website);
      website.disabled = true;
      const message = await openEngineClientWebsite(id);
      website.disabled = false;
      if (message && (!onDealPage || state.panelDeal === id)) showToast(message, { error: true });
      return;
    }
    const item = event.target.closest('[data-deal-item]');
    if (item) { itemSheet.open(item.dataset.itemDeal,item.dataset.dealItem,item); return; }
    const revive = event.target.closest('button[data-revive]');
    if (revive) { setOperatingState(revive.dataset.revive, {state:'active'}); return; }
    const open = event.target.closest('button[data-open]');
    if (open) { openWorkspace(open.dataset.open, open); return; }
    const retry = event.target.closest('button[data-retry-write]');
    // eslint-disable-next-line no-restricted-syntax -- Only an explicit retry-button click reconciles the retained field write; no automatic resend occurs.
    if (retry) { retryFieldWrite(retry.dataset.retryWrite); return; }
    const phaseUndo = event.target.closest('button[data-undo-phase], #closedDealsView button[data-undo-invoice]');
    if (phaseUndo) {
      const onDealPage = $('panelBody').contains(phaseUndo);
      const result = await automaticPhase.undo(phaseUndo);
      if (onDealPage && state.panelDeal === phaseUndo.dataset.undoPhase
          && (result?.status === 'ok' || result?.code === 'version_conflict')) await refreshPanel();
      return;
    }
    const undo = event.target.closest('button[data-undo]');
    if (undo) { runUndo(undo.dataset.undo); return; }
    const openDeal = event.target.closest('button[data-open-deal]');
    const card = event.target.closest('.kanban-card');
    if (card && card.dataset.dragging !== 'true' && !event.target.closest('button,input,select,a,.deal-vendor-details,.deal-board-reason')) { openWorkspace(card.dataset.id, card); return; }
    if (openDeal) {
      openWorkspace(openDeal.dataset.openDeal, null);
    }
  });

  $('addDealStage').innerHTML = '<option value="" hidden>Choose a phase</option>'
    + OPEN_COLUMNS.map(c => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('');
  $('addDealOpen').addEventListener('click', () => openAddDeal());
  $('addDealForm').addEventListener('submit', submitDeal);
  $('addDealCancel').addEventListener('click', () => $('addDealDialog').close());
  $('addDealDialog').addEventListener('cancel', event => { if (creatingDeal) event.preventDefault(); });
  $('addDealDialog').addEventListener('close', () => {
    if (!dealCreation && !$('addDealDialog').open) {
      unmountDealClientPicker?.();
      unmountDealClientPicker = undefined;
    }
    if (!prospectConversion) $('addDealOpen').focus();
  });

  let restoreTourHistory = null, departurePending = false;
  addEventListener('popstate', async event => {
    const destinationIndex = event.state?.doctorcreWorkspaceIndex ?? 0;
    if (restoreTourHistory) {
      if (destinationIndex !== workspaceHistoryIndex) { history.go(workspaceHistoryIndex - destinationIndex); return; }
      const restored = restoreTourHistory; restoreTourHistory = null; restored(); return;
    }
    if (dealToursPanel?.hasUnsavedChanges() || dealDocumentsPanel?.hasUnsavedChanges()) {
      const distance = destinationIndex - workspaceHistoryIndex;
      if (!distance) return;
      const restored = new Promise(resolve => { restoreTourHistory = resolve; });
      history.go(-distance);
      if (departurePending) return;
      departurePending = true;
      await restored;
      const leave = (dealDocumentsPanel?.confirmLeave() ?? true) && (await dealToursPanel?.confirmLeave() ?? true);
      departurePending = false;
      if (leave) history.go(distance);
      return;
    }
    workspaceHistoryIndex = destinationIndex;
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
    const confirm = $('completionConfirm');
    if (!intent || confirm.disabled) return;
    confirm.disabled = true;
    try {
      const outcome = await runMove(intent, {
        evidence: $('completionEvidence')?.value,
        changeReason: $('completionReason')?.value,
        humanQuote: $('completionQuote')?.value,
        nextStep: $('completionNextStep')?.value,
        replaceNextStep: Boolean(intent.reviewedStep),
        nextWhen: $('completionNextWhen')?.value,
        effectiveDate: $('completionDate')?.value,
        recordCriticalDate: $('completionCritical')?.checked === true,
        dateSource: $('completionSource')?.value,
        outcome: chosenOutcome(),
        closedOn: $('completionClosedOn')?.value,
        wonValue: $('completionWonValue')?.value,
        lostReason: $('completionLostReason')?.value,
      });
      if (state.intent !== intent) return;
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
      if (!outcome.reload && state.panelDeal === intent.deal) await refreshPanel();
    } finally { confirm.disabled = false; }
  });

  $('conflictCancel')?.addEventListener('click', () => $('conflictDialog')?.close());
  $('conflictForm')?.addEventListener('submit', (event) => { event.preventDefault(); resolveConflictChoice(); });

  $('retryRead')?.addEventListener('click', () => loadBoard());
  const changeView = view => {
    state.view = view;
    const url = new URL(location.href); url.searchParams.set('view',view); writeWorkspaceHistory({},url);
    $('boardView').setAttribute('aria-pressed', String(view === 'board'));
    $('listView').setAttribute('aria-pressed', String(view === 'list'));
    $('lostView').setAttribute('aria-pressed', String(view === 'lost'));
    $('closedView').setAttribute('aria-pressed', String(view === 'closed')); renderBoard();
  };
  $('lostView').addEventListener('click', () => changeView('lost'));
  $('closedView').addEventListener('click', () => changeView('closed'));
  $('closedSearch').addEventListener('input', renderClosedDeals);
  $('retryHistory').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await state.boardSync.refreshBoard({ reason: 'retry-history' }); }
    finally { button.disabled = false; }
  });
  $('boardView').addEventListener('click', () => changeView('board'));
  $('listView').addEventListener('click', () => changeView('list'));
  $('parkedToggle').addEventListener('click', () => { state.parkedOpen = !state.parkedOpen; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); renderBoard(); });
  $('kanban').addEventListener('toggle', e => { if(e.target.classList.contains('parked-lane')) { state.parkedOpen=e.target.open; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); } },true);
  $('panelBody').addEventListener('toggle', event => {
    if (event.target.id !== 'panelEvidenceSection') return;
    if (event.target.open && state.panelDetail) void refreshEvidence(state.panelDetail, state.panelDeal, panelReadSequence);
  }, true);
  $('panelBody').addEventListener('click', async e => {
    if (e.target.closest('[data-undo-invoice]')) void undoInvoiceClose();
    const done = e.target.closest('[data-complete-step]');
    if (done) return completeDealStep(done);
    const attention = e.target.closest('[data-deal-attention]');
    if (attention) return toggleDealAttention(attention);
    if (e.target.closest('[data-discard-update]') && !pendingCommand(commandState, updateKey(state.panelDeal)) && !pendingCommand(commandState, nextStepKey(state.panelDeal))) {
      discardUpdate(state.panelDeal);
      syncUpdateForm();
      ($('detailNoteEditor') ? $('dealUpdateStep') : $('dealUpdate')).focus();
    }
    if (e.target.closest('[data-review-update-step]') && updateDraft?.conflict) {
      const draft = updateDraft;
      void readDealDetail(draft.id).then(detail => {
        if (updateDraft !== draft || draftActor !== state.selfActor) return;
        draft.reviewed = reviewedDealStep(detail);
        draft.conflict = false;
        draft.message = `Current next step: ${noteText(draft.reviewed.next_step) || 'None'} (${formatCalendarDate(draft.reviewed.next_date) || 'no date'}). Retry to replace it.`;
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
      const detail = state.panelDetail?.deal;
      e.target.value = columnByValue(detail?.phase ?? state.deals.get(id)?.phase)?.slug || '';
      beginMove(id, destination, Number.isSafeInteger(detail?.seen) ? detail : undefined);
    }
    if (e.target.id === 'detailOwner') {
      const result = await sendFieldWrite(id, 'owner', e.target.value || null);
      if (result.status === 'ok' && !result.superseded) confirmLocalWrite(id, { owner: result.request.value });
      else if (result.conflict) showConflict(result.conflict);
      else if (result.code === 'version_conflict' && Number.isSafeInteger(result.request?.seen_change_id)) {
        recordFieldReceipt(cellKey(id, 'owner'), 'Change deal owner', 'Owner', result);
      } else showToast(fieldWriteMessage(result, 'Owner') || 'Change not confirmed', { error: true });
      renderPendingWrites();
    }
  });
  $('panelBody').addEventListener('submit', async e => {
    e.preventDefault(); const id=state.panelDeal; const form = new FormData(e.target);
    const proposal = e.target.dataset.emailDecision;
    const choice = e.submitter?.value;
    if (proposal && state.panelDetail?.next_deal_saves && ['accept', 'dismiss'].includes(choice)) {
      let edits;
      if (choice === 'accept' && form.has('what')) {
        const what = String(form.get('what')).trim();
        if (!what) {
          showToast('Enter a next step before accepting.', {error:true});
          e.target.elements.what.focus();
          return;
        }
        edits = { what, due_on: form.get('due_on') || null };
      }
      await runFollowUp(`deal-email:${id}:${proposal}`, {
        verb:'decide-engine-deal-email',
        args:{ deal:id, proposal_id:proposal, decision:choice, ...(edits && { edits }) },
        summary:'Email follow-up',
      });
      return;
    }
    if (e.target.id === 'detailAddDateForm') {
      await addCriticalDate(id, e.target, form);
      return;
    }
    const date = e.target.dataset.dateDecision;
    if (date && state.nextDealSaves && Number.isSafeInteger(state.panelDetail?.deal?.seen)) {
      const decision = e.submitter?.value;
      const reason = String(form.get('reason') || '').trim();
      if (decision !== 'confirm' && (!['done', 'dropped', 'passed'].includes(decision) || !reason)) {
        showToast('Enter a reason for changing this date.', {error:true});
        return;
      }
      const args = { deal:id, seen_change_id:state.panelDetail.deal.seen, critical_date_id:date,
        ...(decision !== 'confirm' && {resolution:decision, reason}) };
      await runFollowUp(`critical-date:${id}:${date}`, {
        verb:decision === 'confirm' ? 'confirm-critical-date' : 'resolve-critical-date', args, summary:'Critical date',
      });
    }
    if (e.target.id === 'detailParkForm') {
      const reason = String(form.get('reason') || '');
      if (form.has('note')) {
        if (!PARKING_REASONS.has(reason)) return;
        await setOperatingState(id, { state: 'parked', reason, note: String(form.get('note')).trim() || null });
      } else {
        await setOperatingState(id, { state: 'parked', reason: 'other', note: reason });
      }
    }
    if (e.target.id === 'detailInactiveForm') await markProspectInactive(e.target,id,String(form.get('reason')).trim());
    if (e.target.id === 'detailUpdateForm') await saveUpdate(id);
    if (e.target.id === 'detailClientPortalForm') await registerClientPortal(id, form);
  });

  // eslint-disable-next-line no-restricted-syntax -- Online events only update board-sync connectivity; the shared capped poller owns reads.
  globalThis.addEventListener?.('online', () => { state.boardSync.setOnline(true); });
  globalThis.addEventListener?.('offline', () => state.boardSync.setOnline(false));
}

function mountDock() {
  const root = $('receiptDock');
  if (!root) return;
  dock = createCommandDock({
    root,
    onReload: (operationKey, { request }) => {
      dock.forget(operationKey);
      void loadBoard();
      if (request?.deal === state.panelDeal) void refreshPanel({ changed: true });
    },
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      // eslint-disable-next-line no-restricted-syntax -- Only a dock retry click reconciles the retained field write; one reconciliation per click.
      if (entry?.kind === 'field') retryFieldWrite(operationKey);
      else if (entry?.kind === 'outcome-read') return runOutcomeWrite(operationKey, entry.step, entry.intent);
      else if (entry?.kind === 'follow-up-read') return runFollowUp(operationKey, entry.step);
      else if (entry?.args) runFollowUp(operationKey, { verb: entry.verb, args: entry.verb === 'register-client-portal' ? pendingCommand(commandState, operationKey)?.request || entry.args : entry.args, summary: entry.summary });
    },
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      // eslint-disable-next-line no-restricted-syntax -- Only a dock undo/retry action reconciles the retained field write; one reconciliation per action.
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
function dealsPageOrigin(view) {
  if (!document.referrer) return null;
  const referrer = new URL(document.referrer);
  return referrer.origin === location.origin && referrer.pathname === '/deals'
    && referrer.searchParams.get('view') === view ? referrer : null;
}

function returnToDealsPage(origin) {
  if (history.length > 1) history.back();
  else location.replace(origin);
}

async function boot() {
  mountPrefs();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: '', search: '' });
  if ($('mondayReview')) {
    if (resolved.mode !== 'live') return;
    if (incomingScope.get('view') === 'dropped-prospect') {
      const { mountDroppedProspect } = await import('./ui-deal-prospects.generated.js');
      const origin = dealsPageOrigin('review');
      const returnTo = origin?.href || '/deals?view=review&mode=live';
      document.title = 'Prospect · DoctorCRE';
      mountDroppedProspect($('mondayReview'), {
        id: incomingScope.get('prospect'), request: fetchRead, authorLabel, returnTo,
        back: origin ? () => returnToDealsPage(origin) : undefined,
      });
      return;
    }
    state.client = createLiveClient();
    const { mountMondayReview } = await import('./ui-monday-review.generated.js');
    const day = new Date(`${businessDay()}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    const week = day.toISOString().slice(0, 10), path = '/api/engine/weekly-reviews';
    mountMondayReview($('mondayReview'), {
      async read(signal) {
        const response = await fetchRead(`${path}?week_of=${week}`, { signal });
        if (!response.ok) throw new Error('Review unavailable');
        return { review: await response.json(), canEdit: response.headers.get('x-doctorcre-deal-saves') === 'on' };
      },
      async edits() {
        const { actor } = await state.client.askSession();
        state.selfActor = actor;
        state.client = createLiveClient({ selfActor: actor });
        return {
          actor, prospect: prospectClient(), today: businessDay(),
          async step(id) { return partnerDealStep(await readDealDetail(id), actor); },
          mark(row, confirm) {
            const markId = row.reviewed?.id;
            const key = `weekly:${week}:${row.kind}:${row.id}:${markId ?? 'mark'}`;
            const seen_change_id = row.reviewVersion;
            const fields = markId ? { seen_change_id }
              : { seen_change_id, week_of: week, [row.kind === 'deal' ? 'deal_id' : 'party_id']: row.id };
            return state.client.savePartnerRecord(markId ? `${path}/${encodeURIComponent(markId)}/remove` : path,
              key, 'review_id', confirm ? undefined : fields);
          },
          async deal(row, edit) {
            if (!Number.isSafeInteger(row.seen)) return { status: 'failed' };
            const isNote = edit.kind === 'note';
            return runFollowUp(isNote ? updateKey(row.id) : nextStepKey(row.id), {
              verb: isNote ? 'add-deal-note' : 'set-next-step',
              args: { deal: row.id, text: edit.text, ...(!isNote && { next_date: edit.due }) },
              summary: isNote ? 'Deal update' : 'Next step',
              reviewed: isNote ? { seen: row.seen } : { seen: row.seen, currentStep: edit.current },
            });
          },
        };
      },
      async dealNotes(id, signal) {
        const detail = await readDealDetail(id, signal);
        return detail.thread.filter(note => note.kind === 'note').slice(0, 3).map(note => ({
          id: note.id, summary: noteText(note.text), by: note.actor, at: note.at || note.created_at || note.recorded_at,
        }));
      },
      phaseLabel: phase => columnBySlug(phase)?.label,
      authorLabel, dateLabel: formatCalendarDate, timeLabel: sourceTime,
    });
    return;
  }
  if (incomingScope.has('deal') && dealsPageOrigin('review')) {
    $('panelClose').textContent = '← Back to Monday review';
    $('panelClose').setAttribute('aria-label', 'Back to Monday review');
  }
  if (incomingScope.get('mode') === 'live') $('mondayReviewLink').href = '/deals?view=review&mode=live';

  mountDock();
  wire();
  state.client = resolved.mode === 'live' ? createLiveClient() : await (await import("./fixture-client.js")).createFixtureClient(resolved.options);
  mountNotificationBadge(state.client);
  itemSheet = mountDealItemSheet({document,today:() => state.boardFromEngine || isEngineDealDetail(state.panelDetail) ? businessDay() : todayIso(),read:readDealDetail,send:runFollowUp,pending:key => pendingCommand(commandState,key),refresh:() => {state.boardSync.requestRefresh('deal-item');refreshPanel();}});
  state.mode = state.client.mode;
  const identity = deploymentIdentity(state.mode);
  $('deploymentBadge').textContent = identity.label;
  $('deploymentBadge').dataset.mode = identity.mode;
  $('deploymentBadge').title = identity.detail;
  state.selfActor = state.client.selfActor || null;
  state.boardSync = createBoardSync({
    readBoard: () => state.client.getBoard({ workspace: 'team' }),
    readChanges: (cursor) => state.client.getChanges(cursor),
    usesChangeFeed: () => !state.boardFromEngine && !state.nextDealSaves && state.client.changeFeedEnabled !== false,
    applyBoard: (board) => { applyBoardSnapshot(board); },
    onStatus: renderStatus,
  });
  $('boardView').setAttribute('aria-pressed',String(state.view === 'board'));
  $('listView').setAttribute('aria-pressed',String(state.view === 'list'));
  $('lostView').setAttribute('aria-pressed',String(state.view === 'lost'));
  $('closedView').setAttribute('aria-pressed',String(state.view === 'closed'));
  const linkedDeal = incomingScope.get('deal');
  const opening = linkedDeal && openWorkspace(linkedDeal);
  const board = loadBoard();
  if (opening) void opening.then(async () => {
    if (state.panelDeal !== linkedDeal) return;
    if (incomingScope.get('close') === '1') {
      const url = new URL(location.href);
      url.searchParams.delete('close');
      writeWorkspaceHistory(history.state, url);
      await board;
      const deal = state.panelDetail?.deal;
      if (state.panelDeal !== linkedDeal || !deal || isClosedDeal(deal)) return;
      if (state.nextDealSaves && !Number.isSafeInteger(deal.seen)) return;
      const closingDeal = state.nextDealSaves ? deal : { ...deal, seen: undefined };
      beginMove(linkedDeal, CLOSED_SLUG, closingDeal, { wonOrLost: true });
    } else if (incomingScope.get('item')) void itemSheet.open(linkedDeal, incomingScope.get('item'));
  });
  mountVisibilityPoll({ lifecycle: true, poll: refreshPanel });
  mountVisibilityPoll({ poll: () => { return pollOnce().catch(() => false); } });
  mountVisibilityPoll({ lifecycle: state.client.changeFeedEnabled === false, poll: () => state.boardSync.requestRefresh('periodic') });


}

if (globalThis.document) boot();

export { state };
/** Read-only view of the command dock's entries, for tests that prove what it retains. */
export const dockEntries = () => dock.entries ?? new Map();
