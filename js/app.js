import { renderDealSummary, renderDealItems } from './deal-items.js';
import { requireReviewReceipt } from './deal-review-model.js';
import { showToast } from './toast.js';
import {onDialogClosed} from './dialog-lifecycle.js';
import { dealInsightLines } from './pipeline-model.js';
import { selectDocRecord, setDocFilters, publishDocRead } from './doc-context.js';
import { createClient, PHASES, PHICON, ACTOR_LABEL, phaseLabel } from './client.js';
import { deploymentIdentity, resolveDealroomBoot } from './boot-mode.js';
import { uuidv4 } from './uuid.js';
import { createPostCallClient } from './post-call-review-client.js';
import { createCallMode, CALL_MODE_URL, CALL_MODE_HEADER } from './call-mode.js';
import {
  REVERTIBLE_FIELDS, escapeText, parkingReasonLabel, ingestChangeEvents, receiptViews,
  receiptListHtml, receiptsSignature, receiptsAnnouncement, createFeedProgress, observeChangeBatch,
  performUndo, fieldLabel, readableValue,
} from './change-receipts.mjs';
import {
  createBoardSync, batchTouchesBoard, resolveCurrentRow, SYNC_STATES, HEALTH,
} from './board-sync.mjs';
import {
  cellKey, performFieldWrite, unresolvedFieldWrites, fieldWriteMessage, nextCellBase,
} from './field-write-reconciliation.mjs';
import { beginCommand, settleCommand, classifyCommandOutcome, commandMessage, pendingCommand, performCommand } from './command-feedback.mjs';
import { renderAccountCards } from './account-cards.js';
import { updatedLabel } from './auto-refresh.mjs';
import { mountVisibilityPoll } from './visibility-poll.mjs';
import { createRetainedCommands } from './retained-commands.mjs';

const state = {
  client: null, selfActor: null, deals: new Map(), accounts: [],
  // Every displayed value comes from a board snapshot this coordinator applied;
  // the changes feed drives receipts, presence and capture, and asks for a new
  // snapshot, but never writes a value. See board-sync.mjs.
  boardSync: null,
  mode: 'fixture',
  workspace: 'team', accountId: null, filter: 'active', query: '', deepLinkMine: false,
  changed: new Set(),
  // Per cell, the newest event this session has SEEN for it — `{id, recorded_at}`
  // — which is the base its next write will send. THREE sources and one rule:
  // the authoritative board read, which now carries each editable cell's latest
  // committed event beside its value; the changes feed; and the answer to a write
  // this board made. All of them go through noteCellBase, which only ever moves a
  // base forward, so a read that was already open when a write was confirmed
  // cannot walk it back onto the event that write superseded.
  //
  // A cell with no history has no entry, and its write correctly sends null —
  // which the record layer reads as "any prior event conflicts", and on a cell
  // with no prior event that is simply no conflict. Nothing here is invented: an
  // absent base is absent, never a guess.
  fieldBase: new Map(),
  // One entry per edited cell, and only while its write is unanswered: the
  // request as it was sent — value, base and idempotency key — so a retry is the
  // SAME operation and not a second one. Never a value store; the board's values
  // come from a snapshot. See field-write-reconciliation.mjs.
  fieldWrites: {},
  nextStepRequests: new Map(), nextStepInFlight: new Set(),
  nationalCreations: {}, nationalConfirmations: {},
  presence: [], captureSessions: [],
  confirms: [], review: null,
  // Recent changes are session memory only: bounded, never stored, and never
  // a substitute for the deal's own Change history. The feed cursor starts at
  // the beginning of the log, so nothing is shown until it reaches the present.
  receipts: [], undo: {}, feed: createFeedProgress(),
  receiptSignature: null, receiptFocus: null, receiptAnnounced: null,
  // What the unconfirmed-changes bar last drew, so a poll does not rewrite it —
  // a render memo, exactly like receiptSignature. The operations themselves live
  // in fieldWrites and nowhere else.
  pendingSignature: null,
  // The Call Mode controller (./call-mode.js) owns every piece of call state.
  callModeUi: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const today = () => new Date(new Date().toDateString());
const esc = escapeText;
const actorName = (slug) => ACTOR_LABEL[slug] || slug || 'Unassigned';
const account = () => state.accounts.find((item) => item.account_client_id === state.accountId) || null;

function daysFromNow(value) {
  if (!value) return null;
  const baseline = today();
  baseline.setHours(12);
  return Math.round((new Date(`${value}T12:00:00`) - baseline) / 864e5);
}

function dateLabel(value) {
  if (!value) return 'Not set';
  const days = daysFromNow(value);
  const date = new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month:'short', day:'numeric' });
  if (days < 0) return `${date} · ${Math.abs(days)}d overdue`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `${date} · ${days}d`;
}

function relative(value) {
  if (!value) return 'not captured';
  const days = Math.round((Date.now() - new Date(value).getTime()) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function isStale(deal) {
  if (!deal.last_touch) return true;
  return (Date.now() - new Date(`${deal.last_touch}T12:00:00`).getTime()) / 864e5 >= 14;
}

function reasonFor(deal) {
  if (deal.operating_state === 'parked') return parkingReasonLabel(deal.parking_reason);
  const days = daysFromNow(deal.next_date);
  if (deal.attention) return 'Flagged for attention';
  if (days !== null && days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (!deal.next_step) return 'No next step';
  if (isStale(deal)) return deal.last_touch ? `Gone quiet ${relative(deal.last_touch)}` : 'No recent touch captured';
  if (!deal.market_agent && deal.workspace_kind === 'national_account') return 'Market agent unassigned';
  return `Ready for review · ${phaseLabel(deal.phase)}`;
}

function priority(deal) {
  const days = daysFromNow(deal.next_date);
  return (deal.attention ? 10000 : 0) + (days !== null && days < 0 ? 7000 + Math.abs(days) : 0)
    + (!deal.next_step ? 4000 : 0) + (isStale(deal) ? 2000 : 0)
    + (deal.workspace_kind === 'national_account' && !deal.market_agent ? 1000 : 0);
}

function clockLabel(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}:${String(at.getSeconds()).padStart(2,'0')}`;
}

/**
 * Where the freshness sentence lives so a keyboard or a screen reader can get
 * at it. `title` is hover-only, which makes it invisible to both.
 *
 * The badge becomes focusable and is DESCRIBED by a visually hidden sibling —
 * a sibling, not a child, because #syncStatus is a live region and a timestamp
 * changing inside it would be read out on every poll. Built once, from here,
 * using the stylesheet's existing `.sr-only` and `:focus-visible`: no markup
 * file changes and nothing about the layout moves.
 *
 * Known limit, named rather than papered over: this reaches assistive
 * technology and the keyboard, not a SIGHTED touch user, who still has no way
 * to summon the detail. That needs a visible disclosure in index.html/app.css,
 * which is outside this unit.
 */
function syncDetailNode() {
  const existing = $('#syncFreshness');
  if (existing) return existing;
  const badge = $('#syncStatus');
  const node = document.createElement('span');
  node.id = 'syncFreshness';
  node.className = 'sr-only';
  node.setAttribute('aria-live', 'off');
  badge.insertAdjacentElement('afterend', node);
  badge.setAttribute('tabindex', '0');
  badge.setAttribute('aria-describedby', 'syncFreshness');
  return node;
}

/**
 * What is true of each read path, in a sentence each. The board and the feed
 * are reported separately because they fail separately: a feed that answers
 * says nothing about whether the values are current.
 */
function syncDetail(status) {
  const at = status.last_read_at ? clockLabel(status.last_read_at) : null;
  const board = status.board_health === HEALTH.OK ? `Updated ${at}`
    : status.board_health === HEALTH.RENDER_FAILED ? `Display unavailable · Updated ${at || 'unknown'}`
    : at ? `Connection interrupted · Updated ${at}` : 'Updating…';
  const feed = status.feed_health === HEALTH.FAILED ? 'Activity temporarily unavailable' : '';
  return `${board}${feed ? ` · ${feed}` : ''}`;
}

/**
 * The connection badge, derived from the coordinator's two health signals. It
 * says what is true of the READS — not that the screen matches the record
 * layer, which no client can know.
 */
function setSync(status) {
  const el = $('#syncStatus');
  const live = state.mode === 'live';
  const label = status.state === SYNC_STATES.OFFLINE ? 'Offline'
    : status.state === SYNC_STATES.ERROR ? 'Board view error'
    : status.state === SYNC_STATES.RECONNECTING ? 'Reconnecting'
    : status.state === SYNC_STATES.READY ? 'Current'
    : 'Syncing…';
  el.classList.toggle('offline',
    [SYNC_STATES.OFFLINE, SYNC_STATES.RECONNECTING, SYNC_STATES.ERROR].includes(status.state));
  // role="status" is a live region: writing the same words again can read them
  // out again, so the text moves only when it actually changed.
  if (el.textContent !== label) el.textContent = label;
  const detail = syncDetail(status);
  el.title = detail;
  syncDetailNode().textContent = detail;
}

/**
 * Read the board authoritatively, then take one page of the changes feed.
 *
 * A failed read leaves the previous values on screen and says so in the badge —
 * except on the very first load, where there is nothing to leave: an empty
 * board would read as "no deals", which is a different claim from "the
 * board could not be read", so that one is raised.
 */
async function loadHome() {
  const outcome = await state.boardSync.refreshBoard({ reason:'load-home' });
  if (!outcome.applied && state.boardSync.status().snapshots === 0) {
    throw outcome.error || new Error('The board did not answer.');
  }
  await pollOnce(true);
  render();
}

function applyBoardSnapshot(home) {
  if (state.accessDenied) return;
  state.selfActor = home.actor || state.client.selfActor || state.selfActor;
  state.deals = new Map((home.deals || []).map((deal) => [deal.id, {
    workspace_kind: deal.account_client_id ? 'national_account' : 'team', ...deal,
  }]));
  // The base for each editable cell, from the same read as the values — so the
  // FIRST edit of a session sends what the record layer actually holds instead
  // of nothing, which that layer reads as "any prior event conflicts".
  //
  // Through noteCellBase, which is forward-only, because a snapshot is not
  // always the newest thing this page knows: a read that was already open when a
  // write was confirmed carries that cell's OLDER base, and its value is being
  // held over on the row for the same reason. Taking it would walk this cell's
  // base backwards and make the next edit collide with our own committed one.
  for (const deal of state.deals.values()) {
    for (const [field, seen] of Object.entries(deal.field_base || {})) {
      noteCellBase(cellKey(deal.id, field), seen);
    }
  }
  state.accounts = home.accounts || [];
  for (const deal of state.deals.values()) if (!deal.last_review_at) state.changed.add(deal.id);
  $('#selfAvatar').textContent = state.selfActor === 'dell' ? 'D' : state.selfActor === 'joe' ? 'J' : '?';
  document.dispatchEvent(new CustomEvent('doctorcre:partner', { detail: state.selfActor }));
}

async function pollOnce(initial = false, { force = false } = {}) {
  if (state.accessDenied) return;
  const outcome = await state.boardSync.pollChanges({ force });
  // Skipped (a poll was already open) or superseded (the answer stopped being
  // current before it arrived). Neither is news and neither moves the cursor.
  if (!outcome.applied) {
    if (outcome.reason === 'read_failed') console.warn('Deal Room poll failed', outcome.error);
    return;
  }
  if (state.accessDenied) return;
  const result = outcome.changes;
  state.presence = result.presence || [];
  state.captureSessions = result.capture_sessions || [];
  renderCaptureStatus();
  const batch = result.events || [];
  state.feed = observeChangeBatch(state.feed, batch);
  // Until the cursor reaches the present, these are pages of history, not
  // news: no toast announces them and the panel stays closed.
  const announce = !initial && state.feed.caught_up;
  for (const event of batch) {
    // The base for the NEXT write to this cell. It never rewrites a write that
    // is already out and unanswered: that request is a statement about what was
    // on screen when the person acted, and replay depends on it unchanged.
    if (event.field) noteCellBase(cellKey(event.subject_id, event.field), event);
    const deal = state.deals.get(event.subject_id);
    if (!deal) continue;
    if (!deal.last_review_at || String(event.recorded_at) > String(deal.last_review_at)) state.changed.add(deal.id);
    // NO VALUE IS TAKEN FROM AN EVENT. The feed is an ascending cursor over the
    // whole log, so an early page holds values that are months old; writing them
    // onto a deal put history back on the board. What an event does is mark the
    // record as changed, name the base for the next write, and — below — ask for
    // a fresh authoritative snapshot.
    if (announce && event.actor === state.selfActor && REVERTIBLE_FIELDS.includes(event.field)) {
      showToast(`${deal.name} updated`, {eventId:event.id});
    } else if (announce && event.actor !== state.selfActor && event.field) {
      showToast(`${actorName(event.actor)} updated ${deal.name}`);
    }
  }
  // News, not history: once the cursor is current, anything about a deal — including
  // one this board has never seen, which is what a new record looks like to an
  // empty board — is a reason to re-read the board. Requests coalesce into one
  // read, so a burst of partner edits costs one refresh, not one per event.
  if (state.feed.caught_up && batchTouchesBoard(batch)) state.boardSync.requestRefresh('change-feed');
  // Same events, kept instead of discarded once the toast fades. No second
  // read: this is the batch the board just consumed.
  state.receipts = ingestChangeEvents(state.receipts, batch, {
    dealName: (dealId) => state.deals.get(dealId)?.name || null,
    actorLabel: actorName,
  });
  renderReceipts();
  if (state.client.getPendingConfirms) await loadConfirms();
  if (!userIsEditing()) renderPreservingFocus(renderBoardOnly);
}

function userIsEditing() {
  return Boolean(document.querySelector('dialog[open]') || document.activeElement?.matches('input,textarea,select'));
}

function renderPreservingFocus(paint = render) {
  const active = document.activeElement;
  const root = active?.closest('#accountGrid, #stats, #emptyState');
  const attribute = ['data-account', 'data-open-deal', 'data-clear-search'].find(key => active?.hasAttribute(key));
  const selector = root && attribute ? `#${root.id} [${attribute}="${CSS.escape(active.getAttribute(attribute))}"]` : null;
  paint();
  if (selector && document.activeElement === document.body) $(selector)?.focus({ preventScroll: true });
}

function workspaceDeals() {
  let deals = [...state.deals.values()];
  if (state.query) {
    const query = state.query.toLowerCase();
    deals = deals.filter((deal) => [deal.name,deal.client_name,deal.account_name,deal.market,
      deal.market_agent,deal.next_step,deal.segment].some((value) => String(value || '').toLowerCase().includes(query)));
  } else if (state.workspace === 'team') {
    deals = deals.filter((deal) => deal.workspace_kind === 'team');
  } else if (state.accountId) {
    deals = deals.filter((deal) => deal.account_client_id === state.accountId);
  } else {
    deals = [];
  }
  if (state.filter === 'parked') deals = deals.filter((deal) => deal.operating_state === 'parked');
  else deals = deals.filter((deal) => (deal.operating_state || 'active') === 'active');
  if (state.filter === 'mine') deals = deals.filter((deal) => deal.owner === state.selfActor);
  if (state.filter === 'attention') deals = deals.filter((deal) => deal.attention || (daysFromNow(deal.next_date) ?? 0) < 0);
  if (state.filter === 'flagged') deals = deals.filter((deal) => deal.attention === true && (!state.deepLinkMine || deal.owner === state.selfActor));
  if (state.filter === 'stale') deals = deals.filter(isStale);
  if (state.filter === 'missing') deals = deals.filter((deal) => !deal.next_step);
  if (state.filter === 'delta') deals = deals.filter((deal) => state.changed.has(deal.id));
  return deals.sort((a,b) => priority(b) - priority(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function render() {
  renderChrome();
  renderAccounts();
  renderBoardOnly();
}

function renderChrome() {
  $$('.workspace').forEach((button) => {
    const active = button.dataset.workspace === state.workspace;
    button.classList.toggle('on', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $$('.filter').forEach((button) => button.classList.toggle('on', button.dataset.filter === state.filter));
  const selected = account();
  const isAccountHome = state.workspace === 'national_account' && !state.accountId && !state.query;
  $('#accountBack').hidden = !state.accountId;
  $('#accountContext').hidden = !state.accountId || Boolean(state.query);
  $('#accountContextName').textContent = selected?.account_name || 'National account';
  $('#accountContextOwner').textContent = selected ? `Owned by ${actorName(selected.account_owner)}` : '';
  // Never print the partners' names as a label: the team is both partners by
  // definition, so the combined list is just "Deals". The team view carries no
  // description sentence under its title (2026-09-16 review).
  $('#workspaceTitle').textContent = state.query ? 'Search results' : state.workspace === 'team' ? 'Deals'
    : selected?.account_name || 'National Accounts';
  $('#workspaceSubtitle').textContent = state.query ? 'Searching deals across the territory and every national account.' : '';
  const addLabel = state.workspace === 'national_account' ? (selected ? 'Add market deal' : 'Add national account') : 'Add deal';
  $('#stickyAddButton').textContent = `+ ${addLabel}`;
  $('#stickyAddButton').setAttribute('aria-label', addLabel);
  $('#ownerButton').hidden = !selected;
  $('#agendaButton').hidden = isAccountHome;
  const agentHeading = state.workspace === 'national_account' ? 'Market agent' : 'Owner';
  $('#agentHeading').textContent = agentHeading;
  $('#stickyAgentHeading').textContent = agentHeading;
  $('#accountGrid').hidden = !isAccountHome;
  $('#boardSection').hidden = isAccountHome;
}

function accountPriority(deals) {
  const ordered = [...deals].sort((a, b) => (a.next_date || '9999-12-31').localeCompare(b.next_date || '9999-12-31')
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const overdue = ordered.filter((deal) => (daysFromNow(deal.next_date) ?? 0) < 0);
  return { overdue, next: ordered[0] };
}

function renderAccounts() {
  const grid = $('#accountGrid');
  grid.innerHTML = renderAccountCards(state.accounts.map(item => ({ ...item, next_action: accountPriority(
    [...state.deals.values()].filter(deal => deal.account_client_id === item.account_client_id
      && (deal.operating_state || 'active') === 'active' && !deal.invoiced_on)
  ).next })), { esc, relative, actorName, dateLabel });
}

/**
 * Where an unconfirmed change can always be found.
 *
 * The row's own Retry is the natural place for one, and it is the place a filter,
 * a search or a workspace switch takes away — so the sentence that says "send it
 * again" was pointing at a control the person might not be able to see. This bar
 * is the answer to that: one line per operation this page has not had an answer
 * to, above the workspace, outside every filter, naming the actual record and the
 * actual cell, carrying the SAME deliberate retry as everywhere else.
 *
 * Built here rather than in the markup, the way the freshness detail is: it is
 * the one control whose existence depends on something having gone wrong.
 */
function pendingWritesNode() {
  const existing = $('#pendingWrites');
  if (existing) return existing;
  const main = $('#main');
  if (!main) return null;
  const node = document.createElement('section');
  node.id = 'pendingWrites';
  node.className = 'parking-banner';
  // A status region, not an alert: it is a standing list, and it is only rewritten
  // when the set of unconfirmed operations actually changes — so a background
  // poll neither re-announces it nor destroys the button under a finger.
  node.setAttribute('role', 'status');
  node.setAttribute('aria-label', 'Unconfirmed changes');
  main.insertAdjacentElement('afterbegin', node);
  return node;
}

function renderPendingWrites() {
  const node = pendingWritesNode();
  if (!node) return;
  const pending = unresolvedFieldWrites(state.fieldWrites);
  node.hidden = pending.length === 0;
  const signature = JSON.stringify(pending.map((entry) => [entry.cell, state.deals.get(entry.deal)?.name || '']));
  if (signature === state.pendingSignature) return;
  state.pendingSignature = signature;
  if (!pending.length) { node.innerHTML = ''; return; }
  node.innerHTML = `<b>Unconfirmed changes · ${pending.length}</b>`
    + pending.map((entry) => {
      // The record as this board actually knows it. A deal the last snapshot did
      // not return is not given a borrowed name: the cell is still nameable and
      // the operation is still re-sendable, and Open record still reaches it,
      // because a detail read asks the record layer by id.
      const deal = state.deals.get(entry.deal);
      const name = deal?.name || 'a record this board is not showing right now';
      return `<span>${esc(fieldLabel(entry.field))} on ${esc(name)} — not confirmed
        <button type="button" class="park-button" data-retry-write="${esc(entry.cell)}"
          aria-label="Send the unconfirmed ${esc(fieldLabel(entry.field))} change on ${esc(name)} again">Send again</button>
        <button type="button" class="park-button" data-open-deal="${esc(entry.deal)}"
          aria-label="Open ${esc(name)} and check what it holds">Open record</button></span>`;
    }).join('');
}

function renderBoardOnly() {
  // Before the board's own visibility is considered: an unconfirmed change
  // belongs to the page, not to whichever workspace or filter is showing.
  renderPendingWrites();
  if ($('#boardSection').hidden) return;
  const deals = workspaceDeals();
  setDocFilters({ workspace:state.workspace, account:state.accountId, filter:state.filter, query:state.query });
  if (state.boardSync?.status().board_health === 'ok' && !state.boardSync.status().board_read_in_flight) publishDocRead('getBoard', { deals }, []);
  renderStats(deals);
  renderFocus(deals);
  const rows = $('#rows');
  rows.innerHTML = deals.map(rowHtml).join('');
  $('#tableFrame').classList.toggle('has-deal-summaries', deals.length > 0 && deals.every(deal => deal.workspace_kind === 'national_account'));
  const emptySearch = Boolean(state.query && !deals.length);
  $('#stats').hidden = emptySearch;
  $('#tableFrame table').hidden = emptySearch;
  $('.sticky-table-header').hidden = emptySearch;
  $('#emptyState').hidden = deals.length > 0;
  $('#emptyState').innerHTML = emptySearch
    ? `<strong>No deals match “${esc(state.query)}”</strong><p>Try another name, market, or next step.</p><button type="button" class="secondary" data-clear-search>Clear search</button>`
    : state.filter === 'parked' ? 'No parked deals.' : 'No active work matches this filter.';
  applyPresence();
}

function renderStats(deals) {
  const accountDetail = state.workspace === 'national_account' && state.accountId && !state.query && state.filter !== 'parked';
  $('#stats').classList.toggle('account-priority', Boolean(accountDetail));
  if (accountDetail) {
    const { overdue, next } = accountPriority(deals);
    $('#stats').innerHTML = next ? `
      <span class="next-action-label${overdue.length ? ' is-alert' : ''}">${overdue.length ? 'Next overdue action' : 'Next market action'}</span>
      <button type="button" class="next-account-action" data-open-deal="${esc(next.id)}">
        <strong>${esc(next.next_step || 'Set the next step')}</strong>
        <span>${esc(next.name)} · ${esc(dateLabel(next.next_date))}</span>
        <span class="next-action-open">Open deal →</span>
      </button>
      <p class="account-urgency">${deals.length} active work · <span${overdue.length ? ' class="is-alert"' : ''}>${overdue.length} overdue dates</span> · ${deals.filter((deal) => deal.phase === 'Closing').length} at closing</p>` : '';
    return;
  }
  if (state.filter === 'parked') {
    $('#stats').innerHTML = `
      <div class="stat"><strong>${deals.length}</strong><span>Parked records</span></div>
      <div class="stat"><strong>${deals.filter((deal) => deal.parking_reason === 'prospect_never_active').length}</strong><span>Never activated</span></div>
      <div class="stat"><strong>${deals.filter((deal) => deal.parking_reason === 'client_paused').length}</strong><span>Client paused</span></div>
      <div class="stat"><strong>${deals.filter((deal) => deal.parking_reason === 'other').length}</strong><span>Other reason</span></div>`;
    return;
  }
  const overdue = deals.filter((deal) => (daysFromNow(deal.next_date) ?? 0) < 0).length;
  const clarity = deals.filter((deal) => !deal.next_step || isStale(deal)).length;
  $('#stats').innerHTML = `
    <div class="stat"><strong>${deals.length}</strong><span>Active work</span></div>
    <div class="stat"><strong>${deals.filter((deal) => deal.phase === 'Closing').length}</strong><span>At closing</span></div>
    <div class="stat${overdue ? ' risk' : ''}"><strong>${overdue}</strong><span>Overdue dates</span></div>
    <div class="stat"><strong>${clarity}</strong><span>Need clarity</span></div>`;
}

function renderFocus(deals) {
  if (state.filter === 'parked' || (state.workspace === 'national_account' && state.accountId && !state.query)) { $('#focusStrip').innerHTML = ''; return; }
  const items = deals.filter((deal) => priority(deal) > 0).slice(0, 4);
  $('#focusStrip').innerHTML = items.length ? '<span class="focus-label">Focus first</span>' + items.map((deal) => `
    <button type="button" class="focus-item" data-open-deal="${esc(deal.id)}"><b>${esc(deal.name)}</b><span>${esc(reasonFor(deal))}</span></button>`).join('') : '';
}

function phaseOptions(current) {
  // The option value stays the wire word the record layer speaks; only the
  // text a human reads carries the display label.
  return PHASES.map((phase) => `<option value="${esc(phase)}"${phase === current ? ' selected' : ''}>${esc(phaseLabel(phase))}</option>`).join('');
}

function rowHtml(deal) {
  const days = daysFromNow(deal.next_date);
  const parked = deal.operating_state === 'parked';
  const classes = [parked ? 'parked' : '', deal.attention ? 'attention' : '', days !== null && days < 0 ? 'overdue' : ''].join(' ');
  const partnerPresence = state.presence.find((lease) => lease.deal_id === deal.id && lease.actor !== state.selfActor && new Date(lease.expires_at) > new Date());
  const meta = [deal.market, deal.type, state.query && deal.account_name ? deal.account_name : null,
    parked ? parkingReasonLabel(deal.parking_reason) : null,
    partnerPresence ? `${actorName(partnerPresence.actor)} is editing` : null].filter(Boolean);
  // A write this board never got an answer to stays on its row until a person
  // settles it. The control re-sends THAT request — same key — rather than
  // guessing a new one, and it is the row's own text, not a toast that fades and
  // not a title only a mouse can find.
  const unconfirmed = unresolvedFieldWrites(state.fieldWrites, deal.id).map((entry) => `<button type="button"
    class="park-button" data-retry-write="${esc(entry.cell)}"
    aria-label="${esc(fieldLabel(entry.field))} on ${esc(deal.name)} was not confirmed — send the same change again">${esc(fieldLabel(entry.field))} not confirmed · Retry</button>`).join('');
  return `<tr class="${classes}" data-deal-id="${esc(deal.id)}">
    <td><div class="deal-cell"><button type="button" class="attention-button" data-attention="${esc(deal.id)}" aria-pressed="${Boolean(deal.attention)}" aria-label="${deal.attention ? 'Clear attention flag' : 'Flag for attention'} on ${esc(deal.name)}"${parked ? ' disabled' : ''}>${deal.attention ? '⚠' : (PHICON[deal.phase] || '○')}</button>
      <div><button type="button" class="deal-link" data-open-deal="${esc(deal.id)}">${esc(deal.name)}</button>
      <div class="deal-meta">${meta.map((item) => `<span>${esc(item)}</span>`).join('<span>·</span>')}</div></div></div></td>
    <td><select class="cell-select" data-phase="${esc(deal.id)}" aria-label="Phase for ${esc(deal.name)}"${parked ? ' disabled' : ''}>${phaseOptions(deal.phase)}</select></td>
    <td>${deal.workspace_kind === 'national_account' ? `<button type="button" class="step-button" data-next-step="${esc(deal.id)}"${parked ? ' disabled' : ''}>${renderDealSummary(deal, { today: new Date().toLocaleDateString('en-CA'), viewer: state.selfActor, actorName })}</button>${renderDealItems(deal, { today: new Date().toLocaleDateString('en-CA'), empty: false, board: true })}` : `<button type="button" class="step-button ${deal.next_step ? '' : 'empty'}" data-next-step="${esc(deal.id)}"${parked ? ' disabled' : ''}>${esc(deal.next_step || 'Set the next step…')}</button>`}</td>
    <td><span class="due ${days !== null && days < 0 ? 'over' : days !== null && days <= 3 ? 'soon' : ''}">${esc(dateLabel(deal.next_date))}</span></td>
    <td>${deal.workspace_kind === 'national_account'
      ? `<button type="button" class="agent-button" data-market-agent="${esc(deal.id)}"${parked ? ' disabled' : ''}>${esc(deal.market_agent || 'Assign agent…')}</button>`
      : `<select class="cell-select" data-owner="${esc(deal.id)}" aria-label="Owner for ${esc(deal.name)}"${parked ? ' disabled' : ''}><option value="">Unassigned</option><option value="joe"${deal.owner === 'joe' ? ' selected' : ''}>Joe</option><option value="dell"${deal.owner === 'dell' ? ' selected' : ''}>Dell</option></select>`}</td>
    <td class="row-actions">${unconfirmed}<button type="button" class="park-button" data-operating-state="${parked ? 'active' : 'parked'}" data-deal="${esc(deal.id)}">${parked ? 'Restore' : 'Park'}</button><button type="button" class="row-menu" data-open-deal="${esc(deal.id)}" aria-label="Open ${esc(deal.name)} details">•••</button></td>
  </tr>`;
}

function applyPresence() {
  for (const lease of state.presence) {
    if (lease.actor === state.selfActor || new Date(lease.expires_at) <= new Date()) continue;
    const row = document.querySelector(`[data-deal-id="${CSS.escape(lease.deal_id)}"]`);
    if (row) row.title = `${actorName(lease.actor)} is editing ${lease.field}`;
  }
}

function renderCaptureStatus() {
  const active = state.captureSessions.find((session) => !['done','completed','failed','cancelled'].includes(session.state));
  const badge = $('#captureStatus');
  badge.hidden = !active;
  if (active) badge.textContent = `Capture: ${String(active.state).replaceAll('_',' ')}`;
}

/**
 * Deal Room Call Mode lives in ./call-mode.js (restored per decision 7dc47eea):
 * record Joe and Dell's pipeline call through the local call recorder, then
 * review a post-call pack in which every item waits for a partner's approval.
 * This shell only builds the controller and forwards clicks to it.
 */
function installCallMode() {
  state.callModeUi = createCallMode({
    root: document,
    client: () => state.client,
    postCallClient: createPostCallClient({ loopbackUrl: CALL_MODE_URL, postHeaders: CALL_MODE_HEADER }),
    agendaDeals,
    scope: () => ({ workspace_kind: state.workspace, ...(state.accountId ? { account_client_id: state.accountId } : {}) }),
    dealName: (id) => state.deals.get(id)?.name,
    dateLabel,
    toast: (message) => showToast(message),
    startAgenda,
    onConfirmed: loadHome,
  });
  state.callModeUi.checkEligibility();
  return state.callModeUi;
}

let screenCommands = {};
const screenActions = new Map();
function screenStatusNode() {
  let node = $('#screenActionStatus');
  if (!node) { node = document.createElement('div'); node.id = 'screenActionStatus'; node.className = 'state-block'; }
  const host = state.review ? $('#agendaPanel') : $('#main');
  if (node.parentElement !== host) host.prepend(node);
  return node;
}
function renderScreenActions() {
  const node = screenStatusNode();
  node.hidden = !screenActions.size;
  node.innerHTML = [...screenActions.entries()].map(([key,entry]) => {
    const pending = pendingCommand(screenCommands,key);
    const busy = pending?.status === 'pending';
    return `<div data-screen-outcome="${esc(key)}" role="status"><p>${esc(entry.label)}: ${busy ? 'Saving…' : esc(entry.message || 'Outcome unknown. Check the original request before changing it.')}</p>${entry.denied ? '<a href="/auth/login">Sign in</a>' : busy ? '' : `<button type="button" data-screen-retry="${esc(key)}">${pending ? 'Check outcome' : 'Retry'}</button>`}</div>`;
  }).join('');
  const busy = Object.values(screenCommands).some(command => command.status === 'pending');
  for (const control of $$('#agendaButton,#agendaReviewed,#agendaSkip,#agendaEnd,#agendaClose,[data-confirm]')) control.disabled = Boolean(busy || state.accessDenied);
}
function refuseScreenAccess() {
  state.accessDenied = true;
  screenCommands = {};
  state.review = null; state.confirms = []; state.deals.clear();
  $('#agendaPanel').hidden = true; $('#confirmDock').hidden = true;
  $('#rows').replaceChildren(); selectDocRecord(null,null);
}
async function runScreenAction(key,args,method,label,accepted) {
  if (state.accessDenied) return false;
  const held = screenActions.get(key);
  if (pendingCommand(screenCommands,key) && held && held.args !== args) { renderScreenActions(); return false; }
  const entry = pendingCommand(screenCommands,key) && held ? held : {args,label,run:() => runScreenAction(key,args,method,label,accepted)};
  screenActions.set(key,entry);
  const result = await performCommand({operationKey:key,args,newKey:uuidv4,
    getState:() => screenCommands,setState:next => {screenCommands=next;renderScreenActions();},
    call:async request => {
      return appWrite(key, request, async retained => {
        const response = await state.client[method](retained);
        if (response?.ok === false) throw Object.assign(new Error('Action refused'),{payload:response});
        if (method === 'startReview') requireReviewReceipt(response);
        return response;
      });
    }});
  if (state.accessDenied) return false;
  if (result.status !== 'ok') {
    entry.message = commandMessage(result,label).replace('on the command dock, or open the record to check','below');
    entry.denied = [401,403].includes(result.http_status);
    if (entry.denied) refuseScreenAccess();
    renderScreenActions(); return false;
  }
  screenActions.delete(key); renderScreenActions();
  try { await accepted(result.response); }
  catch { entry.message = 'Change confirmed. The board refresh is unavailable.'; entry.run = async () => { try {await loadHome();screenActions.delete(key);renderScreenActions();} catch {renderScreenActions();} }; screenActions.set(key,entry);renderScreenActions(); }
  return true;
}
async function loadConfirms() {
  if (state.accessDenied) return;
  try {
    const pending = await state.client.getPendingConfirms();
    if (state.accessDenied) return;
    if (!Array.isArray(pending?.proposals)) throw new Error('Invalid capture queue');
    state.confirms = pending.proposals;
    state.confirmError = null;
  } catch (error) {
    state.confirmError = [401,403].includes(error?.status) ? 'denied' : 'unavailable';
    if (state.confirmError === 'denied') refuseScreenAccess();
  }
  renderConfirms();
}
function renderConfirms() {
  const dock = $('#confirmDock');
  dock.hidden = !state.confirms.length && !state.confirmError;
  dock.innerHTML = (state.confirmError ? `<span role="status">Suggestions unavailable. ${state.confirmError === 'denied' ? '<a href="/auth/login">Sign in</a>' : '<button type="button" data-confirms-retry>Retry suggestions</button>'}</span>` : '') + state.confirms.map((proposal) => `<span class="confirm-chip" data-proposal="${esc(proposal.id)}">${esc(proposal.label)}
    <button type="button" class="yes" data-confirm="yes">Confirm</button><button type="button" class="skip-confirm" data-confirm="no">Skip</button></span>`).join('');
}

function renderReceipts() {
  const panel = $('#receiptsPanel');
  if (!panel) return;
  const list = $('#receiptsList');
  const jump = $('#receiptsJump');
  // Nothing is shown while the cursor is still working through history: an old
  // page is not "recent", and its newest row is not safely undoable.
  const views = state.feed.caught_up
    ? receiptViews(state.receipts, { selfActor: state.selfActor, undo: state.undo, now: Date.now() })
    : [];
  panel.hidden = views.length === 0;
  // The board is long. A counted control sits with the other board controls so
  // the panel below the table is findable without scrolling for it.
  jump.hidden = views.length === 0;
  $('#receiptsCount').textContent = String(views.length);
  jump.setAttribute('aria-label', `Go to recent changes — ${views.length} seen in this session`);
  // Read the focus request whether or not this render proceeds, so a skipped
  // render cannot leave it to be spent on an unrelated one later.
  const active = document.activeElement;
  const keep = state.receiptFocus
    || (active && list.contains(active) ? active.closest('[data-receipt]')?.dataset.receipt : null)
    || null;
  state.receiptFocus = null;
  const signature = receiptsSignature(views);
  if (signature === state.receiptSignature) return;
  state.receiptSignature = signature;
  // Re-render only on a real change, so an Undo button under the partner's
  // finger keeps its focus. The list is NOT a live region — announcing it
  // wholesale would read all 25 rows back for one change — so what actually
  // arrived is named on its own short status line.
  // Renders while the list is closed hold no news and leave the baseline
  // unset, so the render that finally opens it announces nothing either.
  const opened = views.length > 0;
  const announcement = opened ? receiptsAnnouncement(state.receiptAnnounced, views) : '';
  if (opened) state.receiptAnnounced = views.map((view) => view.event_id);
  $('#receiptsLive').textContent = announcement;
  list.innerHTML = receiptListHtml(views.map(view => ({...view, can_undo:false})));
  if (keep) focusReceipt(keep);
}

/**
 * Land the keyboard somewhere sensible after a row is rebuilt. The Undo button
 * is gone once the change is undone or refused, and is disabled while pending,
 * so the row itself is the next best position; the panel heading is the last
 * resort when the row has fallen off the end of the list.
 */
function focusReceipt(eventId) {
  const list = $('#receiptsList');
  const target = $(`[data-undo="${CSS.escape(eventId)}"]`, list)
    || $(`[data-receipt="${CSS.escape(eventId)}"]`, list)
    || $('#receiptsTitle');
  // Restoring focus must not yank the page: this runs on poll-driven renders.
  target?.focus({ preventScroll: true });
}

function goToReceipts() {
  const panel = $('#receiptsPanel');
  if (panel.hidden) return;
  document.dispatchEvent(new Event('doctorcre:open-today'));
  if (!document.getElementById('appToday')) panel.scrollIntoView({ block: 'start' });
  $('#receiptsTitle').focus({ preventScroll: true });
}

/**
 * A write the server has already confirmed, applied to the page.
 *
 * Four things happen together, and the order is the point:
 *   1. the value lands on the CURRENT board row, looked up now — a row captured
 *      before a snapshot arrived is no longer the object being rendered;
 *   2. it is HELD, so a board read that was already open when the write was
 *      confirmed cannot put the old value back when it answers;
 *   3. the record is marked as changed for the delta filter;
 *   4. a fresh authoritative read is REQUESTED, never awaited — acknowledgement
 *      is immediate and the re-read follows it.
 *
 * @returns the live deal row, or null if the board does not hold it.
 */
function confirmLocalWrite(dealId, patch) {
  const deal = state.deals.get(dealId) || null;
  if (deal) Object.assign(deal, patch);
  state.boardSync.noteLocalWrite(dealId, patch);
  state.changed.add(dealId);
  state.boardSync.requestRefresh('after-write');
  return deal;
}

/**
 * One undo, one event, one in-flight request, one idempotency key.
 *
 * Nothing about the deal is changed here before the server answers, and the
 * row is marked undone only on a confirmed success. A refusal stays on the
 * row; an unconfirmed answer is left unconfirmed rather than retried.
 */
async function runUndo(eventId, trigger = null) {
  if (!eventId) return;
  // Focus is only moved when the click came from the list itself; a toast Undo
  // must not drag the keyboard down the page.
  const fromList = Boolean(trigger && $('#receiptsList')?.contains(trigger));
  const result = await performUndo({
    eventId,
    getState: () => state.undo,
    setState: (next) => { state.undo = next; if (fromList) state.receiptFocus = eventId; renderReceipts(); },
    newKey: uuidv4,
    revert: (request) => state.client.revertDealField(request),
  });
  if (!result.started) return;
  if (result.outcome.status === 'succeeded') {
    await loadHome();
    showToast('Change undone');
    return;
  }
  showToast(result.outcome.message, {error:true});
}

/**
 * Send one cell change — or put the one that was never answered back out.
 *
 * The key is minted per intended action, not per attempt, and the retained
 * request is sent unchanged: same value, same base, same key. That is what makes
 * a retry a replay at the server instead of a second write that collides with
 * the first one and manufactures a conflict between a person and themselves.
 * Nothing here decides anything about the deal; the answer does.
 */
async function sendCellWrite(dealId, field, value) {
  const cell = cellKey(dealId, field);
  const result = await performFieldWrite({
    deal: dealId, field, value,
    base: state.fieldBase.get(cell)?.id || null,
    // Read AGAIN when the answer lands. If the base moved while the request was
    // out, the answer — a replayed one especially — is the recorded result of an
    // operation the board has since learned something newer about, and its value
    // must not be painted over what it learned.
    baseNow: () => state.fieldBase.get(cell)?.id || null,
    getState: () => state.fieldWrites,
    setState: (next) => { state.fieldWrites = next; },
    newKey: uuidv4,
    patch: (request) => state.client.patchDealField(request),
  });
  // The base for the NEXT write to this cell, taken from the record's own answer
  // about this one instead of waiting a poll for the feed to say the same thing.
  // That wait is what made a second, different edit inside the poll window send a
  // base its own first edit had already superseded — a conflict with itself.
  //
  // Only an accepted answer names an event. `superseded` is checked as well as
  // ordered against: an answer replayed from an older operation must not reset
  // the base even if the record layer sent no time to order it by.
  if (result.status === 'ok' && !result.superseded && result.event_id) {
    noteCellBase(cell, { id: result.event_id, recorded_at: result.event_recorded_at });
  }
  return result;
}

/**
 * Record the newest event seen for one cell.
 *
 * One home for the rule, because there are now two sources: the changes feed —
 * partner events, and this board's own arriving late — and the answer to a write
 * this board made. `nextCellBase` keeps whichever is newer by `(recorded_at, id)`,
 * the record layer's own ordering, so an old page of catch-up history and a
 * replayed answer about an older operation both leave a newer base alone.
 */
function noteCellBase(cell, event) {
  if (!event?.id) return;
  // Identity and time only. A feed event carries values too, and none of them
  // belong in this map — the board's values come from a snapshot, and this is a
  // base, not a value.
  const seen = { id: event.id, recorded_at: event.recorded_at ?? null };
  state.fieldBase.set(cell, nextCellBase(state.fieldBase.get(cell) || null, seen));
}

/** The cell, named the way a person reading a toast about it would name it. */
function cellSubject(dealId, field) {
  return `${fieldLabel(field)} on ${state.deals.get(dealId)?.name || 'this record'}`;
}

/** Where an answer must appear: inside the modal the control was pressed in. */
function writeSurfaceFor(trigger) {
  const dialog = $('#dealDialog');
  return trigger && dialog?.open && dialog.contains(trigger) ? 'dialog' : 'toast';
}

/**
 * Put the answer where the person is actually looking.
 *
 * A dialog opened with showModal() is in the top layer — above every z-index and
 * behind its own backdrop — so a toast raised while #dealDialog is open is
 * dimmed, blurred and unreadable, and the row control that would act on it is
 * behind the same backdrop. The sentence goes INSIDE the dialog instead, and
 * carries the same deliberate retry the row carries: the same operation, the
 * same key, never a fresh one. It takes the keyboard because it is the answer to
 * what was just pressed here.
 *
 * It belongs to the dialog's own content: re-opening a record rebuilds it away,
 * and every settled answer on this path closes the dialog, so nothing has to
 * remember to take it down.
 *
 * @returns true when the notice was placed; false when no deal dialog is open
 *   and the caller should say it the ordinary way.
 */
function showDealDialogNotice(message, retryCell = null) {
  const dialog = $('#dealDialog');
  if (!dialog?.open) return false;
  const host = $('.deal-content', dialog) || $('#dealDetail');
  if (!host) return false;
  let notice = $('#dealNotice', dialog);
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'dealNotice';
    notice.className = 'parking-banner';
    notice.setAttribute('role', 'alert');
    notice.setAttribute('tabindex', '-1');
    host.prepend(notice);
  }
  notice.innerHTML = `<b>${esc(message)}</b>${retryCell
    ? `<button type="button" class="park-button" data-retry-write="${esc(retryCell)}">Send this change again</button>`
    : ''}`;
  ($('[data-retry-write]', notice) || notice).focus({ preventScroll: true });
  return true;
}

/**
 * Say what happened to a change — and only what is known — where it can be read.
 *
 * A refusal names the server's own reason; an unanswered write says it could not
 * be confirmed and stays retryable under its own key; a cell whose earlier write
 * is still unresolved says so rather than quietly taking a different intent; an
 * answer that arrived after the feed moved says which value the board is showing.
 *
 * Three surfaces, because a modal changes what "visible" means: a form owns its
 * own error line and keeps its draft, a control pressed inside the deal dialog is
 * answered inside that dialog, and everything else is the toast. Whatever the
 * surface, an operation still unresolved carries its retry with it.
 *
 * The board is redrawn first — deliberately without the `userIsEditing()` guard
 * the feed path uses, because the edit being corrected is the one the person just
 * made: a select left showing a value the server never took is the failure this
 * slice exists to remove, and the row's Retry has to appear with the sentence.
 */
function reportCellWrite(dealId, field, result, { surface = 'toast' } = {}) {
  renderBoardOnly();
  if (surface === 'inline' && result.status !== 'ok') return result;
  const message = fieldWriteMessage(result, cellSubject(dealId, field));
  if (!message) return result;
  const retryCell = result.status === 'unknown' || result.status === 'blocked'
    ? result.pending?.cell || null : null;
  if (surface === 'dialog' && showDealDialogNotice(message, retryCell)) return result;
  showToast(message, {error:result.status !== 'ok'});
  return result;
}

/**
 * The server accepted this operation, and the board has since learned something
 * newer about the same cell.
 *
 * The request's value is NOT written to the row. This cell's base has moved past
 * the one the operation was built on, to an event that operation did not commit —
 * its own event arriving on the feed is recognised and does not come here — so
 * applying the value, and HOLDING it against the next snapshot the way
 * confirmLocalWrite does, would put a stale value on the board and then defend it
 * against the truth.
 *
 * What happens instead is what the board does anywhere else it does not know:
 * mark the record changed, ask for an authoritative read, and say plainly which
 * value is on screen. No event id is invented, nothing is inferred about who
 * wrote what, and the read — not this function — decides what the cell holds.
 */
function reconcileNewerState(dealId, field, result, options = {}) {
  state.changed.add(dealId);
  state.boardSync.requestRefresh('after-write');
  return reportCellWrite(dealId, field, result, options);
}

/**
 * Send an unconfirmed cell change again, exactly as it was sent.
 *
 * Deliberate and person-driven: nothing on a timer re-sends a write nobody asked
 * to re-send. It goes back through the ordinary write path, which is what keeps
 * the key, the base and the value identical.
 */
async function retryCellWrite(cell, trigger = null) {
  const entry = pendingCommand(state.fieldWrites, cell);
  if (!entry) { renderBoardOnly(); return null; }
  const { deal, field, value } = entry.request;
  // The retry is answered on the surface it was asked from: a Retry pressed in
  // the deal dialog is answered in the deal dialog, not under its backdrop.
  const options = { surface: writeSurfaceFor(trigger) };
  if (field === 'operating_state') return patchOperatingState(deal, value, options);
  return patchField(deal, field, value, options);
}

async function patchField(dealId, field, value, options = {}) {
  const result = await sendCellWrite(dealId, field, value);
  if (result.status === 'conflict') return showConflict(result.conflict);
  if (result.status !== 'ok') return reportCellWrite(dealId, field, result, options);
  if (result.superseded) return reconcileNewerState(dealId, field, result, options);
  const deal = confirmLocalWrite(dealId, { [field]: value });
  renderBoardOnly();
  showToast(`${deal?.name || 'Deal'} updated`);
  return result;
}

async function patchOperatingState(dealId, value, options = {}) {
  const result = await sendCellWrite(dealId, 'operating_state', value);
  if (result.status === 'conflict') { showConflict(result.conflict); return result; }
  if (result.status !== 'ok') return reportCellWrite(dealId, 'operating_state', result, options);
  if (result.superseded) {
    // An answer is an answer: the dialog closes exactly as it does on the plain
    // ok path. Only the value is withheld, because the board knows something
    // newer about this record's active-work state than this operation does.
    if ($('#dealDialog').open) $('#dealDialog').close();
    return reconcileNewerState(dealId, 'operating_state', result, options);
  }
  const deal = confirmLocalWrite(dealId, {
    operating_state: value.state,
    parking_reason: value.state === 'parked' ? value.reason : null,
    parking_note: value.state === 'parked' ? value.note || null : null,
    parked_at: value.state === 'parked' ? new Date().toISOString() : null,
    parked_by: value.state === 'parked' ? state.selfActor : null,
  });
  if ($('#dealDialog').open) $('#dealDialog').close();
  render();
  showToast(value.state === 'parked'
    ? `${deal?.name || 'Deal'} parked`
    : `${deal?.name || 'Deal'} restored to active work`);
  return result;
}

function appWrite(operationKey, args, send) {
  state.commands ||= createRetainedCommands({ scope: () => state.selfActor });
  return state.commands.send(operationKey, args, send);
}

function openForm({ context='Deal Room', title, submit='Save', body, onSubmit, operationKey = null, draftKey = null }) {
  const dialog = $('#formDialog');
  $('#dialogContext').textContent = context;
  $('#dialogTitle').textContent = title;
  $('#dialogSubmit').textContent = submit;
  $('#dialogBody').innerHTML = body;
  $('#formError').hidden = true;
  let draft = null;
  if (draftKey) {
    state.formDrafts ||= new Map();
    draft = state.formDrafts.get(draftKey) || { values: {} };
    state.formDrafts.set(draftKey, draft);
    for (const control of $$('#dialogBody [name]')) {
      if (Object.hasOwn(draft.values, control.name)) control.value = draft.values[control.name];
      control.addEventListener('input', () => { draft.values[control.name] = control.value; });
    }
  }
  const renderReview = () => {
    $('#reviewCurrentValues')?.remove();
    if (!draft?.conflict) return;
    $('#formError').textContent = draft.conflict.message;
    $('#formError').hidden = false;
    const review = document.createElement('button');
    review.id = 'reviewCurrentValues'; review.type = 'button'; review.textContent = 'Review current values';
    review.onclick = () => {
      draft.reviewed = draft.conflict.current;
      delete draft.conflict;
      review.remove(); $('#formError').hidden = true;
    };
    $('#formError').after(review);
  };
  renderReview();
  const retained = () => operationKey && state.commands?.pending(operationKey);
  const renderPending = () => {
    const request = retained();
    if (!request) {
      if (operationKey) for (const control of $$('#dialogBody input, #dialogBody textarea, #dialogBody select')) control.disabled = false;
      $('#dialogSubmit').textContent = submit;
      return;
    }
    for (const control of $$('#dialogBody input, #dialogBody textarea, #dialogBody select')) {
      if (control.name && Object.hasOwn(request, control.name)) control.value = request[control.name] ?? '';
      control.disabled = true;
    }
    $('#dialogSubmit').textContent = 'Check outcome';
  };
  renderPending();
  $('#dialogForm').onsubmit = async (event) => {
    event.preventDefault();
    if (draft?.conflict) { renderReview(); return; }
    if (draft) draft.values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const button = $('#dialogSubmit');
    button.disabled = true;
    $('#formError').hidden = true;
    try {
      if (await onSubmit(new FormData(event.currentTarget)) !== false) {
        if (draftKey) state.formDrafts.delete(draftKey);
        dialog.close();
      }
    } catch (error) {
      const detail = retained() ? 'Outcome unknown. Check outcome replays the original request. Keep this tab open until it is confirmed.'
        : error.payload?.hint || error.payload?.error || error.message;
      $('#formError').textContent = detail;
      $('#formError').hidden = false;
      if (draft && error.replacementConflict) { draft.conflict = error.replacementConflict; renderReview(); }
      renderPending();
    } finally { button.disabled = false; }
  };
  // One dialog element serves every form, so a form raised FROM a form — the
  // conflict chooser opened while the park form is still up — is a content
  // swap, not a second opening. showModal() on an already-open dialog throws,
  // and that exception used to land on the error line the submit handler had
  // just cleared: the person got the conflict chooser with a browser message
  // above it. The body and the submit handler are already replaced above; this
  // only has to make the dialog visible when it is not.
  if (!dialog.open) dialog.showModal();
  // eslint-disable-next-line no-restricted-syntax -- 1 0-delay focus callback per opened dialog; focuses its first input without any read.
  setTimeout(() => $('input,textarea,select', dialog)?.focus(), 0);
}

function reviewedReplacementVersion(reviewed, current, fields, draftKey) {
  const version = record => record?.base_version ?? record?.version ?? record?.client_version;
  const expected = version(state.formDrafts?.get(draftKey)?.reviewed || reviewed), fresh = version(current);
  if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(fresh) || expected < 1 || fresh < 1)
    throw new Error('The current version is unavailable. Reopen this record before saving.');
  if (fresh !== expected) {
    const detail = fields.map(field => `${field.replaceAll('_', ' ')}: ${current[field] ?? 'Not recorded'}`).join('; ');
    const message = `This record changed. Current ${detail}. Your draft is kept. Review current values before saving.`;
    throw Object.assign(new Error(message), { payload: { error: 'version_conflict', hint: message }, replacementConflict: { current, message } });
  }
  return fresh;
}

function nextStepForm(dealId) {
  const deal = state.deals.get(dealId);
  const pending = state.nextStepRequests.get(dealId);
  const draftKey = `next-step:${dealId}`;
  openForm({ draftKey, title:`Next step — ${deal.name}`, submit:pending ? 'Check outcome' : 'Set next step', body:`
    <div class="field"><label for="stepText">What happens next?</label><textarea id="stepText" name="text" required${pending ? ' disabled' : ''}>${esc(pending?.text ?? deal.next_step ?? '')}</textarea><small>This becomes a real next action in today’s triage; the prior step stays in history.</small></div>
    <div class="field"><label for="stepDate">When?</label><input id="stepDate" name="next_date" type="date" value="${esc(pending?.next_date ?? deal.next_date ?? '')}"${pending ? ' disabled' : ''}></div>`,
    onSubmit:async (data) => {
      if (state.nextStepInFlight.has(dealId)) throw new Error('Next step is still being sent. Wait for the server to answer.');
      const checking = state.nextStepRequests.has(dealId);
      let request = state.nextStepRequests.get(dealId);
      state.nextStepInFlight.add(dealId);
      try {
        if (!request) {
          const current = (await state.client.getDeal(dealId))?.deal;
          if (current?.id !== dealId) throw new Error('The current record could not be verified. No write was sent.');
          state.deals.set(dealId, { ...deal, ...current });
          const base_version = reviewedReplacementVersion(deal, current, ['next_step', 'next_date'], draftKey);
          request = { deal:dealId, text:String(data.get('text') || '').trim(), next_date:data.get('next_date') || null,
            base_version, idempotency_key:uuidv4() };
          state.nextStepRequests.set(dealId, request);
        }
        await state.client.setNextStep(request);
      } catch (error) {
        if (!request) throw error;
        const outcome = classifyCommandOutcome({ error });
        if (error.pendingRequest || error.code === 'session_changed' ||
          (outcome.status === 'unknown' && (checking || outcome.reason !== 'offline')) || (checking && [401,403].includes(error.status))) {
          // The write may have landed. Keep its text, date and key intact until
          // CARR answers a deliberate replay of that same request.
          $('#stepText').value = request.text;
          $('#stepDate').value = request.next_date || '';
          $('#stepText').disabled = true;
          $('#stepDate').disabled = true;
          $('#dialogSubmit').textContent = 'Check outcome';
          throw new Error(commandMessage(outcome, 'Next step'));
        }
        state.nextStepRequests.delete(dealId); // Definitive refusal or a local offline no-send.
        $('#stepText').disabled = false;
        $('#stepDate').disabled = false;
        $('#dialogSubmit').textContent = 'Set next step';
        throw error;
      } finally {
        state.nextStepInFlight.delete(dealId);
      }
      state.nextStepRequests.delete(dealId);
      // A replay can confirm an older action after a partner made a newer one.
      // Read the current board instead of painting the replay over it.
      const current = checking ? state.deals.get(dealId) : confirmLocalWrite(dealId, { next_step:request.text, next_date:request.next_date });
      if (checking) state.boardSync.requestRefresh('after-write');
      showToast(`Next step confirmed on ${current?.name || deal.name}`); renderBoardOnly();
    } });
}

function parkDealForm(dealId) {
  const deal = state.deals.get(dealId);
  openForm({ context:'Active work', title:`Park — ${deal.name}`, submit:'Park record', body:`
    <p class="form-guidance">Parking removes this record from active counts, focus lists, and weekly agendas. Its Salesforce link, phase, history, and participants stay intact.</p>
    <div class="field"><label for="parkingReason">Why is this not active work?</label><select id="parkingReason" name="reason" required>
      <option value="prospect_never_active">Prospect never became active work</option>
      <option value="client_paused">Client paused activity</option>
      <option value="other">Other / not active right now</option>
    </select></div>
    <div class="field"><label for="parkingNote">Context (optional)</label><textarea id="parkingNote" name="note" maxlength="500" placeholder="What would help when this record becomes active again?"></textarea></div>`,
    onSubmit:async (data) => {
      const result = await patchOperatingState(dealId, {
        state:'parked', reason:String(data.get('reason')), note:String(data.get('note') || '').trim() || null,
      }, { surface:'inline' });
      // Only a parked record closes this form. An answer that did not park it —
      // refused, or never confirmed — keeps the reason and the note the partner
      // typed, and says why on the form's own error line instead of in a toast
      // over a dialog that has already thrown the draft away.
      if (result.status !== 'ok') throw new Error(result.message || 'This record was not parked.');
    } });
}

function nationalResearchFields() {
  return `<fieldset><legend>Research for the new organization or sub-client</legend>
    <p>Review sources before creating this record. Link the source you checked for each field, including a source documenting unavailable information. A source may support several fields.</p>
    ${[['name','Name'],['company','Company'],['phone','Phone'],['specialty','Specialty'],['market','Market']].map(([field,label]) => `<div class="field"><label for="research_${field}">${label} source (HTTPS URL)</label><input id="research_${field}" name="research_${field}" type="url" required></div>`).join('')}
    <div class="field"><label for="researchObserved">When did you review these sources?</label><input id="researchObserved" name="research_observed_at" type="datetime-local" required><small>Enter the observation time in your local time zone.</small></div>
    <div class="field"><label for="researchDiscrepancies">Discrepancies found (optional)</label><textarea id="researchDiscrepancies" name="research_discrepancies" placeholder="One discrepancy per line; leave blank if none."></textarea></div></fieldset>`;
}

// Producer tools.js@804a3794: typed HTTPS sources and non-future observations,
// with source indexes for all five required fields. Never invent research.
function nationalResearchEvidence(data) {
  const observed = new Date(String(data.get('research_observed_at') || ''));
  if (!Number.isFinite(observed.getTime()) || observed.getTime() > Date.now() + 300000)
    throw new Error('Enter when you reviewed the research sources; the time cannot be in the future.');
  const sources = [], field_evidence = {};
  for (const field of ['name','company','phone','specialty','market']) {
    let url;
    try { url = new URL(String(data.get(`research_${field}`) || '').trim()); } catch { /* actionable error below */ }
    if (url?.protocol !== 'https:') throw new Error(`Research evidence needs an HTTPS source for ${field}. Review and link that source before creating the record.`);
    let index = sources.findIndex(source => source.url === url.href);
    if (index < 0) { index = sources.length; sources.push({url:url.href, observed_at:observed.toISOString()}); }
    field_evidence[field] = [index];
  }
  return {sources, field_evidence, discrepancies:String(data.get('research_discrepancies') || '').split('\n').map(line => line.trim()).filter(Boolean)};
}

function nationalCreationForm({operationKey, context, title, submit, body, request, send, receiptId, success, accountId}) {
  const actor = state.selfActor;
  const key = `${actor}:${operationKey}`;
  const held = state.nationalCreations[key];
  let confirmation = state.nationalConfirmations[key];
  const review = () => `<div id="nationalCandidates"><p>${esc(confirmation.hint || 'An organization with this name already exists. Review it before creating a separate brand.')}</p>
    <ul>${confirmation.candidates.map(candidate => `<li>${esc(candidate.name)} (${esc(candidate.id)})</li>`).join('')}</ul>
    <p>Cancel to use the existing client. Continue only if this is a genuinely separate brand.</p>
    <div class="field"><label><input type="checkbox" name="confirm_separate" required${state.nationalCreations[key]?.request.force_new ? ' checked disabled' : ''}> I reviewed these candidates and confirm this is a separate brand.</label></div>
    <button type="button" id="nationalEditDetails"${state.nationalCreations[key] ? ' disabled' : ''}>Edit account details</button></div>`;
  const wireReview = () => {
    if (!$('#nationalEditDetails')) return;
    $('#nationalEditDetails').onclick = () => {
      delete state.nationalConfirmations[key];
      confirmation = null;
      $('#nationalCandidates').remove();
      $('#nationalCreationFields').disabled = false;
      $('#dialogSubmit').textContent = submit;
      $('#formError').hidden = true;
    };
  };
  openForm({context, title, submit:held ? 'Check creation outcome' : confirmation ? 'Create separate brand' : submit,
    body:`${held ? `<p>Check creation outcome for ${esc(held.request.name || held.request.deal_name)} before starting another record.</p>` : ''}<fieldset id="nationalCreationFields"${held || confirmation ? ' disabled' : ''}>${body}</fieldset>${confirmation ? review() : ''}`,
    onSubmit:async data => {
      if (state.selfActor !== actor || accountId && account()?.account_client_id !== accountId)
        throw new Error('The account or signed-in partner changed. Reopen this form in its original account and session.');
      const pending = state.nationalCreations[key];
      if (!pending && confirmation && data.get('confirm_separate') !== 'on')
        throw new Error('Review the existing candidates and confirm a separate brand before creating it.');
      const args = pending?.request || (confirmation ? {...confirmation.request,force_new:true} : request(data));
      const started = beginCommand(state.nationalCreations, {operationKey:key,args,newKey:uuidv4});
      if (!started.started) throw new Error('Creation is still being sent. Wait for the server to answer.');
      state.nationalCreations = started.state;
      $('#nationalCreationFields').disabled = true;
      if ($('#nationalEditDetails')) $('#nationalEditDetails').disabled = true;
      try {
        const result = await send(started.request);
        if (result?.needs_confirm === true && result.ok !== false && !result.error && !result.conflict && receiptId === 'account_client_id' && !started.request.force_new &&
            Array.isArray(result.candidates) && result.candidates.length && result.candidates.every(candidate => typeof candidate.id === 'string' && typeof candidate.name === 'string')) {
          state.nationalCreations = settleCommand(state.nationalCreations,key,{status:'conflict'});
          confirmation = {request:started.request,candidates:result.candidates,hint:result.hint};
          state.nationalConfirmations[key] = confirmation;
          $('#nationalCandidates')?.remove();
          $('#dialogBody').insertAdjacentHTML('beforeend',review());
          wireReview();
          $('#dialogSubmit').textContent = 'Create separate brand';
          return false;
        }
        if (result?.ok !== true || result.needs_confirm || result.error || result.conflict ||
            typeof result[receiptId] !== 'string' || !result[receiptId].trim() ||
            accountId && result.account_client_id !== accountId) {
          if (result?.ok === false || result?.error) throw Object.assign(new Error(result.hint || 'Creation was refused. Review the fields before trying again.'), {payload:{error:result.error || 'creation_refused',hint:result.hint}});
          throw new Error('Creation could not be confirmed. Check creation outcome before starting another record.');
        }
      } catch (error) {
        const classified = classifyCommandOutcome({error});
        const outcome = classified.reason === 'offline' && pending ? pending : classified;
        const unknown = outcome.status === 'unknown' && outcome.reason !== 'offline';
        state.nationalCreations = settleCommand(state.nationalCreations,key,unknown ? outcome : {status:'refused'});
        $('#nationalCreationFields').disabled = unknown || Boolean(confirmation);
        if ($('#nationalEditDetails')) $('#nationalEditDetails').disabled = unknown;
        const confirm = $('[name="confirm_separate"]');
        if (confirm) {
          confirm.disabled = unknown;
          if (!unknown) confirm.checked = false;
        }
        $('#dialogSubmit').textContent = unknown ? 'Check creation outcome' : confirmation ? 'Create separate brand' : submit;
        if (unknown) throw new Error(commandMessage(outcome,'Creation'));
        if (error.payload?.error === 'research_evidence_required') throw new Error('Research evidence is required: the sub-client name did not match an existing client under this account. Choose New sub-client and provide reviewed sources.');
        throw error;
      }
      state.nationalCreations = settleCommand(state.nationalCreations,key,{status:'ok'});
      delete state.nationalConfirmations[key];
      // Creation is confirmed independently of whether the subsequent read works.
      showToast(success);
      try { await loadHome(); } catch { showToast('Creation confirmed. The board could not refresh; reload to see the current records.'); }
    }});
  wireReview();
  const retained = held?.request || confirmation?.request;
  if (retained) {
    const values = {...retained,client_mode:retained.research_evidence ? 'new' : 'existing'};
    const evidence = retained.research_evidence;
    if (evidence) {
      for (const [field,indexes] of Object.entries(evidence.field_evidence)) values[`research_${field}`] = evidence.sources[indexes[0]].url;
      const observed = new Date(evidence.sources[0].observed_at);
      values.research_observed_at = new Date(observed.getTime() - observed.getTimezoneOffset()*60000).toISOString().slice(0,16);
      values.research_discrepancies = evidence.discrepancies.join('\n');
    }
    for (const [name,value] of Object.entries(values)) {
      const input = $(`#nationalCreationFields [name="${name}"]`);
      if (input) input.value = value;
    }
  }
}

function marketAgentForm(dealId) {
  const operationKey = `market-agent:${dealId}`;
  const deal = state.deals.get(dealId);
  openForm({ operationKey, draftKey:operationKey, title:`Market assignment — ${deal.name}`, submit:'Save assignment', body:`
    <div class="field"><label for="agentName">Assigned local agent</label><input id="agentName" name="agent_name" required value="${esc(deal.market_agent || '')}" placeholder="Agent’s full name"></div>
    <div class="field"><label for="agentMarket">Market</label><input id="agentMarket" name="market" value="${esc(deal.market || '')}" placeholder="City, state"></div>`,
    onSubmit:async (data) => {
      let request = state.commands?.pending(operationKey);
      if (!request) {
        const current = (await state.client.getDeal(dealId))?.deal;
        if (current?.id !== dealId) throw new Error('The current record could not be verified. No write was sent.');
        state.deals.set(dealId, { ...deal, ...current });
        request = { deal:dealId, agent_name:data.get('agent_name'),
          ...(String(data.get('market') || '').trim() ? { market:String(data.get('market')).trim() } : {}), source:'partner stated in Deal Room',
          base_version: reviewedReplacementVersion(deal, current, ['market_agent', 'market'], operationKey) };
      }
      await appWrite(operationKey, request, async args => {
        const result = await state.client.setMarketAgent(args);
        if (result?.ok !== true || result.error || result.needs_confirm || result.deal_id !== dealId)
          throw Object.assign(new Error('Market assignment receipt is incomplete. Check outcome before changing it.'), { code:'unknown_outcome' });
        return result;
      });
      await loadHome(); showToast(`Market agent confirmed on ${deal.name}`);
    } });
}

function addTeamDealForm() {
  const pending = state.pendingDealCreation?.request;
  openForm({ title:'Add deal', submit:pending ? 'Check creation outcome' : 'Create deal', body:pending ? `
    <div class="field"><b>${esc(pending.name)}</b><p>Client: ${esc(pending.client)}</p><p>${esc(pending.deal_type || 'other')} · ${esc(pending.phase || 'On Deck')} · ${esc(pending.market || '')} · ${esc(pending.segment || '')}</p><small>Check creation outcome continues this saved deal.</small></div>` : `
    <div class="field"><label for="clientRef">Existing client</label><input id="clientRef" name="client" required placeholder="C-127 or exact client name"><small>A deal always belongs to a client. This prevents free-floating or duplicate records.</small></div>
    <div class="field"><label for="dealName">Record name</label><input id="dealName" name="name" required></div>
    <div class="field-row"><div class="field"><label for="dealType">Type</label><select id="dealType" name="deal_type"><option value="startup">Startup</option><option value="relocation">Relocation</option><option value="additional_office">Additional office</option><option value="renewal">Renewal</option><option value="expansion">Expansion</option><option value="purchase">Purchase</option><option value="other">Other</option></select></div>
    <div class="field"><label for="dealPhase">Phase</label><select id="dealPhase" name="phase">${phaseOptions('On Deck')}</select></div></div>
    <div class="field-row"><div class="field"><label for="dealMarket">Market</label><input id="dealMarket" name="market"></div><div class="field"><label for="dealSegment">Healthcare vertical</label><input id="dealSegment" name="segment" placeholder="Dental, Vet, DPC…"></div></div>`,
    onSubmit:async (data) => {
      const args = Object.fromEntries(data.entries());
      const signature = JSON.stringify(args);
      if (!pending && state.pendingDealCreation && state.pendingDealCreation.signature !== signature) throw new Error('Reopen Add deal to check the retained creation before changing its fields.');
      state.pendingDealCreation ||= { signature, request: { ...args, lane:'territory', idempotency_key:uuidv4() } };
      const operation = state.pendingDealCreation;
      try { await state.client.createDeal(operation.request); }
      catch (error) {
        if (error.creationRefused && state.pendingDealCreation === operation) state.pendingDealCreation = null;
        throw error;
      }
      await loadHome(); showToast('Deal created');
      state.pendingDealCreation = null;
    } });
}

function addAccountForm() {
  nationalCreationForm({ operationKey:'account', context:'National accounts', title:'Add national account', submit:'Create account', body:`
    <div class="field"><label for="accountName">Brand / organization</label><input id="accountName" name="name" required><small>Creates one parent account. Market transactions will live under their own sub-clients.</small></div>
    <div class="field-row"><div class="field"><label for="accountOwner">Account owner</label><select id="accountOwner" name="owner"><option value="${esc(state.selfActor)}">${esc(actorName(state.selfActor))}</option><option value="${state.selfActor === 'joe' ? 'dell' : 'joe'}">${esc(actorName(state.selfActor === 'joe' ? 'dell' : 'joe'))}</option></select></div>
    <div class="field"><label for="accountVertical">Healthcare vertical</label><input id="accountVertical" name="vertical"></div></div>${nationalResearchFields()}`,
    request:data => ({name:String(data.get('name') || '').trim(),owner:String(data.get('owner')),vertical:String(data.get('vertical') || '').trim(),research_evidence:nationalResearchEvidence(data)}),
    send:args => state.client.createNationalAccount(args), receiptId:'account_client_id', success:'National account created' });
}

function addMarketDealForm() {
  const selected = account();
  nationalCreationForm({ operationKey:`market:${selected.account_client_id}`, accountId:selected.account_client_id, context:selected.account_name, title:'Add market transaction', submit:'Create market deal', body:`
    <div class="field"><label for="marketClientMode">Sub-client</label><select id="marketClientMode" name="client_mode"><option value="new">New sub-client</option><option value="existing">Existing researched sub-client</option></select></div>
    <div class="field"><label for="marketClient">Franchisee / local client</label><input id="marketClient" name="client_name" required><small>For an existing researched sub-client, enter its exact name under ${esc(selected.account_name)}. An unmatched name requires new research.</small></div>
    <div class="field"><label for="marketDealName">Deal name</label><input id="marketDealName" name="deal_name" required></div>
    <div class="field-row"><div class="field"><label for="marketCity">Market</label><input id="marketCity" name="market" required placeholder="City"></div><div class="field"><label for="marketState">State</label><input id="marketState" name="state" maxlength="2"></div></div>
    <div class="field-row"><div class="field"><label for="marketAgent">Assigned agent</label><input id="marketAgent" name="agent_name" placeholder="Leave blank if unknown"></div><div class="field"><label for="marketSegment">Healthcare vertical</label><input id="marketSegment" name="segment"></div></div>
    <div id="marketResearch">${nationalResearchFields()}</div>`,
    request:data => ({account_client_id:selected.account_client_id,
      ...Object.fromEntries(['client_name','deal_name','market','state','agent_name','segment'].map(field => [field,String(data.get(field) || '').trim()])),
      deal_type:'startup',phase:'pending',...(data.get('client_mode') === 'existing' ? {} : {research_evidence:nationalResearchEvidence(data)})}),
    send:args => state.client.createNationalMarketDeal(args), receiptId:'deal_id', success:`Market deal added to ${selected.account_name}` });
  const updateResearchFields = () => {
    const existing = $('#marketClientMode').value === 'existing';
    $('#marketResearch').hidden = existing;
    $('#marketResearch fieldset').disabled = existing;
  };
  $('#marketClientMode').onchange = updateResearchFields;
  updateResearchFields();
}

function accountOwnerForm() {
  const selected = account();
  const operationKey = `national-owner:${selected.account_client_id}`;
  openForm({ operationKey, draftKey:operationKey, context:selected.account_name, title:'Change account owner', submit:'Save owner', body:`
    <div class="field"><label for="newAccountOwner">Accountable partner</label><select id="newAccountOwner" name="owner"><option value="joe"${selected.account_owner === 'joe' ? ' selected' : ''}>Joe</option><option value="dell"${selected.account_owner === 'dell' ? ' selected' : ''}>Dell</option></select><small>This changes portfolio accountability only. Individual market-deal owners stay untouched.</small></div>`,
    onSubmit:async (data) => {
      let request = state.commands?.pending(operationKey);
      if (!request) {
        const board = await state.client.getBoard({ workspace: 'national_account' });
        if (board.actor !== state.selfActor) throw new Error('Session changed. Reopen this account before saving.');
        const current = board.accounts?.find(row => row.account_client_id === selected.account_client_id);
        if (!current) throw new Error('The current account could not be verified. No write was sent.');
        state.accounts = board.accounts;
        request = { account_client_id:selected.account_client_id, owner:data.get('owner'),
          base_version: reviewedReplacementVersion(selected, current, ['account_owner'], operationKey) };
      }
      await appWrite(operationKey, request, args => state.client.setNationalAccountOwner(args));
      await loadHome(); showToast(`${selected.account_name} owner updated`);
    } });
}

function showConflict(conflict) {
  // Keep the request whole after an unanswered send. A second click must ask
  // about the same choice under the same key, never create a second decision.
  let request = null;
  const choice = (side, caption) => `<div class="field"><label><input type="radio" name="winner" value="${side}" required> <strong>${caption}</strong> · ${esc(actorName(conflict[side].actor))}: ${esc(readableValue(conflict.field, conflict[side].value, { actorLabel: actorName }))}</label></div>`;
  openForm({ context:'Two edits crossed', title:`Choose the ${fieldLabel(conflict.field)} value`, submit:'Keep selected value', body:`
    <p>Review both values, then choose one. Both edits remain in the deal history.</p>
    ${choice('a', 'Previously recorded value')} ${choice('b', 'Your proposed value')}`,
    onSubmit:async (data) => {
      if (!request) request = { conflict_id:conflict.conflict_id, winner:data.get('winner'), idempotency_key:uuidv4() };
      // Once a resolution may have reached CARR, changing sides would reuse a
      // key with different arguments. Hold the selected side for reconciliation.
      for (const radio of $$('#dialogBody input[name="winner"]')) radio.disabled = true;
      try {
        await state.client.resolveConflict(request);
        await loadHome();
        showToast('Conflict resolved with both values preserved in history');
      } catch (error) {
        const outcome = classifyCommandOutcome({ error });
        if (outcome.status !== 'unknown' || outcome.reason === 'offline') {
          request = null; // The server refused, or the client never sent it.
          for (const radio of $$('#dialogBody input[name="winner"]')) radio.disabled = false;
        } else {
          $('#dialogSubmit').textContent = 'Check outcome';
        }
        throw error;
      }
    } });
}

async function openDeal(dealId) {
  location.assign(`/deals?deal=${encodeURIComponent(dealId)}`);
}

function agendaDeals() {
  let deals = [...state.deals.values()].filter((deal) => (deal.operating_state || 'active') === 'active');
  if (state.workspace === 'team') deals = deals.filter((deal) => deal.workspace_kind === 'team');
  else if (state.accountId) deals = deals.filter((deal) => deal.account_client_id === state.accountId);
  else deals = [];
  return deals.sort((a,b) => priority(b) - priority(a) || a.name.localeCompare(b.name));
}

async function startAgenda() {
  if (state.review) { $('#agendaPanel').hidden = false; return true; }
  const deals = agendaDeals();
  if (!deals.length) return showToast('No active work in this agenda');
  const title = state.workspace === 'team' ? 'Deals' : account()?.account_name || 'National account';
  return runScreenAction('agenda-start',{workspace_kind:state.workspace,
    ...(state.accountId ? {account_client_id:state.accountId} : {})},'startReview','Start agenda',async result => {
    state.review = {sessionId:result.session_id,deals,index:0,reviewed:0,skipped:0,title};
    $('#agendaPanel').hidden = false; renderAgenda();
  });
}

function renderAgenda() {
  const review = state.review;
  if (!review) return;
  // The agenda captured its set and its order when it started, and both are
  // kept: a record does not join or leave the list mid-review. The VALUES are
  // resolved now, because a snapshot has replaced every row object since —
  // possibly several times, on the periodic read alone — and the captured copy
  // would show the partner the phase and next step as they were at the start.
  const captured = review.deals[review.index];
  const deal = resolveCurrentRow(captured, state.deals);
  $('#agendaTitle').textContent = review.title;
  $('#agendaProgress').textContent = `${Math.min(review.index + 1,review.deals.length)} of ${review.deals.length}`;
  $('#agendaMeter').max = review.deals.length;
  $('#agendaMeter').value = review.index;
  if (!deal) return finishAgenda();
  $('#agendaCard').innerHTML = `<article class="agenda-deal"><h3>${esc(deal.name)}</h3><p class="agenda-context">${esc(deal.market || deal.client_name || '')}</p>
    <span class="agenda-reason">${esc(reasonFor(deal))}</span>
    <div class="agenda-fact"><label>Phase</label><p>${esc(phaseLabel(deal.phase))}</p></div>
    <div class="agenda-fact"><label>Next step</label><p>${esc(deal.next_step || 'Not set')}</p></div>
    <div class="agenda-fact"><label>Next date</label><p>${esc(dateLabel(deal.next_date))}</p></div>
    ${deal.workspace_kind === 'national_account' ? `<div class="agenda-fact"><label>Assigned market agent</label><p>${esc(deal.market_agent || 'Unassigned')}</p></div>` : ''}
    <button type="button" class="secondary" data-open-deal="${esc(deal.id)}">Open full record</button>
    <button type="button" class="secondary" data-agenda-step="${esc(deal.id)}">Set next step</button></article>`;
}

async function advanceAgenda(disposition) {
  const review = state.review;
  const deal = review?.deals[review.index];
  if (!review || !deal || review.advancing) return;
  review.advancing = true;
  try {
    return await runScreenAction(`agenda:${review.sessionId}`,{session_id:review.sessionId,deal:deal.id,disposition},'reviewDeal','Review record',async () => {
    if (state.review !== review) return;
    review[disposition === 'reviewed' ? 'reviewed' : 'skipped'] += 1;
    review.index += 1;
    renderAgenda();
    });
  } finally { review.advancing = false; }
}

async function finishAgenda(status = 'completed') {
  if (!state.review) return;
  const review = state.review;
  return runScreenAction(`agenda:${review.sessionId}`,{session_id:review.sessionId,status},'endReview','Finish agenda',async result => {
  state.review = null;
  $('#agendaPanel').hidden = true;
  await loadHome();
  showToast(status === 'completed' ? `Agenda finished · ${result.reviewed ?? review.reviewed} records reviewed` : 'Agenda closed without changing the review clock');
  });
}

function wireEvents() {
  document.addEventListener('click', async (event) => {
    try {
    const workspace = event.target.closest('[data-workspace]');
    if (workspace) {
      state.workspace = workspace.dataset.workspace;
      state.accountId = null; state.filter = 'active'; state.deepLinkMine = false; state.query = ''; $('#search').value = '';
      history.pushState({ dealView: state.workspace }, '', state.workspace === 'team' ? '/deals' : '/deals?view=national');
      render(); return;
    }
    if (event.target.closest('[data-clear-search]')) {
      state.query = ''; $('#search').value = '';
      render();
      const target = state.accountId ? $('#accountContextName')
        : $('#accountGrid:not([hidden]) [data-account]') || $('#rows .deal-link') || $('#workspaceTitle');
      target.focus({ preventScroll: true });
      return;
    }
    const accountButton = event.target.closest('[data-account]');
    if (accountButton) { state.workspace = 'national_account'; state.accountId = accountButton.dataset.account; render(); return; }
    const retryWrite = event.target.closest('[data-retry-write]');
    // eslint-disable-next-line no-restricted-syntax -- 1 cell-write reconciliation per retry-button click, reusing the retained idempotency key.
    if (retryWrite) { await retryCellWrite(retryWrite.dataset.retryWrite, retryWrite); return; }
    const operating = event.target.closest('[data-operating-state]');
    if (operating) {
      const dealId = operating.dataset.deal;
      // Restore from the open deal dialog is answered inside that dialog: the
      // modal's backdrop dims and covers a toast, and the row's Retry with it.
      if (operating.dataset.operatingState === 'active') await patchOperatingState(dealId, { state:'active' }, { surface:writeSurfaceFor(operating) });
      else { if ($('#dealDialog').open) $('#dealDialog').close(); parkDealForm(dealId); }
      return;
    }
    const open = event.target.closest('[data-open-deal]'); if (open) { await openDeal(open.dataset.openDeal); return; }
    const attention = event.target.closest('[data-attention]'); if (attention) { const deal=state.deals.get(attention.dataset.attention); await patchField(deal.id,'attention',!deal.attention); return; }
    const step = event.target.closest('[data-next-step],[data-agenda-step]'); if (step) { nextStepForm(step.dataset.nextStep || step.dataset.agendaStep); return; }
    const agent = event.target.closest('[data-market-agent]'); if (agent) { marketAgentForm(agent.dataset.marketAgent); return; }
    const filter = event.target.closest('[data-filter]'); if (filter) { state.filter=filter.dataset.filter; state.deepLinkMine = false; $$('.filter').forEach((b)=>b.classList.toggle('on',b===filter)); renderBoardOnly(); return; }
    if (event.target.closest('[data-close-deal]')) { $('#dealDialog').close(); return; }
    const undoButton = event.target.closest('[data-undo]'); if (undoButton) { await runUndo(undoButton.dataset.undo, undoButton); return; }
    const retry = event.target.closest('[data-screen-retry]'); if (retry) { await screenActions.get(retry.dataset.screenRetry)?.run(); return; }
    if (event.target.closest('[data-confirms-retry]')) { await loadConfirms(); return; }
    const confirm = event.target.closest('[data-confirm]'); if (confirm) {
      const proposal_id=confirm.closest('[data-proposal]').dataset.proposal, accept=confirm.dataset.confirm==='yes';
      await runScreenAction(`confirm:${proposal_id}`,{proposal_id,accept},'resolveConfirm','Suggestion',async () => {
        state.confirms=state.confirms.filter(p=>p.id!==proposal_id); renderConfirms();
        if(accept) await loadHome(); showToast(accept?'Suggestion confirmed':'Suggestion skipped');
      }); return;
    }
    if (state.callModeUi && await state.callModeUi.handleClick(event.target)) return;
    if (event.target.closest('[data-dialog-cancel]')) { $('#formDialog').close(); return; }
    } catch (error) {
      showToast(error.pendingRequest ? 'Outcome unknown. Repeat the same action to check its original request.' : error.message);
    }
  });

  document.addEventListener('change', async (event) => {
    if (event.target.matches('[data-phase]')) await patchField(event.target.dataset.phase,'phase',event.target.value);
    if (event.target.matches('[data-owner]')) await patchField(event.target.dataset.owner,'owner',event.target.value || null);
  });

  $('#search').addEventListener('input', (event) => { state.query=event.target.value.trim(); render(); });
  $('#accountBack').onclick = () => {
    const accountId = state.accountId;
    state.accountId = null;
    state.query = ''; $('#search').value = '';
    render();
    if (accountId) $(`[data-account="${CSS.escape(accountId)}"]`)?.focus({ preventScroll: true });
  };
  const openAddForm = () => state.workspace === 'team' ? addTeamDealForm() : state.accountId ? addMarketDealForm() : addAccountForm();
  $('#stickyAddButton').onclick = openAddForm;
  $('#receiptsJump').onclick = goToReceipts;
  $('#ownerButton').onclick = accountOwnerForm;
  const agendaAction = work => () => Promise.resolve().then(work).catch(error => showToast(
    error.pendingRequest ? 'Outcome unknown. Repeat the same agenda action to check its original request.' : error.message));
  $('#agendaButton').onclick = agendaAction(startAgenda);
  $('#callModeButton').onclick = () => state.callModeUi.open();
  $('#callModeStop').onclick = () => state.callModeUi.stop();
  $('#postCallRefresh').onclick = () => state.callModeUi.refreshPostCall();
  $('#agendaReviewed').onclick = agendaAction(() => advanceAgenda('reviewed'));
  $('#agendaSkip').onclick = agendaAction(() => advanceAgenda('skipped'));
  $('#agendaEnd').onclick = agendaAction(() => finishAgenda('completed'));
  $('#agendaClose').onclick = agendaAction(() => finishAgenda('abandoned'));

  // Coming back is not the same as being current: BOTH reads start again from
  // scratch, and `force` supersedes whatever was left hanging when the
  // connection went away rather than queueing behind it. Without the forced
  // poll, a feed read that never answers would leave every later tick skipping
  // as "already polling" for the rest of the session.
  // eslint-disable-next-line no-restricted-syntax -- Online listener updates the offline banner and board-sync state; subsequent refreshes use the shared capped poller (0 reads in this listener).
  window.addEventListener('online', () => {
    $('#offlineBanner').hidden = true;
    state.boardSync.setOnline(true);
  });
  window.addEventListener('offline', () => {
    $('#offlineBanner').hidden = false;
    state.boardSync.setOnline(false);
  });
  document.addEventListener('keydown', (event) => { if (event.key==='/' && !event.target.matches('input,textarea,select')) { event.preventDefault(); $('#search').focus(); } });
}

async function boot() {
  // Theme and Color Assist live on <html>, set before paint by js/theme-boot.js
  // and kept current by the shell; this page reads them through css/tokens.css.
  const bootConfig = resolveDealroomBoot(location);
  const params = new URLSearchParams(location.search);
  if (params.get('workspace') === 'team') state.workspace = 'team';
  if (params.get('view') === 'national') state.workspace = 'national_account';
  window.addEventListener('popstate', () => {
    state.workspace = new URLSearchParams(location.search).get('view') === 'national' ? 'national_account' : 'team';
    state.accountId = null;
    render();
  });
  if (params.get('filter') === 'flagged') { state.filter = 'flagged'; state.deepLinkMine = params.get('owner') === 'me'; }
  const identity = deploymentIdentity(bootConfig.mode);
  state.mode = bootConfig.mode;
  const badge = $('#deploymentBadge');
  badge.textContent = identity.label;
  badge.dataset.mode = identity.mode;
  badge.title = identity.detail;
  badge.setAttribute('aria-label', identity.detail);
  state.client = await createClient(bootConfig.mode, bootConfig.options);
  state.boardSync = createBoardSync({
    readBoard: () => state.client.getBoard({ workspace:'all' }),
    readChanges: (cursor) => state.client.getChanges(cursor),
    // Only a snapshot that is still current reaches this callback, and it
    // already carries any value a confirmed local write is holding.
    applyBoard: (board) => { applyBoardSnapshot(board); if (!userIsEditing()) renderPreservingFocus(); },
    onStatus: setSync,
  });
  installCallMode();
  wireEvents();
  await loadHome();
  const linkedDeal = params.get('deal');
  // A tick that arrives while the last poll is still open is dropped by the
  // coordinator rather than run alongside it, so a slow answer cannot land
  // after a newer one. Both clocks run once a minute (MIN_POLL_MS) and sleep
  // while the tab is hidden or idle.
  mountVisibilityPoll({ lifecycle: true, poll: () => {
    return pollOnce().catch((error) => { console.error('Deal Room poll failed to render', error); return false; });
  } });
  // The backstop for what the feed cannot promise. A change whose commit landed
  // out of order with its recorded time can slip past the cursor, and a board
  // that only re-reads on news would then hold that wrong value for as long as
  // the page stayed open. This asks anyway. It coalesces with the feed-driven
  // and post-write refreshes through the same single-read queue, so it adds one
  // read per interval at most and none while another is already running. It
  // bounds how long the board goes without asking, never how old a value is.
  mountVisibilityPoll({ lifecycle: true, poll: () => {
    return state.boardSync.requestRefresh('periodic');
  } });
  if (linkedDeal && state.deals.has(linkedDeal)) {
    try { await openDeal(linkedDeal); }
    catch (error) {
      $('#dealDetail').innerHTML = '<header><h2>Deal details unavailable.</h2><button type="button" class="icon-button" data-close-deal aria-label="Close details">×</button></header>';
      $('#dealDialog').dataset.dealId = linkedDeal;
      $('#dealDialog').showModal();
      console.error('Linked deal details unavailable', error);
    }
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(()=>{});
}

/**
 * The shell starts itself only when it is actually in its own page: `#rows` is
 * the board's root element. A harness that imports this module gets the
 * functions and none of the timers, reads or listeners.
 */
if (typeof document !== 'undefined' && document.getElementById('rows')) {
  boot().catch((error) => {
    console.error(error);
    document.body.insertAdjacentHTML('afterbegin', `<div class="offline">Deal Room could not start: ${esc(error.message)}</div>`);
  });
}

if (typeof document !== 'undefined') onDialogClosed(document.getElementById('dealDialog'), () => selectDocRecord(null, null));
