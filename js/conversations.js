// V5-UX-B07 — the Doc conversations page: DOM wiring only.
//
// Every decision about a payload, a state or a sentence lives in
// ./conversations-model.js, and every decision about what a command DID lives
// in the shared kernel (./command-feedback.mjs) and its dock. This file reads,
// paints, and sends exactly three writes.
//
// Five shapes govern the file:
//
//   1. THE LIST IS A READ, NOT A MEMORY. `list-doc-conversations` returns the
//      conversations the signed-in actor may see, and this page keeps nothing
//      on the device: no id, no title, no cursor. The rows are painted in the
//      order the verb returned them — pinned first, then most recently updated
//      — and nothing here re-sorts them. Every write re-reads the list, because
//      only the record layer knows what the store now holds.
//   2. `visible_conversation_count` is PRINTED from the list payload. The page
//      never counts its own rows: a first page of 25 is not the number of
//      conversations a person can see, and printing it as one would be a lie
//      the store never told.
//   3. Each read stamps its OWN clock, and a read that answers after a newer
//      one was issued is IGNORED — the `view.sequence` guard. The server's
//      prose never reaches the page: only its STATUS and its CODE cross.
//   4. Every write goes through performCommand with ONE operation key per
//      intent per subject, and the kernel mints and retains the idempotency
//      key. An unknown outcome keeps its entry so "Check outcome" re-sends the
//      SAME frozen request — which matters most for create, where the key
//      becomes the conversation id and a second key is a second conversation.
//   5. A `version_conflict` is never retried automatically and never answered
//      with the version the refusal carried. The page re-reads, which is the
//      only source of the new version, and asks the person to press again.
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountNotificationBadge, mountPrefs } from "./shell.js";
import { formatClock } from "./visual-system.js";
import {
  COMPOSER_ABSENT, DOC_REPLY_PENDING, EXPOSURE_STATEMENT, LIST_EMPTY, LIST_SCOPE,
  PARTNER_SLUGS, SHARING_CAVEAT, TITLE_HISTORY_UNREADABLE,
  accessRows, archiveOperationKey, classifyReadFailure, conversationState, createArgs,
  createOperationKey, idFromSearch, identityHeader, listArgs, listPagingState, listRows,
  pagingState, pinOperationKey, renameArgs, renameOperationKey, shareArgs,
  shareCandidates, shareOperationKey, turnRows, visibleCountLine,
} from "./conversations-model.js";
import {
  OUTCOME_CARDS_NO_OPEN_SENTENCE, changedFields, flowStages, outcomeCards,
  outcomeCardsEmptyMessage, outcomeCardsPagingState, outcomeCardsRequest,
  refuseDocOutcomeCards,
} from "./doc-outcome-cards-model.js";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** The page of turns this page asks for. */
const LIMIT = 50;

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  route: { state: "missing", id: null, given: null },
  sequence: 0,
  conversation: { state: "pending" },
  list: { state: "pending", payload: null, rows: [] },
  includeArchived: false,
  // V5-UX-B09: an independent, actor-scoped read. It holds ITS OWN rows and
  // its own sequence guard rather than sharing the conversation's, because a
  // conversation open/close or a list refresh must never discard or race an
  // in-flight outcome-cards page.
  // `previousById` is the last render's `outcomeCard()` view per card_id, kept
  // across reads (never reset by a fresh page) so a genuine re-read — the
  // whole reason this section exists — can flash exactly the fields that
  // changed rather than the whole card. New cards are compared against
  // nothing and never flash; the entrance animation already says "new".
  outcomeCards: { state: "pending", payload: null, rows: [], sequence: 0, previousById: new Map() },
};

let client = null;
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();

function announce(text) {
  const live = $("conversationLive");
  if (live && text && live.textContent !== text) live.textContent = text;
}

function announceOutcomeCards(text) {
  const live = $("outcomeCardsLive");
  if (live && text && live.textContent !== text) live.textContent = text;
}

const asOf = (read) => (read?.state === "read" && formatClock(read.observed_at)
  ? `As of ${formatClock(read.observed_at)}`
  : "unknown");

const payloadOf = () => (view.conversation.state === "read" ? view.conversation.payload : null);

/* -------------------------------------------------------------------- painting */

function renderHero() {
  const payload = payloadOf();
  $("conversationAsOf").textContent = asOf(view.conversation);
  const header = identityHeader(payload);
  const badge = $("visibilityBadge");
  if (!header) {
    $("pageTitle").textContent = "Conversations";
    $("conversationId").textContent = view.route.given || "no conversation open";
    badge.setAttribute("data-visibility", "none");
    $("visibilityGlyph").textContent = "🔒";
    $("visibilityWord").textContent = "No conversation is open";
    $("heroFacts").innerHTML = "";
    return;
  }
  $("pageTitle").textContent = header.title;
  $("conversationId").textContent = header.id;
  badge.setAttribute("data-visibility", header.visibility);
  $("visibilityGlyph").textContent = header.glyph;
  $("visibilityWord").textContent = header.word;
  const facts = [
    `Version ${header.version}`,
    `Created by ${header.createdBy}`,
    header.pinned ? `Pinned at ${header.pinnedClock}` : "Not pinned",
    header.archived ? `Archived at ${header.archivedClock}` : "Not archived",
  ];
  $("heroFacts").innerHTML = facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("");
}

function renderTurns() {
  const payload = payloadOf();
  const state = conversationState(view.conversation, view.route);
  const block = $("turnsState");
  block.setAttribute("data-state", state.state);
  $("turnsStateTitle").textContent = state.sentence || "";
  block.hidden = state.state === "ready";
  $("conversationOrb").setAttribute(
    "data-state",
    state.state === "ready" || state.state === "empty" ? "healthy"
      : ["refused", "unavailable", "not_found", "malformed"].includes(state.state) ? "urgent" : "still",
  );
  $("turnList").innerHTML = turnRows(payload).map((turn) => `<li class="turn" data-role="${escapeHtml(turn.role)}" data-sequence="${turn.sequence}">
    <div class="turn-top"><span class="turn-role">${escapeHtml(turn.role)}</span><span>${escapeHtml(turn.clock)}</span></div>
    <p class="turn-body">${escapeHtml(turn.body)}</p>
  </li>`).join("");
  const paging = pagingState(payload);
  $("pagingBlock").hidden = !paging.more;
}

function renderAccess() {
  const payload = payloadOf();
  const rows = accessRows(payload);
  $("accessList").innerHTML = rows.map((row) => `<li class="work-item" data-priority="ordinary" data-grantee="${escapeHtml(row.grantee)}">
    <div><h3 class="access-row">${escapeHtml(row.grantee)}</h3>
    <div class="work-meta"><span>granted by ${escapeHtml(row.grantedBy)} · ${escapeHtml(row.clock)}</span></div></div>
    <div class="stack-end"></div>
  </li>`).join("") || (payload
    ? `<li class="work-item" data-priority="ordinary"><div><h3 class="access-row">Nobody else can read this conversation</h3><div class="work-meta"><span>read from the record layer</span></div></div><div class="stack-end"></div></li>`
    : "");
  $("shareControls").innerHTML = shareCandidates(payload, PARTNER_SLUGS).map((row) => `<button class="btn share-toggle" type="button" data-share="${escapeHtml(row.slug)}" aria-pressed="${row.granted}">${row.granted ? "Shared with" : "Not shared with"} ${escapeHtml(row.slug)}</button>`).join("");
  const header = identityHeader(payload);
  $("pinToggle").setAttribute("aria-pressed", header ? String(header.pinned) : "false");
  $("pinToggle").textContent = header?.pinned ? "Unpin this conversation" : "Pin this conversation";
  $("archiveToggle").setAttribute("aria-pressed", header ? String(header.archived) : "false");
  $("archiveToggle").textContent = header?.archived ? "Take this out of the archive" : "Archive this conversation";
}

function renderList() {
  const payload = view.list.state === "read" ? view.list.payload : null;
  $("visibleCountLine").textContent = visibleCountLine(payload);
  const rows = view.list.rows;
  // IN THE VERB'S ORDER. `.map` walks the array as the record layer handed it
  // over; nothing here sorts, filters or regroups, because pinned-first then
  // most-recently-updated is the store's rule and not this page's.
  $("conversationList").innerHTML = rows.map((row) => `<li class="work-item" data-priority="${row.pinned ? "deadline" : "ordinary"}" data-conversation="${escapeHtml(row.id)}" data-visibility="${escapeHtml(row.visibility)}">
    <div>
      <h3 class="list-title">${escapeHtml(row.title)}</h3>
      <p class="list-meta">${escapeHtml(row.visibility === "shared" ? "shared" : "private")}${row.pinned ? " · pinned" : ""}${row.archived ? " · archived" : ""}${row.latestClock ? ` · last said ${escapeHtml(row.latestClock)}` : ""} · <span class="mono">${escapeHtml(row.id)}</span></p>
      <div class="list-open"><button class="btn" type="button" data-open="${escapeHtml(row.id)}">Open this conversation</button></div>
    </div>
  </li>`).join("");
  $("archivedToggle").setAttribute("aria-pressed", String(view.includeArchived));
  $("archivedToggle").textContent = view.includeArchived ? "Hide archived" : "Show archived";
  $("listPagingBlock").hidden = !listPagingState(payload).more;
  const block = $("listState");
  const bare = view.list.state === "read" && rows.length === 0;
  block.hidden = !(bare || view.list.state === "unavailable");
  $("listStateTitle").textContent = view.list.state === "unavailable"
    ? view.list.sentence
    : (bare ? LIST_EMPTY : "");
}

/**
 * V5-UX-B09 — persistent outcome/owner/phase/next-check/result cards, with
 * qualified routing state. This is a wholly separate read from the open
 * conversation: it is actor-scoped, not conversation-scoped, so it renders
 * regardless of whether a conversation is open.
 *
 * `intentKind` (recommendation vs submission) and `result.available`
 * distinguish recommendation, submission and outcome on the card itself,
 * exactly as the spec's third included-scope clause asks — none of the three
 * is inferred; each is the field the producer actually returned. Rule
 * 9293d609 (every CARR surface ships with real motion, never a static page)
 * adds four things beyond the markup: a staggered entrance
 * (`--outcome-card-delay`, css/room.css's `--drift-delay` convention), a
 * live pulse on the freshness dot tied to the SERVER's own `as_of`
 * comparison (`isLive`, never a decorative timer), a flash on any field that
 * changed since the previous read (`.is-changed`, css/room.css's
 * `figure-flash` convention — a phrase cannot count up, so it brightens once
 * instead of cutting), and the recommendation → submission → outcome flow
 * line, modeled on css/workspace.css's own animated pipeline flow diagram
 * (`.flow-node`/`.flow-path`, reusing the SAME `flow-dash` keyframe and
 * `--motion-flow` token from css/system.css).
 */
function outcomeFlowSvg(card) {
  const stages = flowStages(card);
  const [recommendation, submission, outcome] = stages;
  const cx = { recommendation: 14, submission: 80, outcome: 146 };
  const nodes = stages.map((stage) => `<circle class="outcome-flow-node" data-stage="${escapeHtml(stage.id)}" data-reached="${stage.reached}" cx="${cx[stage.id]}" cy="12" r="6"></circle>`).join("");
  return `<svg class="outcome-flow" viewBox="0 0 160 24" aria-hidden="true" focusable="false">
    <path class="outcome-flow-path" data-active="${submission.reached}" d="M${cx.recommendation + 6} 12 H${cx.submission - 6}"></path>
    <path class="outcome-flow-path" data-active="${outcome.reached}" d="M${cx.submission + 6} 12 H${cx.outcome - 6}"></path>
    ${nodes}
  </svg>
  <p class="small outcome-flow-labels">${stages.map((stage) => `<span data-reached="${stage.reached}">${escapeHtml(stage.label)}</span>`).join('<span aria-hidden="true"> → </span>')}</p>`;
}

function outcomeFieldSpan(className, changed, text) {
  return `<span class="outcome-field${changed ? " is-changed" : ""}" data-field="${escapeHtml(className)}">${escapeHtml(text)}</span>`;
}

function outcomeCardHtml(card, { delayMs = 0, changed = { phase: false, nextCheck: false, result: false, routingState: false } } = {}) {
  const owner = card.owner ?? "unassigned";
  const phase = card.phase ?? "unrecorded";
  const nextCheck = card.nextCheck.available ? card.nextCheck.value : card.nextCheck.text;
  const result = card.result.available ? card.result.value : card.result.text;
  const entry = card.sessionEntry;
  const sessionRefLine = entry.sessionRef
    ? `<p class="small mono">session ref: ${escapeHtml(entry.sessionRef)}</p>`
    : "";
  return `<li class="work-item outcome-card" data-outcome-card-delay="${delayMs}" data-priority="ordinary" data-outcome-card="${escapeHtml(card.id)}" data-routing-state="${escapeHtml(card.routingState)}" data-intent="${escapeHtml(card.intentKind)}">
    <div>
      <h3 class="list-title">${escapeHtml(card.requestedOutcome ?? card.workRequestRef)}</h3>
      <p class="list-meta">
        <span class="outcome-live-dot" data-fresh="${escapeHtml(card.freshness.state)}" aria-hidden="true"></span>
        <span class="chip" data-intent="${escapeHtml(card.intentKind)}">${escapeHtml(card.intentLabel)}</span>
        <span class="chip" data-state="${escapeHtml(card.routingState)}">routing: ${outcomeFieldSpan("routingState", changed.routingState, card.routingStateLabel)}</span>
        · owner ${escapeHtml(owner)} · phase ${outcomeFieldSpan("phase", changed.phase, phase)}
        · <span class="mono">${escapeHtml(card.workRequestRef)}</span>
      </p>
      ${outcomeFlowSvg(card)}
      <p class="small">Next check: ${outcomeFieldSpan("nextCheck", changed.nextCheck, String(nextCheck))}</p>
      <p class="small" data-outcome="${String(card.result.available)}">Result: ${outcomeFieldSpan("result", changed.result, String(result))}</p>
      <p class="small caption">${escapeHtml(card.freshness.text)}</p>
      <p class="small session-host" data-open="false">${escapeHtml(entry.reasonSentence)} ${escapeHtml(entry.scopedSolution)}</p>
      ${sessionRefLine}
    </div>
  </li>`;
}

/** Entrance stagger step, in ms. Six cards land in 5*70 + 270 = 620ms — well
 *  under the rule's ~1s ceiling — and css/system.css's motion floor removes
 *  the delay and the animation entirely under reduced motion. */
const OUTCOME_CARD_STAGGER_MS = 70;

function renderOutcomeCards() {
  const list = $("outcomeCardsList");
  const block = $("outcomeCardsState");
  const paging = $("outcomeCardsPagingBlock");
  if (!list || !block) return;
  if (view.outcomeCards.state === "loading" && view.outcomeCards.rows.length === 0) {
    list.innerHTML = "";
    block.hidden = false;
    block.dataset.state = "loading";
    $("outcomeCardsStateTitle").textContent = "Taking the read…";
    if (paging) paging.hidden = true;
    return;
  }
  if (view.outcomeCards.state === "unavailable") {
    list.innerHTML = "";
    block.hidden = false;
    block.dataset.state = "unavailable";
    $("outcomeCardsStateTitle").textContent = view.outcomeCards.sentence
      || "The outcome cards read could not be rendered.";
    if (paging) paging.hidden = true;
    return;
  }
  const cards = outcomeCards({ cards: view.outcomeCards.rows });
  // Every card gets its own delay so the entrance is ORCHESTRATED rather
  // than simultaneous, and every card's change flags come from comparing
  // THIS read against the previous one — new cards (no prior entry) never
  // flash, since the entrance animation already says "this just appeared".
  list.innerHTML = cards.map((card, index) => outcomeCardHtml(card, {
    delayMs: index * OUTCOME_CARD_STAGGER_MS,
    changed: changedFields(view.outcomeCards.previousById.get(card.id) ?? null, card),
  })).join("");
  // A staggered entrance, set through CSSOM: the Worker's CSP (src/worker.js)
  // refuses a `style` attribute written into markup, so the template above
  // only emits `data-outcome-card-delay`, and this reads it back.
  list.querySelectorAll(".outcome-card").forEach((node) => {
    node.style.setProperty("--outcome-card-delay", `${node.dataset.outcomeCardDelay}ms`);
  });
  view.outcomeCards.previousById = new Map(cards.map((card) => [card.id, card]));
  const empty = outcomeCardsEmptyMessage({ cards: view.outcomeCards.rows });
  block.hidden = !(cards.length === 0 && empty);
  block.dataset.state = "empty";
  $("outcomeCardsStateTitle").textContent = empty || "";
  const pagingState = outcomeCardsPagingState(view.outcomeCards.payload);
  if (paging) paging.hidden = !pagingState.more;
}

function render() {
  renderHero();
  renderTurns();
  renderAccess();
  renderList();
  renderOutcomeCards();
}

/* --------------------------------------------------------------------- reading */

/**
 * One read, settled on its own. A failure is classified from its STATUS and its
 * CODE, and a read that lands after a newer one was issued is discarded — the
 * page paints the latest picture it asked for, never the last one that arrived.
 */
async function takeConversation({ after = null } = {}) {
  if (view.route.state !== "ok") {
    view.conversation = view.route.state === "malformed" ? { state: "malformed" } : { state: "pending" };
    render();
    return;
  }
  const sequence = view.sequence;
  const held = payloadOf();
  if (view.conversation.state === "read") view.conversation = { ...view.conversation, refreshing: true };
  render();
  try {
    const args = { conversation_id: view.route.id, limit: LIMIT };
    if (Number.isInteger(after)) args.after_sequence = after;
    const payload = await client.readDocConversation(args);
    if (view.sequence !== sequence) return;
    // Paging APPENDS; the server's order is kept and nothing is re-sorted.
    const merged = (Number.isInteger(after) && held)
      ? { ...payload, turns: [...held.turns, ...payload.turns] }
      : payload;
    view.conversation = { state: "read", payload: merged, observed_at: new Date().toISOString() };
  } catch (error) {
    if (view.sequence !== sequence) return;
    const failure = classifyReadFailure(error);
    view.conversation = { state: failure.state, sentence: failure.sentence };
  }
  render();
}

/**
 * The list read. One call, one page, and a cursor that is passed back UNREAD.
 *
 * A `cursor` APPENDS: the verb's order is a single sequence across pages, so
 * the next page continues the one on screen and re-sorting the union would
 * destroy the ordering paging exists to preserve. No cursor means a fresh
 * first page, which is what every write settles into.
 */
async function takeList({ cursor = null } = {}) {
  const sequence = view.sequence;
  const held = cursor ? view.list.rows : [];
  try {
    const payload = await client.listDocConversations(
      listArgs({ cursor, includeArchived: view.includeArchived }),
    );
    if (view.sequence !== sequence) return;
    view.list = { state: "read", payload, rows: [...held, ...listRows(payload)] };
  } catch (error) {
    if (view.sequence !== sequence) return;
    const failure = classifyReadFailure(error);
    view.list = { state: "unavailable", payload: null, rows: held, sentence: failure.sentence };
  }
  render();
}

/**
 * V5-UX-B09's read. Its OWN sequence guard, separate from `view.sequence`,
 * because the outcome cards are actor-scoped rather than tied to whichever
 * conversation happens to be open — a conversation switch must not discard
 * an in-flight cards page, and a cards refresh must not race a slower one.
 *
 * A `cursor` APPENDS, exactly as `takeList` appends: the producer's order is
 * one sequence across pages and re-sorting the union would destroy the
 * `updated_at desc, id desc` ordering paging exists to preserve.
 */
async function takeOutcomeCards({ cursor = null } = {}) {
  const sequence = ++view.outcomeCards.sequence;
  const held = cursor ? view.outcomeCards.rows : [];
  view.outcomeCards = { ...view.outcomeCards, state: "loading" };
  render();
  try {
    const payload = await client.docOutcomeCards(outcomeCardsRequest({ cursor }));
    if (view.outcomeCards.sequence !== sequence) return;
    const refusal = refuseDocOutcomeCards(payload);
    if (refusal) {
      view.outcomeCards = { ...view.outcomeCards, state: "unavailable", payload: null, rows: held, sequence, sentence: `The outcome cards read did not answer: ${refusal}.` };
    } else {
      view.outcomeCards = { ...view.outcomeCards, state: "read", payload, rows: [...held, ...payload.cards], sequence };
    }
  } catch (error) {
    if (view.outcomeCards.sequence !== sequence) return;
    const failure = classifyReadFailure(error);
    view.outcomeCards = { ...view.outcomeCards, state: "unavailable", payload: null, rows: held, sequence, sentence: failure.sentence };
  }
  render();
  announceOutcomeCards(view.outcomeCards.state === "unavailable"
    ? view.outcomeCards.sentence
    : `${view.outcomeCards.rows.length} outcome card${view.outcomeCards.rows.length === 1 ? "" : "s"} shown.`);
}

async function load() {
  view.sequence += 1;
  await Promise.all([takeConversation(), takeList(), takeOutcomeCards()]);
  const state = conversationState(view.conversation, view.route);
  announce(state.sentence || visibleCountLine(view.list.state === "read" ? view.list.payload : null));
}

/** Opening one sets `?id=` so Back restores the list this page came from. */
function open(id) {
  const route = idFromSearch(`?id=${id}`);
  view.route = route;
  view.conversation = { state: "pending" };
  try {
    globalThis.history?.pushState?.({ id }, "", `/conversations?id=${id}`);
  } catch {
    // A host that refuses history keeps the page; only the address bar lags.
  }
  load();
}

/* --------------------------------------------------------------------- writing */

async function dispatch(operationKey, args, summary, send) {
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  operations.set(operationKey, { args, summary, send });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announce(result.message);
  // Only the record layer knows what the store now holds, so a settled write
  // re-reads it rather than painting the answer this page hoped for.
  //
  // A conflict re-reads for exactly the same reason and for one more: the
  // re-read is the ONLY source of the version the next attempt may carry. The
  // version the refusal named is evidence that something moved, and using it
  // as the next base would overwrite whatever moved it.
  if (result.status === "ok" || result.status === "conflict") {
    if (result.status === "ok" && operationKey === createOperationKey() && result.response?.conversation_id) {
      open(result.response.conversation_id);
      return result;
    }
    await load();
  }
  return result;
}

function send(operationKey, built, summary, call) {
  if (!built.ok) {
    announce(built.message);
    dock.record(operationKey, { summary, status: "refused", reason: built.message, undo: false });
    return;
  }
  dock.record(operationKey, { summary, status: "sending", undo: false });
  dispatch(operationKey, built.args, summary, call);
}

function create() {
  const built = createArgs({
    title: $("createTitleInput")?.value,
    visibility: $("createVisibility")?.value,
  });
  send(createOperationKey(), built, `Create the conversation "${built.args?.title || ""}"`,
    (request) => client.createDocConversation(request));
}

function rename(change, operationKey, summary) {
  const built = renameArgs(payloadOf(), change);
  send(operationKey, built, summary, (request) => client.renameDocConversation(request));
}

function share(slug, granted) {
  const header = identityHeader(payloadOf());
  const built = shareArgs(header?.id, slug, granted);
  send(shareOperationKey(header?.id, slug), built,
    `${granted ? "Share" : "Stop sharing"} this conversation with ${slug}`,
    (request) => client.shareDocConversation(request));
}

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  dock = createCommandDock({
    root,
    // A refusal is settled: the kernel dropped the entry, so this starts over
    // with the same arguments and a new key, which is the only correct retry.
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary, entry.send);
    },
    // An unknown outcome is reconciled by re-sending the SAME frozen request;
    // the kernel returns the retained one, so the same arguments are passed.
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary, entry.send);
    },
    onUndo: null,
  });
  dock.mount();
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  mountDocDock("Conversations");
  mountDock();
  $("listScope").textContent = LIST_SCOPE;
  $("sharingCaveat").textContent = SHARING_CAVEAT;
  $("composerAbsent").textContent = COMPOSER_ABSENT;
  $("docReplyPending").textContent = DOC_REPLY_PENDING;
  $("titleHistoryLine").textContent = TITLE_HISTORY_UNREADABLE;
  $("exposureStatement").textContent = EXPOSURE_STATEMENT;
  // Permanent, beside the outcome cards heading, matching sessions.js's own
  // NO_OPEN_SENTENCE pattern: written from the model so deleting the element
  // cannot leave a page that quietly implies it can open a session.
  const outcomeCardsNoOpen = $("outcomeCardsNoOpen");
  if (outcomeCardsNoOpen) outcomeCardsNoOpen.textContent = OUTCOME_CARDS_NO_OPEN_SENTENCE;
  const location = globalThis.location || { hostname: "", search: "" };
  const params = new URLSearchParams(location.search || "");
  view.route = idFromSearch(location.search || "");
  $("retryRead")?.addEventListener("click", () => load());
  $("outcomeCardsRetry")?.addEventListener("click", () => takeOutcomeCards());
  $("outcomeCardsShowMore")?.addEventListener("click", () => {
    const paging = outcomeCardsPagingState(view.outcomeCards.state === "read" ? view.outcomeCards.payload : null);
    if (paging.more) takeOutcomeCards({ cursor: paging.cursor });
  });
  $("showMore")?.addEventListener("click", () => {
    const paging = pagingState(payloadOf());
    if (paging.more) takeConversation({ after: paging.after });
  });
  // The toggle is not a filter over rows this page already holds: it is the
  // verb's `include_archived`, so pressing it costs a fresh read and the page
  // shows exactly what the record layer returns for that argument.
  $("archivedToggle")?.addEventListener("click", () => {
    view.includeArchived = !view.includeArchived;
    view.sequence += 1;
    takeList();
  });
  $("showMoreConversations")?.addEventListener("click", () => {
    const paging = listPagingState(view.list.state === "read" ? view.list.payload : null);
    if (paging.more) takeList({ cursor: paging.cursor });
  });
  for (const list of ["conversationList"]) {
    $(list)?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-open]") : null;
      if (target) open(target.getAttribute("data-open"));
    });
  }
  $("shareControls")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-share]") : null;
    if (target) share(target.getAttribute("data-share"), target.getAttribute("aria-pressed") !== "true");
  });
  $("createSave")?.addEventListener("click", () => create());
  $("renameSave")?.addEventListener("click", () => {
    const header = identityHeader(payloadOf());
    rename({ title: $("renameInput")?.value }, renameOperationKey(header?.id), "Rename this conversation");
  });
  $("pinToggle")?.addEventListener("click", (event) => {
    const header = identityHeader(payloadOf());
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    rename({ pinned: !pressed }, pinOperationKey(header?.id), pressed ? "Unpin this conversation" : "Pin this conversation");
  });
  $("archiveToggle")?.addEventListener("click", (event) => {
    const header = identityHeader(payloadOf());
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    rename({ archived: !pressed }, archiveOperationKey(header?.id), pressed ? "Unarchive this conversation" : "Archive this conversation");
  });
  globalThis.addEventListener?.("popstate", () => {
    view.route = idFromSearch(globalThis.location?.search || "");
    view.conversation = { state: "pending" };
    load();
  });
  const boot_ = resolveDealroomBoot(location);
  const outage = params.get("outage");
  client = boot_.mode === "live"
    ? createLiveClient()
    : await createFixtureClient({ ...boot_.options, ...(outage ? { outage } : {}) });
  mountNotificationBadge(client);
  await load();
}

boot();

export { view };
