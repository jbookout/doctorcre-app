import { mountDealPlan } from './ui-deal-plan.generated.js';
import { hasTourDrafts, legacyTourDraftScope, TOUR_DRAFT_KEYS } from './offline-tour-session.js';
import { createDayStore } from '../tours/day-store.js';
import { emailConversation, redactEmailAddresses, suggestionEmail } from './ui-deal-suggestion-email.generated.js';
import { createMcpRequests } from './mcp-requests.mjs';
import { dealPathHtml, pathQuestionHtml } from './ui-deal-path.generated.js';
import { clientPortalHtml, copyClientLink } from './ui-deal-client-portal.generated.js';
import { workCard } from './work-card.js';
import { bindCardQuickMenu } from './ui-card-menu.generated.js';
import {
  attentionLineHtml, autoHtml, automaticPhaseReceipt, dealDueDate, dealNextStep, dealTypeFacts, lossReasonLabel, renderDealFacts, renderDealItemButton,
  missingNextStep, renderDealItems, renderEndedDealList, renderInvoiceClose, renderOverdueFlag, renderPhaseReceipt, stepText,
} from './deal-items.js';
import { mountDealItemSheet } from './deal-item-sheet.js';
import { OWNER_FILTERS } from './owner-filters.js';
import { engagementWriterFor } from './prospect-engagement.mjs';
import { showToast } from './toast.js';
import { submitOnEnter } from './ui-keyboard-input.generated.js';
import { foldEmailBody } from './ui-email-fold.generated.js';
import { renderDealActivity, renderLatestActivity, showActivityFilter } from './ui-deal-activity.generated.js';
import { dealInvoiceHtml, dealPeopleHtml } from './ui-deal-overview-side.generated.js';
import { renderDealVendors } from './deal-vendors.js';
import { openEngineClientWebsite, renderClientPortalLink, saveEngineClientWebsite } from './client-portal-link.js';
import { clearPrivateTextDrafts, privateSession, privateTextDraft, sessionFetch } from './private-session.js';
import { pageDocContext, selectDocRecord, setDocFilters, publishDocRead } from './doc-context.js';
import { createCommandDock } from './command-dock.js';
import { readWithDeadline } from './auto-refresh.mjs';
import { fetchRead } from './current-read.mjs';
import { preserveBoardFocus } from './board-focus.mjs';
import { showScrollThumbs } from './ui-scroll-thumb.generated.js';
import { performCommand, pendingCommand } from './command-feedback.mjs';
import { createLiveClient, dealTypeLabel } from './live-client.js';
import { emailSubject, emailPlaceholderText, loadEvidence, renderEvidence } from './correspondence.js';
import { dealToursFromEngine, dealsSaveToEngine, deploymentIdentity, resolveDealroomBoot } from './boot-mode.js';
import { ACTOR_LABEL, authorLabel } from './client.js';
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
  compareInstants, escapeText, fieldLabel, readableValue, ingestChangeEvents, receiptViews, receiptListHtml,
  receiptsSignature, createFeedProgress, observeChangeBatch, performUndo,
} from './change-receipts.mjs';
import {
  CLOSED_SLUG, COLUMNS, OPEN_COLUMNS, closedColumnCaption, columnBySlug, columnByValue,
  boardHeadline, columnLabel, completionPlan, groupByColumn, keyboardTarget,
  moveIntent, moveSummary, moveTitle, noteText, dealName,
} from './pipeline-model.js';
import { attentionReason, isClosedDeal, localDeals, overdueLabel, overdueSince } from './deal-review-model.js';
import { lostDeals, closedDeals, urgencyOrder, concise, invoiceClose, isPhaseMoveReceipt, isEngineDealDetail, prepareDealDetail, dealStepVersion, nationalMarketLabel, ordinaryOpenSteps, partnerDealStep, PARKING_REASONS, PHASE_TRIGGERS } from './local-deals-model.js';
import { sourceTime, stepOriginLabel } from './email-source-line.js';
import {
  mountActivityAttribution, renderDealTimeline, renderDealUpdates, renderCriticalDates, askDateReason,
  dealTimeline, dateCaption, calendarDay, changeText, importedHistoryEntries, timelineActor, CRITICAL_DATE_OPTIONS,
} from './deal-timeline.js';
import { uuidv4 } from './uuid.js';
import { linkRecordNames } from './ui-record-links.generated.js';
import { mountVisibilityPoll } from './visibility-poll.mjs';
import { pageScroller } from './touch-layout.js';


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
  scopeFilter: ['flagged', 'no-next-step'].includes(incomingScope.get('filter')) ? incomingScope.get('filter') : 'all',
  view: ['list','timeline','closed','lost'].includes(incomingScope.get('view')) ? incomingScope.get('view') : 'board',
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
  boardRead: false,
  prospectCount: null,
  unplaced: 0,
};

let prospects;
/** The phase Home linked to, focused once on the first painted board. */
let linkedColumn = incomingScope.get('column');

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
  state, performCommand, newKey: uuidv4, render: renderBoard, report: announce,
  renderDetail: renderPhaseUndo, refreshDetail: () => refreshPanel({ fresh: true }),
  refreshedMessage: 'The deal page was refreshed.',
});

function detailPhaseMoveHtml(detail) {
  const deal = detail.deal;
  if (!isEngineDealDetail(detail)) return isClosedDeal(deal) ? '' : autoHtml(deal);
  const receipt = automaticPhaseReceipt(deal, automaticPhase.detailFeedback(deal.id), {
    showEngineMoves: isPhaseMoveReceipt(deal.phase_change), canUndo: detail.next_deal_saves === true,
  });
  return renderPhaseReceipt(deal, receipt, '');
}

function renderPhaseUndo() {
  const host = $('panelBody')?.querySelector('[data-phase-move]');
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
  return `<details class="park-options"><summary class="park-control">Park deal</summary><form id="detailParkForm">${fields}<button class="btn park-control" type="submit">Park</button></form></details>`;
}
function dealOwnerFirstSteps(deal, actions) {
  const steps = ordinaryOpenSteps(actions);
  const ownerStep = steps.find(step => step.owner === deal.owner);
  return ownerStep ? [ownerStep, ...steps.filter(step => step !== ownerStep)] : steps;
}
function listNextStepHtml(deal) {
  const [step] = dealOwnerFirstSteps(deal, deal.open_actions);
  if (!step) return '<p class="deal-list-next-step">No next step set</p>';
  return `<p class="deal-list-next-step"><span>${esc(stepText(step))}</span> · ${dueDateHtml(calendarDay(step.due_on), businessDay())}</p>`;
}
function dealAttentionHtml(deal) {
  return attentionReason(deal) ? '<span class="deal-attention-label">Needs attention</span>' : '';
}
function ownerMarkHtml(name) {
  return `<span class="owner" title="Owner: ${esc(name)}"><span aria-hidden="true">${esc(name === 'Unassigned' ? '?' : name.slice(0, 1))}</span><span class="sr-only">Owner: ${esc(name)}</span></span>`;
}
function cardAttentionHtml(deal) {
  const reason = esc(attentionReason(deal) ?? '');
  if (!reason) return '';
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
    attributes: `data-id="${esc(deal.id)}" data-shortcut-card ${moveAttrs} aria-label="${esc(dealTitle(deal))}, ${esc(parked ? 'Parked' : columnLabel(deal.phase))}"`,
    title: `<button class="card-open" type="button" data-open="${esc(deal.id)}" data-shortcut-open>${esc(dealTitle(deal))}</button>`,
    meta: `${badge}${ownerMarkHtml(actorName(deal.owner))}` });
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
  const attention = attentionReason(deal) !== null;
  const parking = parked ? parkingSummaryHtml(deal) : '';
  const website = parked && state.nextDealSaves ? renderClientPortalLink(deal.client_portal_url, deal.id) : '';
  const revive = parked ? `<button class="btn btn-quiet" type="button" data-revive="${esc(deal.id)}">Revive</button>` : '';
  const move = automaticPhaseReceipt(deal, null, { showEngineMoves: state.boardFromEngine, canUndo: false });
  return workCard({ variant: 'row', className: `kanban-card deal-row${parked && !state.boardFromEngine ? ' parked-card' : ''}`, heading: 'h4', attributes: `data-id="${esc(deal.id)}" data-shortcut-card tabindex="0" data-attention="${attention}"`,
    title: `<button class="card-open" type="button" data-open="${esc(deal.id)}" data-shortcut-open>${esc(dealTitle(deal))}</button>`,
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
let addDealPhase = null;
let unmountDealClientPicker;
let creatingDeal = false;
function syncDealCreation() {
  $('addDealFields').disabled = creatingDeal || Boolean(dealCreation);
  $('addDealSubmit').disabled = creatingDeal;
  $('addDealCancel').disabled = creatingDeal;
  $('addDealSubmit').textContent = creatingDeal ? 'Saving…' : dealCreation ? 'Check creation outcome' : 'Create deal';
}

const ADD_DEAL_FLAG = 'doctorcre.quick-switcher.open-add-deal';
let addDealRequested = false;

function takeAddDealRequest() {
  try {
    const requested = sessionStorage.getItem(ADD_DEAL_FLAG) === '1';
    sessionStorage.removeItem(ADD_DEAL_FLAG);
    return requested;
  } catch {
    return false;
  }
}
async function openAddDeal(client = null, conversion = null, phase = null) {
  const dialog = $('addDealDialog');
  if (dialog.open) return;
  addDealPhase = phase;
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
    if (phase) $('addDealStage').value = phase;
    else $('addDealStage').selectedIndex = prospect ? 0 : 1;
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
    .filter(d => state.scopeFilter !== 'flagged' || attentionReason(d) !== null)
    .filter(d => state.scopeFilter !== 'no-next-step' || missingNextStep(d));
}
function renderBoardMessage(status = state.boardSync?.status()) {
  if (status && (!status.online || [HEALTH.FAILED,HEALTH.RENDER_FAILED].includes(status.board_health))) {
    say('The board is unavailable. Refresh to try again.');
    return;
  }
  if (!state.boardRead) { say('Updating…'); return; }
  const headline = boardHeadline(groupByColumn(visibleBoardDeals()));
  // Deals without a next step leave prospects out: they are not deals yet.
  const count = state.scopeFilter === 'no-next-step' ? null : state.prospectCount;
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

const placeholderLines = '<span class="skeleton-line"></span><span class="skeleton-line short"></span>';
function boardPlaceholderHtml() {
  if (state.view === 'list') return `<div class="deal-list board-placeholder" aria-hidden="true">${`<div class="board-placeholder-row">${placeholderLines}</div>`.repeat(6)}</div>`;
  return [3, 2, 2, 1, 1, 1, 1].map(cards => `<div class="kanban-column board-placeholder" aria-hidden="true"><h3><span class="skeleton-line short"></span></h3>${`<div class="board-placeholder-card">${placeholderLines}</div>`.repeat(cards)}</div>`).join('');
}
const dealPlaceholderHtml = `<p class="sr-only" role="status">Updating…</p><div class="deal-placeholder" aria-hidden="true">${`<section class="panel-section"><span class="skeleton-line short"></span><span class="skeleton-line"></span><span class="skeleton-line"></span>${placeholderLines}</section>`.repeat(2)}</div>`;
// Until the first snapshot lands the board shows its shape; a failed or offline first read leaves it empty.
function renderBoardPlaceholder() {
  const board = $('kanban');
  if (state.boardRead || ['closed','lost'].includes(state.view)) return;
  const status = state.boardSync.status();
  const reading = status.online && ![HEALTH.FAILED, HEALTH.RENDER_FAILED].includes(status.board_health);
  board.setAttribute('aria-busy', String(reading));
  board.innerHTML = reading ? boardPlaceholderHtml() : '';
}

let boardTimeline;
let dealPlan;
function renderPlan(detail) {
  const host = $('workspace-plan');
  if (!host || workspaceTab !== 'plan' || !detail?.plan) return;
  dealPlan ??= mountDealPlan(host);
  dealPlan.update({
    mode: 'plan', today: businessDay(), viewer: state.selfActor,
    plan: detail.plan, deal: detail.deal.id,
    phase: columnByValue(detail.deal.phase)?.slug, steps: detail.next_actions || [],
  });
}

function renderBoard() {
  const board = $('kanban');
  if (!board) return;
  const timeline = state.view === 'timeline';
  $('timelineView').hidden = !state.boardFromEngine;
  $('timelineView').setAttribute('aria-pressed', String(timeline));
  $('boardTimeline').hidden = !timeline;
  $('boardTimelineTools').hidden = !timeline;
  board.hidden = timeline || ['closed','lost'].includes(state.view);
  $('boardLive').hidden = timeline || ['closed','lost'].includes(state.view);
  $('closedDealsView').hidden = !['closed','lost'].includes(state.view);
  $('parkedToggle').hidden = timeline || ['closed','lost'].includes(state.view);
  if (['closed','lost'].includes(state.view)) { renderClosedDeals(); return; }
  if (!state.boardRead) { renderBoardPlaceholder(); return; }
  board.removeAttribute('aria-busy');
  if (board.dataset.pressed === 'true' || board.dataset.quickMenuOpen === 'true' || board.querySelector('[data-dragging="true"]')) { state.paintDeferred = true; return; }
  state.paintDeferred = false;
  const rows = visibleBoardDeals();
  setDocFilters({ owner: state.personalScope ? state.selfActor : state.filter, filter: state.scopeFilter });
  if (state.panelDeal) {
    if (state.panelDetail) publishDocRead('getDeal', state.panelDetail, [state.panelDeal]);
    selectDocRecord('deal', state.panelDeal);
  }
  publishDocRead('getBoard', { deals: rows });
  renderBoardMessage();
  if (timeline) {
    boardTimeline ??= mountDealPlan($('boardTimeline'));
    const deals = rows.flatMap(deal => {
      const phase = columnByValue(deal.phase)?.slug;
      return phase && deal.timeline ? [{ ...deal, phase }] : [];
    });
    boardTimeline.update({ mode: 'board', deals, toolsHost: $('boardTimelineTools'), today: businessDay(), viewer: state.selfActor });
    return;
  }
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
        ${content}${collapsed ? '' : `<button class="column-add" type="button" data-add-to="${esc(column.value)}" aria-label="Add deal to ${esc(column.label)}">+ Add deal</button>`}
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
  const stage = focusedStage ?? linkedColumn;
  linkedColumn = null;
  if (stage) board.querySelector(`[data-collapse-stage="${CSS.escape(stage)}"]`)?.focus();
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
      : [SYNC_STATES.STARTING, SYNC_STATES.SYNCING].includes(status.state) ? '' : 'Unavailable';
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
  state.boardRead = true;
  const saveSwitchChanged = Boolean(state.nextDealSaves) !== (board.next_deal_saves === true);
  state.selfActor = board.actor || state.client.selfActor || state.selfActor;
  state.nextDealSaves = board.next_deal_saves === true;
  const boardFromEngine = board.board_from_engine === true;
  const boardSourceChanged = state.boardFromEngine !== boardFromEngine;
  state.boardFromEngine = boardFromEngine;
  $('mondayReviewLink').hidden = board.engine_prospects !== true;
  syncProspects(board.engine_prospects === true);
  if (boardSourceChanged || saveSwitchChanged) renderReceipts();
  const actorChanged = previousActor && previousActor !== state.selfActor;
  bindDraftActor(state.selfActor);
  if (actorChanged || saveSwitchChanged) automaticPhase.clear();
  if (actorChanged) {
    pageDocContext?.clear();
    const contextRead = pageDocContext?.begin('getBoard');
    pageDocContext?.finish(contextRead, board);
    ++panelReadSequence;
    state.panelDetail = null;
    dealPlan?.dispose(); dealPlan = null;
    disposeChecklist();
    disposeActivityAttribution();
    disposePanelCallReview();
    disposePanelEmailFollowups();
    $('panelTitle').textContent = 'Deal';
    $('workspaceFacts').replaceChildren();
    $('panelBody').innerHTML = dealPlaceholderHtml;
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
    for (const section of ['path', 'board-controls', 'prospect']) {
      const selector = `[data-detail-read="${section}"]`;
      $('panelBody').querySelector(selector)?.replaceWith(template.querySelector(selector));
      if (section === 'path') revealCurrentPhase();
    }
  }
  if (state.panelDeal && !$('recordPanel')?.hidden && ((state.panelDetail && saveSwitchChanged)
    || (previousPanelRow && JSON.stringify(previousPanelRow) !== JSON.stringify(state.deals.get(state.panelDeal))))) {
    void refreshPanel({changed:true});
  }
  if (addDealRequested) {
    addDealRequested = false;
    void openAddDeal();
  }
}

function showProspects() {
  const lane = $('prospectsLane');
  if (lane) lane.hidden = state.scopeFilter === 'no-next-step';
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
  renderBoardPlaceholder();
  const outcome = await state.boardSync.refreshBoard({ reason: 'load-board' });
  if (!outcome.applied && state.boardSync.status().snapshots === 0) {
    renderBoardPlaceholder();
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
    const back = state.nextDealSaves ? moveBack(intent, result.response?.change_id) : null;
    // The toast is the move's only announcement; #dragLive keeps the drag steps.
    showToast(`${intent.name} moved to ${intent.to_label}`, back ? { onUndo: () => void runMoveBack(back) } : { eventId: result.event_id });
  }

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

// Engine saves have no revert route; a move is undone by moving the deal back from the version it made.
function moveBack(intent, changeId) {
  if (!Number.isSafeInteger(changeId) || !intent.from) return null;
  return moveIntent({ id: intent.deal, name: intent.name, phase: intent.value, seen: changeId }, intent.from);
}

async function runMoveBack(back) {
  const result = await sendPhaseWrite(back.deal, back.value, { seen_change_id: back.seen, phase_from: back.from });
  if (result.status === 'ok' && !result.superseded) {
    confirmLocalWrite(back.deal, { phase: back.value });
    renderBoard();
    showToast(`${back.name} moved back to ${back.to_label}`);
    return;
  }
  state.boardSync.requestRefresh('after-undo');
  renderBoard();
  showToast(fieldWriteMessage(result, `${fieldLabel('phase')} on ${back.name}`) || 'Undo was not saved. Reload Deals and try again.', { error: true });
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

  const isClosed = intent.to === CLOSED_SLUG;
  const closingInEngine = isClosed && Number.isSafeInteger(intent.seen);
  const wonOrLost = closingInEngine || intent.wonOrLost;
  $('completionTitle').textContent = wonOrLost ? `Close ${intent.name}` : moveTitle(intent);
  $('completionContext').textContent = wonOrLost ? 'Phase change' : intent.name;
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
  $('completionReason').value = '';
  const errors = $('completionErrors');
  if (errors) { errors.hidden = true; errors.textContent = ''; }
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  if (!wonOrLost) $('completionReason')?.focus();
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
      ? $('panelBody')?.querySelector(`.deal-path [data-path-phase="${CSS.escape(intent.to)}"]`)
        || $('panelBody')?.querySelector('.deal-path-name')
      : document.querySelector(`.kanban-card[data-id="${CSS.escape(intent.deal)}"]`)
        || document.querySelector(`[data-collapse-stage="${CSS.escape(phase)}"]`);
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
  if (root?.querySelector('[data-attribution-id]')) activityAttribution = mountActivityAttribution(root, { engineSignIn: privateSession()?.engineSignIn, onDenied: refusePanelDetail });
}
let panelCallReview = null;
function disposePanelCallReview() {
  panelCallReview?.dispose();
  panelCallReview = null;
}
async function openPanelCallReview(disclosure) {
  if (!disclosure.open || panelCallReview) return;
  const container = disclosure.querySelector('div'), id = state.panelDeal;
  try {
    const { mountEngineCallReview } = await import('./ui-call.generated.js');
    if (!container.isConnected || !disclosure.open || panelCallReview || state.panelDeal !== id) return;
    panelCallReview = mountEngineCallReview(container, {
      dealIds: [id], client: state.client, dateLabel: formatCalendarDate,
      phaseLabel: phase => columnBySlug(phase)?.label || phase,
      onChange: () => void refreshPanel({ changed: true }),
    });
    void panelCallReview.refresh();
  } catch {
    if (container.isConnected) container.textContent = 'Could not open call review. Close and reopen it to try again.';
  }
}
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
let panelRead = null;
let updateDraft = null;
const updateDrafts = new Map();
const requirementDrafts = new Map();
const requirementFields = [['use','Use'],['size','Size'],['location','Location'],['timing','Timing'],['budget','Budget'],['requirements','Approved requirements']];
let draftActor = null;
function bindDraftActor(actor) {
  if (draftActor === actor) return;
  clearPrivateTextDrafts(window, draftActor);
  draftActor = actor;
  updateDrafts.clear();
  requirementDrafts.clear();
  updateDraft = null;
  for (const key of Object.keys(commandState)) {
    if (key.startsWith('deal-update:')) dock.forget(key);
  }
}
function updateKey(id) { return `deal-update:${state.selfActor}:${id}`; }
function updateTextDraft(id) { return privateTextDraft(window, draftActor, 'deal-update', id); }
function discardUpdate(id) {
  updateTextDraft(id).write('');
  updateDrafts.delete(id);
  if (updateDraft?.id === id) updateDraft = null;
}
function refusePanelDetail(error) {
  if (![401,403].includes(error?.status) && !['unauthorized','not_authenticated','forbidden'].includes(error?.payload?.error)) return false;
  ++panelReadSequence;
  automaticPhase.setOpenDeal(state.panelDeal);
  state.panelDetail = null;
  disposeChecklist();
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose(); dealToursPanel = null;
  bindDraftActor(null);
  disposeActivityAttribution();
  disposePanelCallReview();
  disposePanelEmailFollowups();
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
    updateDraft = updateDrafts.get(state.panelDeal) || {id:state.panelDeal,text:updateTextDraft(state.panelDeal).read(), step:noteText(reviewed.next_step), date:editableStepDate(reviewed), reviewed, noteSaved:false};
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
  if (!pending) $('detailUpdateStatus').textContent = updateDraft.noteSaved ? updateDraft.message || 'Update added; next step still needs to be saved.' : updateDraft.text ? 'Unsent draft' : updateDraft.message || '';
  if (pending) $('detailUpdateStatus').textContent = pending.message || 'Saving update…';
}
function validateDetail(detail, id) {
  if (!detail?.deal || detail.deal.id !== id || typeof detail.deal.name !== 'string') throw new Error('Invalid detail');
  for (const field of ['activities','thread','next_actions','critical_dates','participants','premises','negotiation_rounds','documents','history','email_follow_ups','workflow_suggestions','correspondence']) {
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
      updateTextDraft(id).write('');
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
let activityNoteSending = false;
// Overview's and Activity's note boxes share one draft and one save.
async function saveActivityNote(id, formId) {
  const field = $(formId)?.elements.text;
  const text = field?.value.trim();
  const status = $(formId)?.querySelector('[role="status"]');
  if (!text || !state.selfActor || activityNoteSending) {
    if (status && !text) status.textContent = 'Enter a note';
    return;
  }
  activityNoteSending = true;
  activityNoteDraft = '';
  field.value = '';
  try {
    const result = await runFollowUp(`activity-note:${id}`, { verb: 'add-deal-note', args: { deal: id, text }, summary: 'Deal note' });
    if (result?.status !== 'ok') {
      activityNoteDraft = text;
      const again = $(formId)?.elements.text;
      if (again) again.value = text;
      if (status) status.textContent = result?.message || 'Note not confirmed';
      return;
    }
    state.boardSync.requestRefresh('deal-update');
    if (state.panelDeal === id) await refreshPanel();
  } finally { activityNoteSending = false; }
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
  {id:'plan', label:'Plan'},
  {id:'activity', label:'Activity'},
  {id:'tours', label:'Tours'},
  {id:'documents', label:'Documents'},
  {id:'client-portal', label:'Client portal'},
];
// Old links name tabs that were renamed or merged.
const renamedTabs = {timeline:'activity', correspondence:'activity', 'client-view':'client-portal'};
let workspaceTab = 'overview';
let requestedClientPortal = false;
let boardScroll = 0;
let timelineType = '';
let activityFilter = 'all';
let activityNoteDraft = '';
history.scrollRestoration = 'manual';
let workspaceHistory = history.state;
function writeWorkspaceHistory(data, url, push = false) {
  const index = (workspaceHistory?.doctorcreWorkspaceIndex ?? 0) + Number(push);
  workspaceHistory = {...data, doctorcreWorkspaceIndex:index};
  history[push ? 'pushState' : 'replaceState'](workspaceHistory, '', url);
}
writeWorkspaceHistory(history.state, location.href);
function workspaceFacts(detail) {
  const d = detail.deal;
  const fromEngine = isEngineDealDetail(detail);
  const client = d.client_name || d.client_ref;
  const parked = fromEngine && !isClosedDeal(d) && d.operating_state === 'parked';
  const phase = fromEngine && d.outcome === 'lost' ? 'Lost' : columnByValue(d.phase)?.label || d.phase || 'Not recorded';
  const national = d.workspace_kind === 'national_account' || d.account_client_id;
  const market = fromEngine && national ? nationalMarketLabel(d.market) : d.market;
  return [
    client && (fromEngine || client !== dealTitle(d))
      ? { label: 'Client', value: client, href: fromEngine && d.client_id ? `/clients?record=${encodeURIComponent(d.client_id)}` : '' } : null,
    { label: 'Phase', value: `${phase}${parked ? ' · Parked' : ''}` },
    { label: 'Owner', value: actorName(d.owner) || 'Unassigned' },
    ...(fromEngine ? dealTypeFacts(d, dealTypeLabel) : []),
    fromEngine && market ? { label: 'Market', value: market } : null,
  ].filter(Boolean);
}
function renderWorkspaceFacts(detail) {
  $('workspaceFacts').innerHTML = `<dl class="workspace-facts">${workspaceFacts(detail).map(({ label, value, href, note }) => {
    const text = note ? `${value} · ${note}` : value;
    return `<div><dt>${esc(label)}</dt><dd title="${esc(text)}">${href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text)}</dd></div>`;
  }).join('')}</dl>`;
}
// Scrolls only the strip sideways; scrollIntoView would also move a phone page whose header scrolled away.
function revealTab(tab) {
  const strip = tab.parentElement.getBoundingClientRect();
  const { left, right } = tab.getBoundingClientRect();
  tab.parentElement.scrollLeft += Math.min(0, left - strip.left) + Math.max(0, right - strip.right);
}
// The updated time follows the dates on Overview and heads every other tab.
function placeFreshness(id) {
  const line = $('panelBody').querySelector('.deal-freshness');
  if (!line) return;
  if (id === 'plan') line.hidden = true;
  else line.hidden = false;
  if (id === 'overview') $('workspace-overview').querySelector('[data-detail-read="add-critical-date"]').after(line, $('detailReadStatus'));
  else $('panelBody').prepend(line, $('detailReadStatus'));
}
function selectWorkspaceTab(id) {
  workspaceTab = id;
  requestedClientPortal = false;
  for (const tab of workspaceTabs) {
    const selected = tab.id === id;
    $(`tab-${tab.id}`).setAttribute('aria-selected', String(selected));
    $(`tab-${tab.id}`).tabIndex = selected ? 0 : -1;
    if ($(`workspace-${tab.id}`)) $(`workspace-${tab.id}`).hidden = !selected;
  }
  placeFreshness(id);
  revealTab($(`tab-${id}`));
  if (id === 'plan') renderPlan(state.panelDetail);
  if (id === 'documents') void dealDocumentsPanel?.load();
  if (id === 'tours') void dealToursPanel?.load();
  if (id === 'activity') {
    const legacyEvidence = $('panelEvidenceSection');
    if (legacyEvidence) legacyEvidence.open = true;
  }
}
function workspaceNotesHtml(detail) {
  return `<section aria-label="Deal notes"><h3>Deal notes</h3>${(detail.thread || []).map(note => `<article class="workspace-note"><b>${esc(authorLabel(note.actor))}</b> <time datetime="${esc(note.at || note.created_at || note.recorded_at || '')}">${esc(sourceTime(note.at || note.created_at || note.recorded_at, undefined, 'Date not recorded'))}</time><p class="note-original">${linkRecordNames(noteText(note.text), detail.record_links)}</p></article>`).join('') || '<p>No notes recorded.</p>'}</section>`;
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
function workspaceEventsHtml(detail, nextItem) {
  const events = legacyTimelineEntries(detail, nextItem).filter(event => event.text.trim());
  if (!events.some(event => event.type === timelineType)) timelineType = '';
  return `<h2>Dated events</h2><label for="timelineType">Filter by kind</label><select id="timelineType"><option value="">All types</option>${[...new Set(events.map(e => e.type))].map(type => `<option${type === timelineType ? ' selected' : ''}>${esc(type)}</option>`).join('')}</select><ol class="workspace-events">${events.map(e => `<li data-event-type="${esc(e.type)}"${timelineType && e.type !== timelineType ? ' hidden' : ''}>${e.actor ? `<b>${esc(e.actor)}</b> ` : ''}<time datetime="${esc(e.when)}">${esc(e.caption)}</time><small>${esc(e.type)}</small><p class="note-original">${linkRecordNames(e.text, detail.record_links)}</p></li>`).join('')}</ol>${events.length ? '' : '<p>No dated events recorded.</p>'}`;
}
let dealToursPanel, dealDocumentsPanel;
let checklistPanel;
function disposeChecklist() { checklistPanel?.dispose(); checklistPanel = null; }
const focusedChecklistItem = dealId => {
  const params = new URL(location.href).searchParams;
  return params.get('deal') === dealId ? params.get('checklist') : null;
};
function mountChecklist(detail) {
  disposeChecklist();
  const host = $('panelBody').querySelector('[data-detail-read="checklist"]');
  if (!host) return;
  let retired = false, mounted, latest = detail;
  const props = value => ({dealId: value.deal.id, checklist: value.checklist, showProgress: isEngineDealDetail(value),
    focusedItem: focusedChecklistItem(value.deal.id)});
  checklistPanel = {
    update(value) { latest = value; mounted?.update(props(value)); },
    dispose() { retired = true; mounted?.dispose(); },
  };
  void import('./ui-checklist.generated.js').then(({mountDealChecklist}) => {
    if (retired) return;
    mounted = mountDealChecklist(host, props(latest));
  }).catch(() => { if (!retired) host.textContent = 'Checklist unavailable. Reopen the deal to try again.'; });
}

// A phone's path opens on the current phase; scrollIntoView would also move the page.
function revealCurrentPhase() {
  const path = $('panelBody').querySelector('.deal-path');
  const now = path?.querySelector('[data-place="current"]');
  if (now) path.scrollLeft += now.getBoundingClientRect().left - path.getBoundingClientRect().left - (path.clientWidth - now.offsetWidth) / 2;
}
function closePathQuestion({ focus = true } = {}) {
  const ask = $('panelBody').querySelector('.deal-path-ask');
  const phase = ask?.closest('.deal-path-tile')?.querySelector('[data-path-phase]');
  ask?.remove();
  phase?.setAttribute('aria-expanded', 'false');
  if (focus) phase?.focus();
}
function askPathMove(button) {
  const wasOpen = button.getAttribute('aria-expanded') === 'true';
  closePathQuestion({ focus: wasOpen });
  if (wasOpen) return;
  const phase = columnBySlug(button.dataset.pathPhase);
  if (!phase) return;
  button.setAttribute('aria-expanded', 'true');
  button.closest('.deal-path-tile').insertAdjacentHTML('beforeend', pathQuestionHtml(phase, businessDay()));
  button.closest('.deal-path-tile').querySelector('.deal-path-ask input')?.focus();
}
async function movePathPhase(ask) {
  const detail = state.panelDetail;
  const intent = detail && moveIntent(detail.deal, ask.dataset.pathMove);
  const submit = ask.querySelector('button[type="submit"]');
  if (!intent || submit.disabled) return;
  const field = name => ask.elements[name]?.value;
  submit.disabled = true;
  try {
    const outcome = await runMove(intent, { changeReason: field('reason'), outcome: ask.elements.outcome?.value,
      closedOn: field('closedOn'), wonValue: field('wonValue'), lostReason: field('lostReason') });
    if (!ask.isConnected) {
      if (outcome.ok && state.panelDeal === intent.deal) await refreshPanel({ changed: true });
      return;
    }
    if (outcome.errors.length) { ask.querySelector('[data-path-status]').textContent = outcome.errors.join(' '); return; }
    closePathQuestion({ focus: false });
    if (outcome.ok) await refreshPanel({ changed: true });
  } finally { submit.disabled = false; }
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
      <p>${esc(version)}${file.prepared_at ? ` · ${esc(sourceTime(file.prepared_at))}` : ''}</p>
      <button class="btn" type="button" data-open-document-text="${esc(file.id)}" data-detail-focus="text-${esc(file.id)}" aria-label="${esc(`Open text for ${file.name}, ${version}`)}">Open text</button></li>`;
  }).join('')}</ul>` : '<p>No documents filed for this deal.</p>';
}

function closeFiledDocumentText() {
  $('workspace-documents')?.querySelector('.deal-document-text[open]')?.close();
}

function openFiledDocumentText(documentId, { fromHistory = false } = {}) {
  const detail = state.panelDetail;
  if (!isEngineDealDetail(detail)) return;
  const file = detail.documents.find(file => file.id === documentId);
  const documents = $('workspace-documents');
  if (!file || !documents || documents.querySelector('.deal-document-text[open]')) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'dialog deal-dialog deal-document-text';
  dialog.setAttribute('aria-labelledby', 'filed-document-text-title');
  dialog.innerHTML = `<article>
    <header><h2 id="filed-document-text-title">${esc(file.name)}</h2>
      <button class="btn icon-btn" type="button" aria-label="Close document text">×</button></header>
    <div class="dialog-body"><p role="status"></p><button class="btn" type="button" hidden>Retry</button></div>
  </article>`;
  const status = dialog.querySelector('[role="status"]');
  const retry = dialog.querySelector('.dialog-body button');
  const lifetime = new AbortController();
  const path = `/api/engine/deals/${encodeURIComponent(detail.deal.id)}/documents/${encodeURIComponent(file.id)}/text`;

  async function load() {
    status.textContent = 'Loading document text…';
    retry.hidden = true;
    try {
      const pages = await readWithDeadline(async signal => {
        const response = await sessionFetch(path, { signal });
        if (!response.ok) throw Error('Document text is unavailable.');
        const result = await response.json();
        if (!Array.isArray(result?.pages) || !result.pages.every(page => typeof page === 'string'))
          throw Error('Invalid document text');
        return result.pages;
      }, { signal: lifetime.signal });
      if (!dialog.open || !dialog.isConnected) return;
      status.textContent = pages.length ? '' : 'No text found in this file.';
      for (const [index, text] of pages.entries()) {
        const page = document.createElement('section');
        const heading = document.createElement('h3');
        heading.textContent = `Page ${index + 1}`;
        page.setAttribute('aria-label', heading.textContent);
        const content = document.createElement('pre');
        content.textContent = text;
        page.append(heading, content);
        retry.before(page);
      }
    } catch {
      if (!dialog.open || !dialog.isConnected) return;
      status.textContent = 'Document text is unavailable.';
      retry.hidden = false;
    }
  }

  const close = dialog.querySelector('header button');
  function dismiss(event) {
    event.preventDefault();
    if (close.disabled) return;
    close.disabled = true;
    history.back();
  }
  close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', dismiss);
  dialog.addEventListener('close', () => { lifetime.abort(); dialog.remove(); }, { once: true });
  retry.addEventListener('click', () => void load());
  if (fromHistory) selectWorkspaceTab('documents');
  documents.append(dialog);
  dialog.showModal();
  if (!fromHistory) writeWorkspaceHistory({...history.state, doctorcreDocumentText:documentId}, location.href, true);
  void load();
}

const emailDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BUSINESS_TIME_ZONE });

function suggestionSource({ sender_name, sender, happened_at }) {
  const name = (sender_name || sender || '').split('<', 1)[0].trim().replace(/^["']|["']$/g, '').split(/\s+/, 1)[0];
  const from = name && !name.includes('@') ? `From ${name}'s email` : 'From an email';
  const date = Date.parse(happened_at);
  return Number.isFinite(date) ? `${from}, ${emailDay.format(date)}` : from;
}

// Cleaned email HTML by suggestion: null while its one read runs, '' when unreadable.
const suggestionEmails = new Map();
const mcpRequest = createMcpRequests();
async function readSuggestionEmail(id) {
  const result = await mcpRequest('read-engine-home-proposal', { id }, { timeoutMs: 10000 });
  return result.kind === 'payload' && !result.isError ? result.payload : null;
}
function cleanedEmailHtml(email) {
  return email ? `<p class="deal-suggestion-from">From ${esc(email.sender)} · <time datetime="${esc(email.occurredAt)}">${esc(email.sent)}</time></p>${
    email.paragraphs.map(paragraph => `<p>${esc(paragraph)}</p>`).join('')}` : '';
}
function loadSuggestionEmails(detail) {
  if (!isEngineDealDetail(detail)) return;
  const slot = id => $('panelBody').querySelector(`[data-suggestion-email="${CSS.escape(id)}"]`);
  for (const { proposal_id: id, email } of detail.email_follow_ups) {
    if (suggestionEmails.has(id) || !slot(id)) continue;
    suggestionEmails.set(id, null);
    void readSuggestionEmail(id).catch(() => null).then(read => {
      suggestionEmails.set(id, cleanedEmailHtml(suggestionEmail(read, email?.activity_id)));
      const shown = slot(id);
      if (shown) shown.outerHTML = suggestionEmailSlot(shown.dataset.fallback, id);
    });
  }
}
function setSuggestionEdit(form, editing, focus = true) {
  const fields = form?.querySelector('[data-suggestion-edit]');
  if (!fields) return;
  fields.hidden = !editing;
  form.querySelector('[data-edit-suggestion]').hidden = editing;
  form.querySelector('[data-cancel-edit]').hidden = !editing;
  if (!editing) for (const input of fields.querySelectorAll('input')) input.value = input.defaultValue;
  if (focus) (editing ? form.elements.what : form.querySelector('[data-edit-suggestion]')).focus();
}
function suggestionEmailSlot(fallback, id) {
  const cleaned = suggestionEmails.get(id);
  const body = cleaned || (cleaned === '' && fallback ? `<p>${esc(fallback)}</p>` : '');
  return `<div class="deal-suggestion-email" data-suggestion-email="${esc(id)}" data-fallback="${esc(fallback)}"${body ? '' : ' hidden'}>${body}</div>`;
}

function suggestionHtml(row, today, canDecide, showEmail) {
  const workflow = row.kind === 'workflow_step';
  const email = row.email || {};
  const subject = emailSubject(redactEmailAddresses(email.subject || ''));
  const change = workflow ? row.what
    : row.kind === 'file_to_deal' ? 'File email to this deal'
    : row.kind === 'phase_move' ? `Move to ${columnBySlug(row.to_phase)?.label || 'the next phase'}`
    : row.what && emailPlaceholderText(redactEmailAddresses(row.what)) || 'Review email';
  const title = workflow ? change : row.title || (subject === '(No subject)' ? 'Email follow-up' : subject);
  const step = workflow || row.kind === 'next_step';
  const line = [esc(workflow ? row.evidence : suggestionSource(email)), title !== change && esc(change), step && row.owner && `For ${esc(actorName(row.owner))}`,
    row.due_on && dueDateHtml(row.due_on, today)].filter(Boolean).join(' · ');
  const id = esc(row.proposal_id);
  const actions = canDecide ? `<form class="deal-suggestion-actions" data-suggestion-decision="${id}">
      <div class="deal-suggestion-buttons">
        <button class="btn" type="submit" value="accept" data-detail-focus="accept-${id}">Accept</button>
        ${step ? `<button class="btn btn-quiet" type="button" data-edit-suggestion data-detail-focus="edit-${id}">Edit</button>
        <button class="btn btn-quiet" type="button" data-cancel-edit data-detail-focus="cancel-${id}" hidden>Cancel</button>` : ''}
        <button class="btn btn-quiet" type="submit" value="dismiss" formnovalidate data-detail-focus="dismiss-${id}">Dismiss</button>
      </div>
      ${step ? `<div class="deal-next-step-fields" data-suggestion-edit hidden>
        <label>Next step<input name="what" value="${esc(row.what)}" maxlength="10000" data-detail-focus="step-${id}"></label>
        <label>Due date<input type="date" name="due_on" value="${esc(row.due_on)}" data-detail-focus="date-${id}"></label>
      </div>` : ''}
    </form>` : '';
  const emailBody = showEmail ? suggestionEmailSlot(redactEmailAddresses(row.evidence || email.summary || ''), row.proposal_id) : '';
  return `<li class="deal-suggestion" aria-labelledby="suggestion-${id}"><div class="deal-suggestion-row">
      <div><h3 id="suggestion-${id}">${esc(title)}</h3><p>${line}</p></div>${actions}
    </div>${emailBody}</li>`;
}

const stepWording = text => typeof text === 'string' ? text.trim().replace(/\s+/g, ' ').toLowerCase() : '';

function dealSuggestionsHtml({ correspondence, email_follow_ups, workflow_suggestions = [], next_deal_saves }, openSteps, today) {
  const filed = new Set(correspondence?.filter(entry => entry.kind === 'email' && entry.activity_id).map(entry => entry.activity_id));
  const openWording = new Set(openSteps.map(step => stepWording(step.description)));
  const emailSuggestions = email_follow_ups.filter(row =>
    !(row.kind === 'file_to_deal' && filed.has(row.email?.activity_id))
    && !(row.kind === 'next_step' && openWording.has(stepWording(row.what))));
  const emailWording = new Set(emailSuggestions.filter(row => row.kind === 'next_step').map(row => stepWording(row.what)).filter(Boolean));
  // Keep the email's evidence and decision when the checklist proposes the same step.
  const checklistSuggestions = workflow_suggestions.filter(row => {
    const wording = stepWording(row.what);
    return !openWording.has(wording) && !emailWording.has(wording);
  }).map(row => ({ ...row, kind: 'workflow_step' }));
  const seenEmails = new Set();
  const suggestions = [...emailSuggestions, ...checklistSuggestions].map(row => {
    const email = row.email?.activity_id ?? row.proposal_id;
    const showEmail = row.kind !== 'workflow_step' && !seenEmails.has(email);
    if (showEmail) seenEmails.add(email);
    return suggestionHtml(row, today, next_deal_saves, showEmail);
  });
  return suggestions.length ? `<h3 class="deal-steps-group">Suggested</h3>
    <ul class="deal-suggestions" aria-label="Suggested steps" role="list">${suggestions.join('')}</ul>` : '';
}

function renderSnapshotFacts(deal, fromEngine) {
  const facts = [];
  if (deal.workspace_kind === 'national_account' || deal.account_client_id) {
    facts.push({ label: 'Market agent', value: deal.market_agent || 'Unassigned' });
  }
  if (!fromEngine && deal.type) facts.push({ label: 'Type', value: deal.type });
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

function openStepOwnerHtml(step, textId, canSave, today) {
  const id = esc(step.id);
  const canFinish = canSave && dealStepVersion(step);
  const saving = pendingCommand(commandState, completeStepKey(step.id))?.status === 'pending';
  return `<div class="deal-step-owner" role="group" aria-labelledby="${textId} step-owner-${id}"${stepFocusAttrs(step)}>
    ${canFinish ? `<button class="deal-step-done" type="button" data-complete-step="${id}" data-detail-focus="done-${id}" aria-label="Done" title="Mark done" aria-describedby="${textId} step-owner-${id}"${saving ? ' aria-disabled="true"' : ''}></button>` : ''}
    <div><p id="step-owner-${id}">${esc(actorName(step.owner))} · ${dueDateHtml(calendarDay(step.due_on), today)}</p>
      ${stepOrigin(step)}</div>
  </div>`;
}

function openDealStepsHtml(detail, steps, today) {
  const label = isClosedDeal(detail.deal) && steps.length ? 'Open before this deal ended' : 'Open';
  const canSave = detail.next_deal_saves && Number.isSafeInteger(detail.deal.seen);
  const groups = Map.groupBy(steps, step => step.description.trim());
  const rows = Array.from(groups, ([wording, owners]) => {
    const { id, display_title: title = wording, display_instruction: instruction } = owners[0];
    const textId = `step-text-${esc(id)}`;
    return `<li><strong id="${textId}">${esc(title)}</strong>
      ${instruction ? `<p>${esc(instruction)}</p>` : ''}
      ${owners.map(step => openStepOwnerHtml(step, textId, canSave, today)).join('')}
    </li>`;
  }).join('');
  return `<h3 class="deal-steps-group">${label}</h3>
    ${rows ? `<ul aria-label="Open steps" role="list">${rows}</ul>` : '<p>No next step set.</p>'}`;
}

function dealNextStepsHtml(detail, today, { addStep, callReview }) {
  const openSteps = dealOwnerFirstSteps(detail.deal, detail.next_actions);
  return `<section class="deal-next-steps" aria-labelledby="deal-next-steps-heading">
    <h2 id="deal-next-steps-heading">Next steps</h2>${attentionLineHtml(detail.deal)}${addStep}
    <div class="deal-open-steps" data-detail-read="open-steps">${openDealStepsHtml(detail, openSteps, today)}</div>
    <div data-detail-read="suggested">${dealSuggestionsHtml(detail, openSteps, today)}</div>
    ${callReview}
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

const callReviewHtml = '<details id="panelCallReview"><summary>Review calls</summary><div></div></details>';
function workspaceHtml(detail, engineMode = privateSession()?.engineSignIn) {
  const fromEngine = isEngineDealDetail(detail);
  const planTours = dealToursFromEngine();
  const ownStep = canEditOwnDealStep(detail);
  const d = detail.deal;
  const items = detail.items || d.items || [];
  const { text: nextStep, dueOn, item: nextItem, otherActions } = fromEngine
    ? {} : dealNextStep(d, detail.next_actions || [], items);
  const today = fromEngine ? businessDay() : todayIso();
  const ended = isClosedDeal(d);
  const stepToday = ended ? undefined : today;
  const stepLabel = stepToday && dueOn && dueOn < stepToday ? 'Overdue action' : 'Next action';
  const stepSummary = fromEngine ? '' : `
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
  const phaseMove = detailPhaseMoveHtml(detail);
  const websiteSetup = !d.client_portal_url && (fromEngine ? detail.next_deal_saves && d.client_id : controlsAvailable)
    ? clientPortalSetupHtml() : '';
  const stepsHtml = (tail = '') => `<section class="deal-opening-snapshot" aria-label="Deal snapshot">
      <div data-detail-read="step-overview">
      ${renderInvoiceClose(d, state.nextDealSaves)}
      ${!fromEngine && phaseMove ? `<div data-phase-move aria-live="polite">${phaseMove}</div>` : ''}
      ${!fromEngine && ended && (nextStep || otherActions.length) ? `<section aria-labelledby="ended-deal-steps"><h3 id="ended-deal-steps">Open before this deal ended</h3>${stepSummary}</section>` : stepSummary}
      ${completedStep ? `<section aria-label="Completed step"${stepFocusAttrs(completedStep)}>
      <h2>Completed step</h2><p>${esc(completedStep.description)}</p>${stepOrigin(completedStep)}
    </section>` : ''}
      </div>
      ${fromEngine ? dealNextStepsHtml(detail, stepToday, {
        addStep: ownStep ? `<details id="detailNextStepEditor" class="deal-step-editor"><summary>Add step</summary>${dealUpdateFormHtml(true, today)}</details>` : '',
        callReview: engineMode ? callReviewHtml : '' })
      : ownStep ? `<details id="detailNextStepEditor" class="deal-step-editor"><summary>Add next step</summary>${dealUpdateFormHtml(true, today)}</details>` : ''}
    ${tail}</section>`;
  const snapshotHtml = `<div data-detail-read="snapshot">
    <div class="deal-alert">${renderDealItems({...d,items:items.filter(item => item !== nextItem)},{today:stepToday,buttons:true,empty:false,itemOwners})}</div>
      ${renderSnapshotFacts(d, fromEngine)}
      ${!fromEngine && d.client_portal_url ? renderClientPortalLink(d.client_portal_url) || '<p>Client website link is invalid.</p>' : ''}
      </div>`;
  const ownerHtml = `<div data-detail-read="board-controls" data-available="${controlsAvailable}">${controlsAvailable ? `<div class="detail-actions"><div class="detail-controls"><label>Owner<select id="detailOwner">${fromEngine ? '' : '<option value="">Unassigned</option>'}${['joe','dell'].map(owner => `<option value="${owner}"${owner === d.owner ? ' selected' : ''}>${actorName(owner)}</option>`).join('')}</select></label></div>${fromEngine ? '' : `<div data-detail-read="parking" data-parked="${parked}" data-next-parking="${nextParking}">${parked ? `${parkingSummary}<button type="button" class="btn" data-revive="${esc(d.id)}">Revive</button>` : parkFormHtml(nextParking)}</div>`}</div>` : ''}</div>`;
  const prospectHtml = `<div data-detail-read="prospect">${!engineSaves && controlsAvailable && prospect?.client_status === 'prospect' ? `<form id="detailInactiveForm"><p>Inactive prospects return to Leads.</p><label>Reason<input name="reason" maxlength="1000" required value="${esc(pendingProspect?.request.reason || '')}"${pendingProspect ? ' readonly' : ''}></label><button class="btn" type="submit">${pendingProspect ? 'Check outcome' : 'Mark inactive'}</button><p role="status" data-prospect-status>${pendingProspect ? 'Confirmation pending for this prospect. Check outcome to retry the same request.' : ''}</p></form>` : ''}</div>`;
  return `<section id="workspace-overview" role="tabpanel" aria-labelledby="tab-overview">${renderCriticalDates(detail, Date.now(), state.nextDealSaves && Number.isSafeInteger(d.seen), canAddCriticalDate)}
    <div data-detail-read="add-critical-date" data-available="${canAddCriticalDate}">${canAddCriticalDate ? criticalDateFormHtml() : ''}</div>
    <div class="deal-freshness"><time id="detailUpdated" title="Last updated"></time><button class="btn icon-btn" type="button" data-refresh-detail aria-label="Refresh deal" title="Refresh">↻</button></div><p id="detailReadStatus" role="status"></p>
    ${fromEngine ? `<p id="detailStepStatus" role="status"></p><div class="deal-parked-line" data-detail-read="parked">${parked ? `${parkingSummary}${controlsAvailable ? `<button type="button" class="btn" data-revive="${esc(d.id)}">Revive</button>` : ''}` : ''}</div>` : ''}
    <div data-detail-read="path">${dealPathHtml({ phases: COLUMNS, current: columnByValue(d.phase)?.slug ?? null, checklist: detail.checklist, showTodos: fromEngine, today, canMove: controlsAvailable && !parked, receiptHtml: fromEngine ? phaseMove : '', focusedItem: focusedChecklistItem(d.id), signingOn: detail.plan?.expected_signing_on })}</div>${fromEngine ? `<div class="deal-overview-grid">${stepsHtml(`${snapshotHtml}${ownStep ? '' : dealUpdateFormHtml(false, today)}`)}
      <div data-detail-read="latest">${renderLatestActivity(detail, { planTours, note: activityNoteDraft, canNote: Boolean(state.selfActor), ports: activityPorts })}</div>
      <div class="deal-overview-side">
        <div data-detail-read="invoice">${dealInvoiceHtml(detail.invoice, dateCaption)}</div>
        <div data-detail-read="vendors">${dealPeopleHtml(d, detail.participants)}</div>
        <div data-detail-read="client-portal">${websiteSetup}</div>${ownerHtml}${prospectHtml}${requirementEmailHtml(d)}
        <div class="deal-park-line" data-detail-read="parking" data-parked="${parked}" data-next-parking="${nextParking}" data-available="${controlsAvailable}">${controlsAvailable && !parked ? parkFormHtml(nextParking) : ''}</div>
      </div></div>` : `${stepsHtml(snapshotHtml)}
    <div data-detail-read="checklist"></div>
    ${ownStep ? '' : dealUpdateFormHtml(false, today)}
    <section id="panelEmailFollowups" aria-label="Email follow-ups"><p role="status">Updating email follow-ups…</p></section>
    ${engineMode ? `${callReviewHtml}\n    ` : ''}${requirementEmailHtml(d)}
    <div data-detail-read="vendors">${renderDealVendors(d.vendors)}</div>${ownerHtml}${prospectHtml}
    <div data-detail-read="client-portal">${websiteSetup}</div>
    <div data-detail-read="updates">${renderDealUpdates(detail, Date.now(), { engineSignIn: engineMode, noteHtml: text => linkRecordNames(text, detail.record_links) })}</div>`}</section>
    <section id="workspace-documents" role="tabpanel" aria-labelledby="tab-documents" hidden>${fromEngine ? `<h2>Documents</h2>${detail.next_deal_saves ? '<div id="deal-document-upload"></div>' : ''}<div data-detail-read="filed-documents">${filedDocumentsHtml(detail.documents)}</div>` : ''}</section>
    <section id="workspace-client-portal" role="tabpanel" aria-labelledby="tab-client-portal" hidden>${fromEngine ? `<div data-detail-read="client-website">${clientPortalHtml({ deal: d.id, url: d.client_portal_url, clientName: d.client_name })}</div>` : ''}</section>
    <section id="workspace-tours" role="tabpanel" aria-labelledby="tab-tours" hidden>${engineMode ? '<p>Not available yet</p>' : ''}</section>
    <section id="workspace-plan" role="tabpanel" aria-labelledby="tab-plan" hidden></section>
    <section id="workspace-activity" role="tabpanel" aria-labelledby="tab-activity" hidden>${fromEngine ? activityPanel(detail, planTours) : `<div data-detail-read="events">${workspaceEventsHtml(detail, nextItem)}</div>${renderDealTimeline(detail)}
      <h2>Correspondence &amp; notes</h2>
      <details id="panelEvidenceSection"><summary>Threads &amp; meetings</summary><div id="panelEvidence"></div></details>
      <div data-detail-read="notes">${workspaceNotesHtml(detail)}</div>`}</section>`;
}
const activityPorts = {
  businessDay, compareInstants, escapeText, emailSubject, calendarDay, changeText, dateCaption,
  importedHistoryEntries, timelineActor, sourceTime, noteText,
};
function activityPanel(detail, planTours) {
  const view = renderDealActivity(detail, {
    planTours, now: new Date(), fold: foldEmailBody, filter: activityFilter, note: activityNoteDraft,
    canNote: Boolean(state.selfActor), link: text => linkRecordNames(text, detail.record_links),
    open: activityOpen, emailHtml: id => activityEmailHtml(detail, id), ports: activityPorts,
  });
  activityFilter = view.filter;
  activityOpen = view.open;
  return view.html;
}

// A filed email's cleaned conversation by deal and email: null while its read runs, 'failed' when it could not be read.
const activityThreads = new Map();
let activityOpen = null, activityFullEmails = false, activityAttributionPane = null;
const threadKey = (detail, id) => `${detail.deal.id}:${id}`;
function activityEmailHtml(detail, id) {
  const today = businessDay(new Date());
  // An opened email is already filed to this deal, so filing it again is never offered.
  const suggestions = detail.email_follow_ups.filter(row => row.email?.activity_id === id && row.kind !== 'file_to_deal')
    .map(row => suggestionHtml(row, today, detail.next_deal_saves, false)).join('')
    .replace(/(id|aria-labelledby)="suggestion-/g, '$1="activity-suggestion-');
  return `${suggestions ? `<ul class="deal-suggestions activity-suggestions">${suggestions}</ul>` : ''}<div data-activity-thread="${esc(id)}">${activityThreadHtml(activityThreads.get(threadKey(detail, id)))}</div>`;
}
function activityThreadHtml(thread) {
  if (thread === undefined || thread === null) return '<p role="status">Loading the conversation…</p>';
  if (thread === 'failed') return '<p role="status">The conversation couldn\'t be loaded.</p><button class="btn" type="button" data-activity-retry>Retry</button>';
  if (!thread.length) return '<p>This email\'s text isn\'t in your mailbox.</p>';
  const earlier = thread.some(message => message.earlier.length);
  return `${thread.map(message => `<article class="activity-message"><p class="deal-suggestion-from">From ${esc(message.sender)} · <time datetime="${esc(message.occurredAt)}">${esc(message.sent)}</time></p>${
    message.paragraphs.map(text => `<p>${esc(text)}</p>`).join('')}${
    message.earlier.length ? `<div class="activity-earlier"${activityFullEmails ? '' : ' hidden'}>${message.earlier.map(text => `<p>${esc(text)}</p>`).join('')}</div>` : ''}</article>`).join('')}${
    earlier ? `<button class="btn btn-quiet" type="button" data-activity-full aria-expanded="${activityFullEmails}">${activityFullEmails ? 'Hide the full emails' : 'Show the full emails'}</button>` : ''}`;
}
async function loadActivityThread(detail) {
  const id = $('panelBody').querySelector('[data-activity-thread]')?.dataset.activityThread;
  const key = id && threadKey(detail, id);
  if (!key || (activityThreads.has(key) && activityThreads.get(key) !== 'failed')) return;
  activityThreads.set(key, null);
  const path = `/api/engine/deals/${encodeURIComponent(detail.deal.id)}/emails/${encodeURIComponent(id)}`;
  const thread = await readWithDeadline(async signal => {
    const response = await sessionFetch(path, { signal });
    if (!response.ok) throw Error('Email unavailable');
    return emailConversation(await response.json());
  }).catch(() => 'failed');
  activityThreads.set(key, thread);
  const slot = $('panelBody').querySelector(`[data-activity-thread="${CSS.escape(id)}"]`);
  if (slot && state.panelDetail?.deal.id === detail.deal.id) slot.innerHTML = activityThreadHtml(thread);
}
function disposeActivityPane() { activityAttributionPane?.dispose(); activityAttributionPane = null; }
function mountActivityPane(detail) {
  disposeActivityPane();
  const pane = $('panelBody').querySelector('.activity-pane');
  if (!pane || !isEngineDealDetail(detail)) return;
  if (pane.querySelector('[data-attribution-id]')) activityAttributionPane = mountActivityAttribution(pane, { engineSignIn: privateSession()?.engineSignIn, onDenied: refusePanelDetail });
  void loadActivityThread(detail);
}
function showActivityItem(key) {
  const current = $('panelBody').querySelector('[data-detail-read="activity"]');
  const detail = state.panelDetail;
  if (!current || !detail) return;
  const scroll = current.querySelector('.activity-list')?.scrollTop ?? 0;
  if (key !== activityOpen) activityFullEmails = false;
  activityOpen = key;
  disposeActivityPane();
  const template = document.createElement('div');
  template.innerHTML = activityPanel(detail, dealToursFromEngine());
  const fresh = template.firstElementChild;
  current.replaceWith(fresh);
  fresh.querySelector('.activity-list').scrollTop = scroll;
  mountActivityPane(detail);
  if (key) $('activityPaneTitle')?.focus();
  else fresh.querySelector(`[data-activity-open="${CSS.escape(current.querySelector('.activity-open[aria-current]')?.dataset.activityOpen ?? '')}"]`)?.focus();
}
function dealUpdateFormHtml(stepEditor, today) {
  const stepFields = `<div class="deal-next-step-fields"><label for="dealUpdateStep">${stepEditor ? 'Your next step' : 'Next step'}</label><textarea id="dealUpdateStep" name="step" maxlength="10000" autocomplete="off"></textarea><label for="dealUpdateDate">Next date</label><input id="dealUpdateDate" name="date" type="date" min="${today}"><small id="detailUpdateDateHint" hidden>Current next date is overdue.</small></div>`;
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
  return `<div popover id="addDatePanel" class="date-panel" role="dialog" aria-labelledby="addDateTitle"><h3 id="addDateTitle">Add critical date</h3>
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
  </div>`;
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
    form.closest('[popover]').hidePopover();
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
function refreshPanel({ changed = false, fresh = false } = {}) {
  const id = state.panelDeal;
  if (!id) return Promise.resolve(false);
  if (!fresh && panelRead?.id === id && panelRead.sequence === panelReadSequence) {
    if (changed) panelRead.again = true;
    return panelRead.promise;
  }
  const reading = readPanel(id);
  const current = { id, sequence: panelReadSequence, again: false, promise: null };
  panelRead = current;
  current.promise = reading.then(applied => {
    if (panelRead === current) panelRead = null;
    if (current.again && state.panelDeal === id && current.sequence === panelReadSequence) return refreshPanel();
    return applied;
  });
  return current.promise;
}
async function readPanel(id) {
  const seq = ++panelReadSequence;
  try {
    const detail = await readDealDetail(id);
    if (state.panelDeal !== id || seq !== panelReadSequence || panelRead?.again) return false;
    const wasEngineDetail = isEngineDealDetail(state.panelDetail);
    const savesChanged = state.panelDetail?.next_deal_saves !== detail.next_deal_saves;
    state.panelDetail = detail;
    automaticPhase.detailReadApplied(id);
    const contextRead = pageDocContext?.begin('getDeal', [id]);
    pageDocContext?.finish(contextRead, detail);
    selectDocRecord('deal', id);
    updateDetailTimestamp();
    if (!$('panelBody').querySelector('.deal-opening-snapshot') || wasEngineDetail !== isEngineDealDetail(detail) || savesChanged) paintPanel(detail);
    else {
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
        if (fresh.dataset.detailRead === 'path' && current.querySelector('.deal-path-ask')) continue;
        if (isEngineDealDetail(detail) && fresh.dataset.detailRead === 'client-portal'
            && current.querySelector('form') && fresh.querySelector('form')) continue;
        if (['board-controls', 'add-critical-date'].includes(fresh.dataset.detailRead) && current.dataset.available === fresh.dataset.available) continue;
        if (fresh.dataset.detailRead === 'parking' && fresh.dataset.parked === 'false'
            && current.dataset.parked === 'false' && current.dataset.nextParking === fresh.dataset.nextParking
            && current.dataset.available === fresh.dataset.available) continue;
        if (current.innerHTML !== fresh.innerHTML) {
          const expanded = new Set([...current.querySelectorAll('.deal-note details[open]')].map(n => n.closest('.deal-note').dataset.id));
          const focused = current.contains(document.activeElement) ? document.activeElement : null;
          const focusIdentity = focused?.dataset.detailFocus;
          const historyOpen = current.querySelector('.updates-history')?.open;
          const openDate = [...current.querySelectorAll('.date-panel')].find(n => n.matches(':popover-open'))?.id;
          const openMeetings = new Set([...current.querySelectorAll('details[data-meeting-id][open]')].map(n => n.dataset.meetingId));
          const dateAsks = [...current.querySelectorAll('[data-date-decision] .date-reason:not([hidden])')].map(n => [
            n.closest('form').dataset.dateDecision, n.querySelector('[type="submit"]').value, n.querySelector('input').value]);
          const oldScroll = current.scrollLeft;
          const activityScroll = current.querySelector('.activity-list')?.scrollTop ?? null;
          const openTodos = new Set([...current.querySelectorAll('[data-todo] > details[open]')].map(n => n.parentElement.dataset.todo));
          if (fresh.dataset.detailRead === 'suggested') {
            for (const input of current.querySelectorAll('[data-suggestion-decision] input')) {
              const replacement = fresh.querySelector(`[data-detail-focus="${CSS.escape(input.dataset.detailFocus)}"]`);
              if (replacement && replacement.defaultValue === input.defaultValue) replacement.value = input.value;
            }
            for (const edit of current.querySelectorAll('[data-suggestion-decision] [data-suggestion-edit]:not([hidden])'))
              setSuggestionEdit(fresh.querySelector(`[data-suggestion-decision="${CSS.escape(edit.closest('form').dataset.suggestionDecision)}"]`), true, false);
          }
          if (fresh.dataset.detailRead === 'updates') disposeActivityAttribution();
          if (fresh.dataset.detailRead === 'activity') disposeActivityPane();
          current.replaceWith(fresh);
          if (fresh.dataset.detailRead === 'updates') mountPanelActivityAttribution();
          if (fresh.dataset.detailRead === 'activity') mountActivityPane(detail);
          fresh.scrollLeft = oldScroll;
          if (openDate) document.getElementById(openDate)?.showPopover();
          if (activityScroll !== null) {
            const list = fresh.querySelector('.activity-list');
            if (list) list.scrollTop = activityScroll;
          }
          fresh.querySelectorAll('[data-todo] > details').forEach(n => { n.open ||= openTodos.has(n.parentElement.dataset.todo); });
          if (fresh.dataset.detailRead === 'path') revealCurrentPhase();
          if (historyOpen && fresh.querySelector('.updates-history')) fresh.querySelector('.updates-history').open = true;
          fresh.querySelectorAll('.deal-note').forEach(n => { if (expanded.has(n.dataset.id)) n.querySelector('details').open = true; });
          fresh.querySelectorAll('details[data-meeting-id]').forEach(n => { n.open = openMeetings.has(n.dataset.meetingId); });
          for (const [id, resolution, reason] of dateAsks) {
            const form = fresh.querySelector(`[data-date-decision="${CSS.escape(id)}"]`);
            if (!form?.querySelector(`[data-date-ask="${resolution}"]`)) continue;
            askDateReason(form, resolution);
            form.elements.reason.value = reason;
          }
          if (focusIdentity) {
            const target = [...fresh.querySelectorAll('[data-detail-focus]')].find(n => n.dataset.detailFocus === focusIdentity);
            if (target) target.focus({preventScroll:true});
            else $('panelBody').querySelector('.deal-freshness [data-refresh-detail]')?.focus();
          }
          else if (focused?.id) document.getElementById(focused.id)?.focus({preventScroll:true});
        }
      }
      renderPlan(detail);
      void dealToursPanel?.refresh();
      void dealDocumentsPanel?.refresh();
      loadSuggestionEmails(detail);
      if ($('panelEvidenceSection')?.open) await refreshEvidence(detail, id, seq);
    }
    if (state.panelDeal !== id || seq !== panelReadSequence) return false;
    return true;
  } catch (error) {
    if (state.panelDeal !== id || seq !== panelReadSequence || refusePanelDetail(error)) return false;
    const message = 'Updates temporarily unavailable';
    const status = $('detailReadStatus');
    if (status) status.textContent = message;
    else $('panelBody').innerHTML = `<p role="status">${message}</p>`;
    return false;
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

function paintPanel(detail) {
  dealPlan?.dispose(); dealPlan = null;
  $('panelTitle').textContent = dealTitle(detail.deal);
  renderWorkspaceFacts(detail);
  disposeChecklist();
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose();
  const engineMode = privateSession()?.engineSignIn;
  disposePanelCallReview();
  $('panelBody').innerHTML = workspaceHtml(detail, engineMode);
  mountChecklist(detail);
  loadSuggestionEmails(detail);
  mountActivityPane(detail);
  const focusedTodo = $('panelBody').querySelector('.deal-path [data-focused] > summary');
  focusedTodo?.focus({ preventScroll: true });
  focusedTodo?.scrollIntoView({ block: 'center', inline: 'center' });
  if (!focusedTodo) revealCurrentPhase();
  disposeActivityAttribution();
  disposePanelEmailFollowups();
  syncUpdateForm();
  if ($('detailNoteEditor') && updateDraft) {
    $('detailNoteEditor').open = Boolean(updateDraft.text);
    $('detailNextStepEditor').open = !$('detailUpdateForm').querySelector('[data-discard-update]').hidden;
  }
  updateDetailTimestamp();
  const toursParams = new URLSearchParams(location.search);
  const linkedProperty = toursParams.get('deal') === detail.deal.id ? toursParams.get('property') : null;
  const property = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(linkedProperty ?? '') ? linkedProperty : null;
  const planTours = dealToursFromEngine();
  const propertyRead = new AbortController();
  let toursDisposed = false, toursLoading = false, toursMounted;
  dealToursPanel = engineMode && !planTours && !property ? null : {
    async load() {
      if (toursDisposed || toursLoading || toursMounted) return;
      toursLoading = true;
      const root = $('workspace-tours');
      root.textContent = 'Loading tours…';
      const toursUrl = `/deals?deal=${encodeURIComponent(detail.deal.id)}&tab=tours`;
      if (engineMode && property) {
        const engineProperty = detail.properties?.find(({ id }) => id === property.toLowerCase());
        if (!engineProperty) {
          root.innerHTML = '<p>This property is no longer on this deal.</p>';
          return;
        }
        const { name, address } = engineProperty;
        root.innerHTML = `<section aria-label="Property from tour feedback">
          <h2 tabindex="-1">${esc(name || address)}</h2>
          ${name ? `<p>${esc(address)}</p>` : ''}
          ${planTours ? `<a href="${esc(toursUrl)}">See deal tours</a>` : ''}
        </section>`;
        root.querySelector('h2').focus();
        return;
      }
      if (property) {
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
        if (planTours) {
          const { mountDealTourPlans } = await import('./ui-deal-tour-plans.generated.js');
          if (!toursDisposed) toursMounted = mountDealTourPlans(root, {
            dealId: detail.deal.id, properties: state.panelDetail?.properties, request: sessionFetch,
            tourSaved: () => void refreshPanel({ changed: true }),
          });
          return;
        }
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
    refresh() { return toursMounted?.refresh?.(); },
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
  $('tab-client-portal').hidden = !fromEngine;
  $('tab-plan').hidden = !detail.plan;
  if (workspaceTab === 'plan' && !detail.plan) workspaceTab = 'overview';
  selectWorkspaceTab(fromEngine && requestedClientPortal ? 'client-portal'
    : !fromEngine && workspaceTab === 'client-portal' ? 'overview' : workspaceTab);
  mountPanelActivityAttribution();
  void mountPanelEmailFollowups(detail.deal.id);
}
async function openWorkspace(dealId, trigger, { fromHistory = false } = {}) {
  if (!fromHistory && dealDocumentsPanel && !dealDocumentsPanel.confirmLeave()) return;
  if (!fromHistory && dealToursPanel && !await dealToursPanel.confirmLeave()) return;
  dealPlan?.dispose(); dealPlan = null;
  disposeChecklist();
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose(); dealToursPanel = null;
  closeFiledDocumentText();
  selectDocRecord('deal', dealId);
  const panel = $('recordPanel');
  disposeActivityAttribution();
  disposePanelCallReview();
  disposePanelEmailFollowups();
  if (!state.panelDeal) boardScroll = history.state?.boardScroll ?? pageScroller().scrollTop;
  const scope = new URLSearchParams(location.search);
  const focusStep = scope.get('deal') === dealId && scope.get('focus') === 'next-step';
  state.panelStepId = focusStep ? scope.get('step') : null;
  const toursLink = scope.get('deal') === dealId && (scope.has('property') || scope.get('tab') === 'tours');
  const linkedTab = scope.get('deal') === dealId ? scope.get('tab') : null;
  const renamedTab = renamedTabs[linkedTab] ?? linkedTab;
  workspaceTab = toursLink ? 'tours' : ['plan', 'activity'].includes(renamedTab) ? renamedTab : 'overview';
  requestedClientPortal = !toursLink && renamedTab === 'client-portal';
  timelineType = '';
  activityFilter = 'all';
  activityNoteDraft = '';
  activityOpen = null;
  activityFullEmails = false;
  ++panelReadSequence;
  automaticPhase.setOpenDeal(dealId);
  state.panelDeal = dealId; state.panelDetail = null; updateDraft = null;
  const url = new URL(location.href);
  if (!fromHistory && url.searchParams.get('deal') !== dealId) {
    for (const key of [...url.searchParams.keys()]) {
      if (!['owner', 'view', 'mode'].includes(key)) url.searchParams.delete(key);
    }
    url.searchParams.set('deal',dealId);
    writeWorkspaceHistory({...history.state, boardScroll:pageScroller().scrollTop}, location.href);
    writeWorkspaceHistory({doctorcreDealWorkspace:true},url,true);
  }
  state.panelReturnTo = trigger?.closest('.kanban-card')?.dataset.id || dealId;
  $('panelTitle').textContent = state.deals.get(dealId)?.name || 'Deal';
  $('panelBody').innerHTML = dealPlaceholderHtml;
  $('workspaceFacts').replaceChildren();
  $('workspaceTabs').innerHTML = workspaceTabs.map(tab => `<button class="workspace-tab" type="button" role="tab" id="tab-${tab.id}" aria-controls="workspace-${tab.id}" aria-selected="${tab.id === workspaceTab}" tabindex="${tab.id === workspaceTab ? 0 : -1}" data-workspace-tab="${tab.id}">${tab.label}</button>`).join('');
  $('tab-client-portal').hidden = true;
  $('tab-plan').hidden = true;
  dealPlan?.dispose(); dealPlan = null;
  $('main').hidden = true; panel.hidden = false;
  document.body.classList.add('workspace-open');
  pageScroller().scrollTo({ top: 0, behavior: 'instant' });
  $('panelTitle').focus({preventScroll:true});
  await refreshPanel();
  if (state.panelDeal === dealId && history.state?.doctorcreDocumentText)
    openFiledDocumentText(history.state.doctorcreDocumentText, {fromHistory:true});
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
  dealPlan?.dispose(); dealPlan = null;
  disposeChecklist();
  dealDocumentsPanel?.dispose(); dealDocumentsPanel = null;
  dealToursPanel?.dispose(); dealToursPanel = null;
  if (!fromHistory && history.state?.doctorcreDealWorkspace) { history.back(); return; }
  if (!fromHistory && incomingScope.has('deal')) {
    const origin = dealsPageOrigin('review') || dealsPageOrigin('national');
    if (origin) { returnToDealsPage(origin); return; }
  }
  selectDocRecord('deal', null);
  pageDocContext?.release('getDeal');
  ++panelReadSequence;
  const id = state.panelReturnTo;
  disposeActivityAttribution();
  disposePanelCallReview();
  disposePanelEmailFollowups();
  if (!fromHistory) {
    const url = new URL(location.href);
    for (const key of ['deal', 'checklist', 'property', 'tab', 'tour', 'focus', 'step', 'item']) url.searchParams.delete(key);
    writeWorkspaceHistory({},url,true);
  }
  closeFiledDocumentText();
  $('recordPanel').hidden = true; $('main').hidden = false;
  document.body.classList.remove('workspace-open');
  automaticPhase.setOpenDeal(null);
  state.panelDeal = null; state.panelStepId = null; state.panelDetail = null;
  pageScroller().scrollTo(0, history.state?.boardScroll ?? boardScroll);
  state.panelReturnTo = null;
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
  showScrollThumbs(board, '.kanban, .kanban-column');

  const openAttention = () => board.querySelector('.deal-board-attention[aria-expanded="true"]');
  const setAttention = (button, expanded) => {
    delete button.dataset.pinned;
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
  // A mouse shows the reason while it rests on the badge; a click or tap keeps it open.
  const hovered = event => event.pointerType === 'mouse' && event.target.closest('.deal-board-attention');
  board.addEventListener('pointerover', event => { const button = hovered(event); if (button) showAttention(button); });
  board.addEventListener('pointerout', event => {
    const button = hovered(event);
    if (button && !button.contains(event.relatedTarget) && !button.dataset.pinned && button !== document.activeElement) setAttention(button, false);
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('.deal-board-attention');
    const current = openAttention();
    if (current && current !== button && !event.target.closest('.deal-board-reason')) setAttention(current, false);
    if (button?.dataset.pinned) setAttention(button, false);
    else if (button) { showAttention(button); button.dataset.pinned = 'true'; }
  });

  board.addEventListener('click', (event) => {
    if (event.target.closest('[data-toggle-empty-stages]')) { state.showEmptyStages = !state.showEmptyStages; renderBoard(); return; }
    const add = event.target.closest('[data-add-to]');
    if (add) { openAddDeal(null, null, add.dataset.addTo); return; }
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

  // Right-click or long-press on a card offers that card's own controls.
  const quickControls = [
    ['Open', '.card-open'], ['Revive', '[data-revive]'], ['Undo', '[data-undo-phase]'], ['Client website', '[data-open-client-website]'],
  ];
  bindCardQuickMenu(board, {
    card: '.kanban-card',
    name: card => card.querySelector('.card-open')?.textContent?.trim() || '',
    actions: card => (card.classList.contains('deal-row') ? quickControls : quickControls.slice(0, 1))
      .map(([label, selector]) => [label, card.querySelector(selector)])
      .filter(([, control]) => control && control.getAttribute('aria-disabled') !== 'true')
      .map(([label, control]) => ({ label, control })),
  });
  board.addEventListener('quickmenuclose', () => {
    // eslint-disable-next-line no-restricted-syntax -- 1 deferred board paint after the quick menu closes, only when paintDeferred is set; 0 HTTP reads.
    if (state.paintDeferred) setTimeout(renderBoard);
  });

  board.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.kanban-card');
    if (!card) return;
    card.dataset.dragging = 'true';
    event.dataTransfer.setData('text/plain', card.dataset.id);
    event.dataTransfer.effectAllowed = 'move';
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
    // A lifted card keeps focus, even from its own controls: j/k would leave the lift and its target column behind.
    if ((event.key === 'j' || event.key === 'k') && state.lifted && state.lifted === card.dataset.id) { event.preventDefault(); return; }
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


function positionPathList(more) {
  const panel = more.querySelector('.deal-path-list-panel');
  const tile = more.closest('.deal-path-tile').getBoundingClientRect();
  const width = Math.min(innerWidth, Math.max(tile.width, 220));
  Object.assign(panel.style, { top: `${tile.bottom}px`, left: `${Math.max(0, Math.min(tile.left, innerWidth - width))}px`, width: `${width}px`, maxHeight: `${Math.max(0, innerHeight - tile.bottom)}px` });
}

function wire() {
  wireBoard();
  const repositionPathList = () => {
    const more = $('panelBody')?.querySelector('.deal-path-more[open]');
    if (more) positionPathList(more);
  };
  window.addEventListener('resize', repositionPathList);
  document.addEventListener('scroll', repositionPathList, true);

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
    const more = $('panelBody')?.querySelector('.deal-path-more[open]');
    if (more && (event.target.closest('[data-path-less]') || !more.contains(event.target))) {
      const restoreFocus = event.target.closest('[data-path-less]') || document.activeElement === document.body;
      more.open = false;
      if (restoreFocus) more.querySelector('summary').focus();
    }

    if ($('panelBody')?.querySelector('.deal-path-ask')
        && !event.target.closest('.deal-path-ask, button[data-path-phase]')) {
      const interactive = event.target.closest('button, a, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
      closePathQuestion({ focus: !interactive });
    }
    const copyLink = event.target.closest('button[data-copy-client-link]');
    if (copyLink) { copyClientLink(copyLink, navigator.clipboard); return; }
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
    const editSuggestion = event.target.closest('button[data-edit-suggestion], button[data-cancel-edit]');
    if (editSuggestion) { setSuggestionEdit(editSuggestion.form, editSuggestion.hasAttribute('data-edit-suggestion')); return; }
    const revive = event.target.closest('button[data-revive]');
    if (revive) { setOperatingState(revive.dataset.revive, {state:'active'}); return; }
    const pathPhase = event.target.closest('button[data-path-phase]');
    if (pathPhase) { askPathMove(pathPhase); return; }
    if (event.target.closest('[data-path-cancel]')) { closePathQuestion(); return; }
    const open = event.target.closest('button[data-open]');
    if (open) { openWorkspace(open.dataset.open, open); return; }
    const retry = event.target.closest('button[data-retry-write]');
    // eslint-disable-next-line no-restricted-syntax -- Only an explicit retry-button click reconciles the retained field write; no automatic resend occurs.
    if (retry) { retryFieldWrite(retry.dataset.retryWrite); return; }
    const phaseUndo = event.target.closest('button[data-undo-phase], #closedDealsView button[data-undo-invoice]');
    if (phaseUndo) {
      await automaticPhase.undo(phaseUndo, $('panelBody').contains(phaseUndo));
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
    // The close event fires after a save has already focused the new card.
    const active = document.activeElement;
    if (prospectConversion || (active !== document.body && !$('addDealDialog').contains(active))) return;
    const columnAdd = addDealPhase && document.querySelector(`[data-add-to="${CSS.escape(addDealPhase)}"]`);
    (columnAdd ?? $('addDealOpen')).focus();
  });

  let restoreTourHistory = null, departurePending = false;
  addEventListener('popstate', async event => {
    const workspaceHistoryIndex = workspaceHistory?.doctorcreWorkspaceIndex ?? 0;
    const destinationIndex = event.state?.doctorcreWorkspaceIndex ?? 0;
    if (restoreTourHistory) {
      if (destinationIndex !== workspaceHistoryIndex) { history.go(workspaceHistoryIndex - destinationIndex); return; }
      const restored = restoreTourHistory; restoreTourHistory = null; restored(); return;
    }
    const deal = new URL(location.href).searchParams.get('deal');
    const documentId = event.state?.doctorcreDocumentText;
    const distance = destinationIndex - workspaceHistoryIndex;
    const closingDocument = distance === -1 && workspaceHistory?.doctorcreDocumentText;
    const openingDocument = distance === 1 && documentId;
    if (deal && deal === state.panelDeal && (closingDocument || openingDocument)) {
      workspaceHistory = event.state;
      closeFiledDocumentText();
      if (documentId) openFiledDocumentText(documentId, {fromHistory:true});
      return;
    }
    if (dealToursPanel?.hasUnsavedChanges() || dealDocumentsPanel?.hasUnsavedChanges()) {
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
    workspaceHistory = event.state;
    if (deal) void openWorkspace(deal, null, {fromHistory:true});
    else closeWorkspace({fromHistory:true});
  });
  $('panelClose')?.addEventListener('click', () => closeWorkspace());
  $('panelBody').addEventListener('click', event => {
    if (event.target.closest('[data-open-deal-plan]')) { selectWorkspaceTab('plan'); $('tab-plan').focus(); }
  });
  $('workspaceTabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-workspace-tab]');
    if (tab) { selectWorkspaceTab(tab.dataset.workspaceTab); pageScroller().scrollTo(0,0); }
  });
  $('workspaceTabs').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const visibleTabs = workspaceTabs.filter(tab => !$(`tab-${tab.id}`).hidden);
    const index = visibleTabs.findIndex(tab => tab.id === workspaceTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
    selectWorkspaceTab(visibleTabs[next].id);
    $(`tab-${workspaceTab}`).focus();
    pageScroller().scrollTo(0,0);
  });
  $('receiptsOpen')?.addEventListener('click', () => {
    renderReceipts();
    document.dispatchEvent(new Event('doctorcre:open-today'));
  });


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
        changeReason: $('completionReason')?.value,
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
  $('timelineView').addEventListener('click', () => changeView('timeline'));
  $('parkedToggle').addEventListener('click', () => { state.parkedOpen = !state.parkedOpen; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); renderBoard(); });
  $('kanban').addEventListener('toggle', e => { if(e.target.classList.contains('parked-lane')) { state.parkedOpen=e.target.open; $('parkedToggle').setAttribute('aria-pressed',String(state.parkedOpen)); } },true);
  $('panelBody').addEventListener('toggle', event => {
    if (event.target.matches('.deal-path-more') && event.target.open) positionPathList(event.target);
    if (event.target.id === 'panelCallReview') return void openPanelCallReview(event.target);
    if (event.target.id !== 'panelEvidenceSection') return;
    if (event.target.open && state.panelDetail) void refreshEvidence(state.panelDetail, state.panelDeal, panelReadSequence);
  }, true);
  showScrollThumbs($('panelBody'), '.activity-list, .activity-pane, .deal-overview-grid > *');
  showScrollThumbs(document.body, '#appMainSlot:has(#workspace-overview:not([hidden]) > .deal-overview-grid)');
  $('panelBody').addEventListener('click', async e => {
    const chip = e.target.closest('[data-activity-filter]');
    if (chip && $('workspace-activity')?.contains(chip)) {
      activityFilter = showActivityFilter($('workspace-activity'), chip.dataset.activityFilter);
      return;
    }
    const latest = e.target.closest('[data-latest-activity], [data-all-activity]');
    if (latest) {
      selectWorkspaceTab('activity');
      if (latest.dataset.latestActivity) showActivityItem(latest.dataset.latestActivity);
      return;
    }
    const opener = e.target.closest('[data-activity-open]');
    if (opener) return showActivityItem(opener.dataset.activityOpen);
    if (e.target.closest('[data-activity-close]')) return showActivityItem(null);
    if (e.target.closest('[data-activity-retry]') && state.panelDetail) return void loadActivityThread(state.panelDetail);
    if (e.target.closest('[data-activity-full]') && state.panelDetail) {
      activityFullEmails = !activityFullEmails;
      const slot = $('panelBody').querySelector('[data-activity-thread]');
      slot.innerHTML = activityThreadHtml(activityThreads.get(threadKey(state.panelDetail, slot.dataset.activityThread)));
      return slot.querySelector('[data-activity-full]')?.focus();
    }
    const documentText = e.target.closest('[data-open-document-text]');
    if (documentText) return openFiledDocumentText(documentText.dataset.openDocumentText);
    if (e.target.closest('[data-undo-invoice]')) void undoInvoiceClose();
    const done = e.target.closest('[data-complete-step]');
    if (done) return completeDealStep(done);
    const dateAsk = e.target.closest('[data-date-ask]');
    if (dateAsk) {
      const { form, dataset: { dateAsk: resolution } } = dateAsk;
      askDateReason(form, resolution);
      return (resolution ? form.elements.reason : form.querySelector('.date-actions button')).focus();
    }
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
  document.addEventListener('keydown', event => {
    const more = $('panelBody')?.querySelector('.deal-path-more[open]');
    if (event.key === 'Escape' && more && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      more.open = false;
      more.querySelector('summary').focus();
    }
    else if (event.key === 'Escape' && $('panelBody')?.querySelector('.deal-path-ask') && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      closePathQuestion();
    }
    else if (event.key === 'Escape' && activityOpen && !$('workspace-activity')?.hidden && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      showActivityItem(null);
    }
  });
  $('panelBody').addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.target.closest('[data-suggestion-edit]')) {
      event.preventDefault();
      event.stopPropagation();
      setSuggestionEdit(event.target.form, false);
      return;
    }
    if (event.target.id === 'overviewNote') return submitOnEnter(event, () => event.target.form.requestSubmit());
    if (event.target.id !== 'dealUpdateStep' && event.target.id !== 'activityNote') return;
    const form = event.target.form;
    const submit = form.querySelector('button[type="submit"]:enabled');
    if (submit) submitOnEnter(event, () => form.requestSubmit(submit));
  });
  $('panelBody').addEventListener('input', e => {
    if (e.target.closest('#requirementEmailForm') && state.selfActor && draftActor === state.selfActor) {
      const draft = requirementDrafts.get(state.panelDeal) || {};
      Object.assign(draft, Object.fromEntries(new FormData($('requirementEmailForm'))));
      requirementDrafts.set(state.panelDeal, draft);
    }
    if (['activityNote', 'overviewNote'].includes(e.target.id)) activityNoteDraft = e.target.value;
    if (e.target.closest('#detailUpdateForm') && updateDraft && ['text','step','date'].includes(e.target.name)) {
      updateDraft[e.target.name] = e.target.value;
      if (e.target.name === 'text') updateTextDraft(updateDraft.id).write(updateDraft.text);
      syncUpdateForm();
    }
  });
  $('panelBody').addEventListener('change', async e => {
    if (e.target.id === 'timelineType') {
      timelineType = e.target.value;
      $('workspace-activity').querySelectorAll('[data-event-type]').forEach(row => { row.hidden = Boolean(e.target.value && row.dataset.eventType !== e.target.value); });
      return;
    }
    const id = state.panelDeal;

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
    if (e.target.dataset.pathMove) { e.preventDefault(); await movePathPhase(e.target); return; }
    e.preventDefault(); const id=state.panelDeal; const form = new FormData(e.target);
    const proposal = e.target.dataset.suggestionDecision;
    const choice = e.submitter?.value;
    if (proposal && state.panelDetail?.next_deal_saves && ['accept', 'dismiss'].includes(choice)) {
      let edits;
      if (choice === 'accept' && form.has('what')) {
        const what = String(form.get('what')).trim();
        if (!what) {
          showToast('Enter a next step before accepting.', {error:true});
          setSuggestionEdit(e.target, true);
          return;
        }
        edits = { what, due_on: form.get('due_on') || null };
      }
      await runFollowUp(`deal-email:${id}:${proposal}`, {
        verb:'decide-engine-deal-email',
        args:{ deal:id, proposal_id:proposal, decision:choice, ...(edits && { edits }) },
        summary:'Deal suggestion',
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
    if (['activityNoteForm', 'overviewNoteForm'].includes(e.target.id)) { await saveActivityNote(id, e.target.id); return; }
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

  addDealRequested = takeAddDealRequest();
  window.addEventListener('doctorcre-session-invalidated', () => { addDealRequested = false; }, { once: true });
  mountDock();
  wire();
  renderChips();
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
  // A temporary detail outage keeps the open deal on its normal refresh cadence.
  mountVisibilityPoll({ lifecycle: true, poll: async () => { await refreshPanel(); } });
  mountVisibilityPoll({ poll: () => { return pollOnce().catch(() => false); } });
  mountVisibilityPoll({ lifecycle: state.client.changeFeedEnabled === false, poll: () => state.boardSync.requestRefresh('periodic') });


}

if (globalThis.document) boot();

export { state };
/** Read-only view of the command dock's entries, for tests that prove what it retains. */
export const dockEntries = () => dock.entries ?? new Map();

function savedTourWrite(key, scope) {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key));
    return draft?.sessionBinding === `sha256:${scope}` ? draft : null;
  } catch { return null; }
}

function tourDraftDownload(urls, [label, filename, blob]) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.textContent = label;
  const row = document.createElement('li');
  row.append(link);
  return row;
}

async function readSavedTourDrafts(scope) {
  const drafts = [];
  if (!scope) return { drafts, recordingsUnavailable: false };
  const route = savedTourWrite(TOUR_DRAFT_KEYS.route, scope);
  const other = savedTourWrite(TOUR_DRAFT_KEYS.other, scope);
  if (route?.create || route?.composer) {
    const contents = route.create ?? { tour: route.composer.tourId, stops: route.composer.rows, endpoints: route.composer.endpointDraft };
    drafts.push(['Download saved route draft', 'tour-draft.json', new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' })]);
  }
  if (typeof other?.sheet?.draft === 'string') {
    drafts.push(['Download saved tour notes', 'tour-notes.txt', new Blob([other.sheet.draft], { type: 'text/plain' })]);
  }
  if (other?.action?.body) {
    const { path, body } = other.action;
    drafts.push(['Download pending tour change', 'tour-change.json', new Blob([JSON.stringify({ path, body }, null, 2)], { type: 'application/json' })]);
  }
  let store;
  try {
    store = createDayStore(window.indexedDB);
    const recordings = (await store.list(scope)).filter(note => note.audio instanceof Blob && note.audio.size);
    recordings.forEach(({ audio, property_name }, index) => {
      const extension = /^(?:audio\/)(webm|mp4|ogg)(?:;|$)/.exec(audio.type)?.[1] ?? 'audio';
      const label = typeof property_name === 'string' && property_name ? ` for ${property_name}` : '';
      drafts.push([`Download tour recording ${index + 1}${label}`, `tour-recording-${index + 1}.${extension}`, audio]);
    });
    return { drafts, recordingsUnavailable: false };
  } catch {
    return { drafts, recordingsUnavailable: true };
  } finally { await store?.close().catch(() => {}); }
}

const tourRecovery = globalThis.document?.getElementById('oldToursRecovery');
if (tourRecovery && document.documentElement.dataset.partnerSignIn === 'engine') {
  const note = document.getElementById('oldToursMoved');
  const button = document.getElementById('recoverTourDrafts');
  const status = document.getElementById('tourDraftStatus');
  const list = document.getElementById('tourDraftDownloads');
  const session = privateSession();
  note.hidden = new URLSearchParams(location.search).get('tours-moved') !== '1';
  tourRecovery.hidden = note.hidden;
  if (session && hasTourDrafts(window)) {
    const urls = [];
    const revokeDownloads = () => { urls.splice(0).forEach(url => URL.revokeObjectURL(url)); };
    window.addEventListener('pagehide', revokeDownloads, { once: true });
    window.addEventListener('doctorcre-session-invalidated', revokeDownloads, { once: true });
    void session.verify().then(() => { tourRecovery.hidden = button.hidden = false; }).catch(() => {});
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.hidden = false;
      status.textContent = 'Looking for saved drafts on this device…';
      try {
        const { actor } = await session.verify({ fresh: true });
        const { drafts, recordingsUnavailable } = await readSavedTourDrafts(legacyTourDraftScope(window, actor.slug));
        if (session.revoked) return;
        list.replaceChildren(...drafts.map(draft => tourDraftDownload(urls, draft)));
        list.hidden = drafts.length === 0;
        status.textContent = recordingsUnavailable ? 'Saved recordings could not be opened.'
          : drafts.length ? 'Saved drafts from this browser are ready to download.'
          : 'There are no saved tour drafts this sign-in can verify.';
      } catch { status.textContent = 'Saved tour drafts could not be opened.'; }
      finally { button.disabled = !list.hidden; }
    });
  }
}
