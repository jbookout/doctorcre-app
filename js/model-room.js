// V5-UX-C12 plus V5-UX-C13 clause 3 plus V5-UX-C13b — the Model Room tab: DOM
// wiring only.
//
// Every decision about a payload is in ./model-room-model.js. This file reads,
// paints, and — as of C13b — makes exactly ONE admitted write: `add-room-turn`,
// the composer below. The other two things C13b's scope names have no
// admitted write behind them:
//   * the Kanban move (ASSIGNMENT_MOVE_UNSUPPORTED_SENTENCE — no pinned verb
//     changes a projected assignment's status), and
//   * acknowledging a dispatch (ACK_UNAVAILABLE_SENTENCE — that evidence is
//     first-hand, from the acting agent seat, and a click here would put the
//     wrong name on it; an earlier revision of this file wired it and it was
//     removed for exactly that reason).
// Both render as real interaction that always explains, honestly and by
// name, why nothing was sent — never a fake success and never a disabled
// control standing in for one that could not exist (S02 clause 3's own rule,
// extended here).
//
// The reads are LAZY, like the Atlas and Sessions tabs: they fire on the first
// selection of this tab, never on page boot, so the Control Room's four
// dashboard reads keep their time-to-glance. Nothing polls: one read per panel
// per visit, plus the explicit "Read again" control the other tabs carry.
//
// THERE IS NO OPEN OR EXECUTE CONTROL IN THIS FILE. Search only narrows the
// permission-filtered session read; choosing a row reads history and never
// treats historical rationale as a fresh instruction.
import {
  ACK_UNAVAILABLE_SENTENCE, ACKNOWLEDGEMENT_SENTENCE,
  ANSWER_EVIDENCE_MAX, ANSWER_TEXT_MAX, ANSWER_VERSION_CONFLICT_SENTENCE, ANSWER_VERSION_UNAVAILABLE_SENTENCE,
  ASSIGNMENT_MOVE_UNSUPPORTED_SENTENCE, DISPATCH_SEARCH_SENTENCE, DISPATCH_STAGES_SENTENCE, NO_OPEN_SENTENCE,
  QUEUE_ROOM_SENTENCE, TOPIC_HISTORY_SENTENCE, WORK_ITEM_HISTORY_SENTENCE,
  answerBaseVersion, answerDraftAfterAttempt, answerWorkRequestRequest, assignmentBoard, assignmentMoveOutcome,
  composerDraftAfterAttempt, composerRequest, contextPanel, countsLine, dispatchSearchRequest, dispatchView,
  historyTopics, historyWorkItems, listState, participants, queueFreshness, queueRequest, refuseDispatchHistory,
  refuseRoomQueue, refuseRoomTurns, refuseSessionIdentity, refuseWorkRequestCard, sessionCards, topicHistory,
  turnRequest, turnWindow, workItemLedger, workRequestCardRequest,
} from "./model-room-model.js";
import { validCurrentWorkRequestsPayload } from "./control-room-model.js";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { formatClock } from "./visual-system.js";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

let mounted = false;
let client = null;

const view = {
  outage: null,
  /** One counter per slot: three reads run together and must not cancel each other. */
  sequence: { queue: 0, sessions: 0, turns: 0, workItems: 0, historyCard: 0 },
  status: "idle",
  queue: { state: "idle", payload: null, refusal: null },
  sessions: { state: "idle", payload: null, refusal: null },
  turns: { state: "idle", payload: null, refusal: null },
  /** canonical_session_id of the selected card; null until one is chosen. */
  selected: null,
  dispatch: { state: "idle", payload: null, refusal: null },
  searchQuery: "",
  // V5-UX-C13a: the topic/work-item history picker. `workItems` is the
  // current-work-requests read that fills the second <select>; `historyCard`
  // is the work-request-card read for whichever work item is chosen.
  workItems: { state: "idle", payload: null, refusal: null },
  historyTopicId: "",
  historyWorkItemId: "",
  historyCard: { state: "idle", payload: null, refusal: null },
  // V5-UX-C13b: the composer's draft, and the one real write on this tab
  // (`add-room-turn`). The draft is kept, in full, whenever a send fails —
  // see composerDraftAfterAttempt.
  composer: { text: "" },
  composerSend: { state: "idle", message: null },
  // V5-UX-C13c: the Waiting-for-Joe answer form's draft and send state. Kept
  // per-item only in the sense that choosing a different work item clears it
  // (selectHistoryWorkItem) — the same rule the composer follows for its own
  // draft, applied here so a stale answer can never be sent against a
  // different card than the one it was written for.
  answer: { answerText: "", evidenceRef: "", scopeConfirmed: false },
  answerSend: { state: "idle", message: null },
  // The last drop's outcome on the assignments board. Always unsupported
  // (assignmentMoveOutcome), because no pinned verb moves a projected card.
  moveMessage: null,
};

const clock = (value) => formatClock(value) || "unknown";

function announce(text) {
  const live = $("modelRoomLive");
  if (live && live.textContent !== text) live.textContent = text;
}

function chip(label, value, state = "read") {
  return `<span class="chip" data-state="${escapeHtml(state)}">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
}

/* ------------------------------------------------------------- assignments */

function renderAssignments() {
  const line = $("modelRoomFreshness");
  const list = $("modelRoomAssignments");
  const dropped = $("modelRoomDropped");
  const empty = $("modelRoomAssignmentsEmpty");
  if (!line || !list) return;
  if (view.queue.state === "loading") {
    line.dataset.state = "loading";
    line.textContent = "Taking the queue read…";
    list.innerHTML = "";
    if (empty) empty.hidden = true;
    if (dropped) dropped.hidden = true;
    return;
  }
  // F4. A refusal and a thrown read land on the same state and the same
  // sentence, because from the reader's side they are the same fact.
  const payload = view.queue.refusal ? null : view.queue.payload;
  const fresh = queueFreshness(payload);
  line.dataset.state = fresh.state;
  // The state is carried by colour AND shape (the data-state rules) AND this
  // text, so a still screenshot reads correctly with no colour at all.
  line.textContent = view.queue.refusal
    ? `The queue could not be read: ${view.queue.refusal}.`
    : fresh.text;
  const retry = $("modelRoomQueueRetry");
  if (retry) retry.hidden = fresh.state !== "unavailable";
  if (!payload) {
    list.innerHTML = "";
    if (empty) empty.hidden = true;
    if (dropped) dropped.hidden = true;
    return;
  }
  const board = assignmentBoard(payload);
  // V5-UX-C13b: every card is draggable, and every drop is refused the same
  // honest way (assignmentMoveOutcome) — a real interaction with no pinned
  // verb behind it, never a fake move and never a disabled card standing in
  // for one that could not be dragged.
  list.innerHTML = board.cards.map((card) => `<article class="card glass assignment-card" draggable="true" data-task="${escapeHtml(card.taskId)}" data-status="${escapeHtml(card.status)}">
    <div class="assignment-head">
      <h4>${escapeHtml(card.title)}</h4>
      <span class="chip" data-priority="${escapeHtml(card.priority)}">${escapeHtml(card.priority)}</span>
    </div>
    <div class="chip-bar assignment-chips">
      ${chip("status", card.status)}
      ${chip("target", card.target)}
      ${chip("model", card.effectiveModel, card.effectiveModelIsObject ? "structured" : "read")}
      ${chip("cap", card.cap)}
      ${chip("event", card.event)}
    </div>
    <p class="assignment-summary">${escapeHtml(card.summary)}</p>
    <p class="assignment-meta small mono">${escapeHtml(card.taskId)} · updated ${escapeHtml(clock(card.updatedAt))} · ${escapeHtml(card.sourceSeqText)}</p>
  </article>`).join("");
  if (empty) {
    empty.hidden = board.cards.length > 0;
    empty.textContent = board.emptyText ?? "";
  }
  if (dropped) {
    // Counted, never silent. A dropped card the reader is not told about is a
    // lie about the assignment list.
    dropped.hidden = board.droppedCount === 0;
    dropped.textContent = board.droppedText ?? "";
  }
  for (const article of list.querySelectorAll("article[data-task]")) {
    article.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", article.dataset.task);
    });
  }
  renderMoveTarget(board);
}

/**
 * V5-UX-C13b: the drop target below the board. Any card dropped here is
 * refused the same honest way — no pinned verb changes a projected card's
 * status — and the result names the card by its task id.
 */
function renderMoveTarget(board) {
  const zone = $("modelRoomMoveTarget");
  const result = $("modelRoomMoveResult");
  if (zone && !zone.dataset.wired) {
    zone.dataset.wired = "true";
    zone.addEventListener("dragover", (event) => event.preventDefault());
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      const taskId = event.dataTransfer?.getData("text/plain") ?? "";
      const card = board?.cards.find((candidate) => candidate.taskId === taskId) ?? { taskId };
      const outcome = assignmentMoveOutcome(card);
      view.moveMessage = outcome;
      renderMoveResult();
    });
  }
  renderMoveResult();
}

function renderMoveResult() {
  const result = $("modelRoomMoveResult");
  if (!result) return;
  if (!view.moveMessage) { result.hidden = true; result.textContent = ""; return; }
  result.hidden = false;
  result.dataset.taskId = view.moveMessage.taskId ?? "";
  result.textContent = view.moveMessage.taskId
    ? `${view.moveMessage.taskId}: ${view.moveMessage.text}`
    : view.moveMessage.text;
}

/* ---------------------------------------------------------------- sessions */

function renderSessions() {
  const list = $("modelRoomSessions");
  const counts = $("modelRoomCounts");
  const banner = $("modelRoomBanner");
  const empty = $("modelRoomSessionsEmpty");
  if (!list) return;
  if (view.sessions.state === "loading") {
    list.innerHTML = "";
    if (counts) counts.textContent = "Taking the session read…";
    return;
  }
  const payload = view.sessions.refusal ? null : view.sessions.payload;
  if (counts) {
    const line = countsLine(payload);
    counts.textContent = view.sessions.refusal
      ? `The session read could not be rendered: ${view.sessions.refusal}.`
      : line.text;
    counts.dataset.state = payload ? "read" : "unavailable";
  }
  if (banner) {
    const filtered = payload?.permission_filtered === true;
    banner.hidden = !filtered;
    banner.textContent = filtered
      ? "Permission filtering is on for this answer: the record layer removed sessions you may not see before it "
        + "counted them."
      : "";
  }
  const cards = sessionCards(payload);
  list.innerHTML = cards.map((card) => `<button class="card glass session-pick" type="button" data-pick="${escapeHtml(card.id)}" aria-pressed="${card.id === view.selected}">
    <span class="session-pick-name">${escapeHtml(card.name)}</span>
    <span class="chip-bar session-pick-chips">
      ${chip("surface", card.surface)}
      ${chip("work state", card.workStateLabel, card.workState === "unknown" ? "unknown" : "read")}
      ${chip("name", card.derivedName ? "derived" : "recorded")}
      ${chip("observed", clock(card.observedAt))}
    </span>
    <span class="small mono session-pick-id">${escapeHtml(card.id)}</span>
  </button>`).join("");
  if (empty) {
    // Two different empties, two different sentences (S02 invariant 2).
    const state = listState(payload);
    empty.hidden = cards.length > 0 || !payload;
    empty.textContent = cards.length > 0 || !payload ? "" : (state.message ?? "");
  }
  for (const button of list.querySelectorAll("button[data-pick]")) {
    button.addEventListener("click", () => selectSession(button.dataset.pick));
  }
}

/* ------------------------------------------------------------- the context */

function dispatchHtml() {
  const stages = `<p class="dispatch-stages">
    <span data-stage="sent">sent: recorded per event</span>
    <span data-stage="received">received: recorded per event</span>
    <span data-stage="acknowledged">acknowledged: recorded per event</span>
    <span data-stage="acted">acted: recorded per event</span>
  </p>
  <p class="dispatch-honesty">${escapeHtml(DISPATCH_STAGES_SENTENCE)}</p>
  <p class="dispatch-honesty">${escapeHtml(DISPATCH_SEARCH_SENTENCE)}</p>`;
  if (view.dispatch.state === "loading") return `${stages}<p class="small">Taking the dispatch read…</p>`;
  if (view.dispatch.refusal) {
    return `${stages}<p class="small">The dispatch read could not be rendered: ${escapeHtml(view.dispatch.refusal)}.</p>`;
  }
  if (!view.dispatch.payload) return stages;
  const drawer = dispatchView(view.dispatch.payload);
  // V5-UX-C13b: no control offers to acknowledge a dispatch from here. That
  // evidence is first-hand — the acting agent seat's own receipt — and
  // whoever is browsing this page is not that seat. See ACK_UNAVAILABLE_SENTENCE.
  const availability = `<p class="dispatch-availability">
    <span data-stage="received" data-state="${escapeHtml(drawer.receivedState)}">received: ${escapeHtml(drawer.receivedState)}</span>
    <span data-stage="acknowledged" data-state="${escapeHtml(drawer.acknowledgedState)}">acknowledged: ${escapeHtml(drawer.acknowledgedState)}</span>
    ${drawer.stageUnavailableReason ? `<span data-state="unavailable">reason: ${escapeHtml(drawer.stageUnavailableReason)}</span>` : ""}
  </p>
  <p class="dispatch-ack-unavailable">${escapeHtml(ACK_UNAVAILABLE_SENTENCE)}</p>`;
  const empty = drawer.emptySentence ? `<p class="dispatch-empty">${escapeHtml(drawer.emptySentence)}</p>` : "";
  const events = drawer.events.map((event) => `<li class="dispatch-event" data-stage="${escapeHtml(event.stage)}">
    <p class="dispatch-when">${escapeHtml(event.stage)} · ${escapeHtml(clock(event.at))}</p>
    <p class="dispatch-evidence">${escapeHtml(event.evidence ?? "no evidence recorded")}</p>
    ${event.rationale ? `<p class="dispatch-rationale">${escapeHtml(event.rationale)}</p>` : ""}
    <dl class="dispatch-links detail-rows">
      <dt>parent</dt><dd>${escapeHtml(event.parentSessionId ?? drawer.parentSessionId ?? "not recorded")}</dd>
      <dt>attempt</dt><dd>${escapeHtml(event.attemptRef ?? "not recorded")}</dd>
      <dt>work request</dt><dd>${escapeHtml(event.workRequestRef ?? "not recorded")}</dd>
      <dt>dispatch</dt><dd>${escapeHtml(event.dispatchRef ?? "pre-spine / not recorded")}</dd>
      <dt>link evidence</dt><dd>${escapeHtml(event.linkSource ?? "not recorded")}</dd>
      <dt>superseded by</dt><dd>${escapeHtml(event.supersededBy ?? "current / not superseded")}</dd>
      <dt>missing-stage reason</dt><dd>${escapeHtml(event.stageUnavailableReason ?? "none")}</dd>
    </dl>
  </li>`).join("");
  return `${stages}${availability}${empty}<ul class="dispatch-list">${events}</ul>`;
}

function renderContext() {
  const root = $("modelRoomContext");
  if (!root) return;
  const payload = view.sessions.refusal ? null : view.sessions.payload;
  const rows = Array.isArray(payload?.sessions) ? payload.sessions : [];
  let row = null;
  for (const candidate of rows) if (candidate.canonical_session_id === view.selected) row = candidate;
  const panel = contextPanel(row, payload);
  if (!panel) {
    root.innerHTML = '<p class="small">Choose a session above to see its work-state evidence, its lineage and '
      + 'its dispatch history.</p>'
      + `<p class="model-room-no-open">${escapeHtml(NO_OPEN_SENTENCE)}</p>`;
    return;
  }
  root.innerHTML = `<div class="context-head">
      <h4>${escapeHtml(panel.name)}</h4>
      <p class="small mono">${escapeHtml(panel.id)}</p>
      <div class="chip-bar">
        ${chip("surface", panel.surface)}
        ${chip("work state", panel.workStateLabel, panel.workState === "unknown" ? "unknown" : "read")}
        ${chip("friendly name", panel.aliasSource)}
      </div>
    </div>
    <!-- Two independent lines. Work state is what was OBSERVED; parent contact
         is who started it. Merging them would be the inference clause 2 forbids. -->
    <p class="context-evidence">${escapeHtml(panel.evidenceText)}</p>
    <p class="context-parent" data-parent="${escapeHtml(panel.parent.state)}">${escapeHtml(panel.parent.text)}</p>
    <p class="context-lineage" data-relation="${escapeHtml(panel.lineage.relation)}">${escapeHtml(panel.lineage.text)}</p>
    <dl class="detail-rows">
      <dt>project</dt><dd>${escapeHtml(panel.projectAffinity ?? "not recorded")}</dd>
      <dt>working directory</dt><dd>${escapeHtml(panel.cwd ?? "not recorded")}</dd>
      <dt>model</dt><dd>${escapeHtml(panel.modelId ?? "not recorded")}</dd>
      <dt>attempts</dt><dd>${escapeHtml(String(panel.attemptCount))}</dd>
      <dt>latest attempt</dt><dd>${escapeHtml(panel.attemptRef ?? "no attempt reference recorded")}</dd>
    </dl>
    <!-- Where an "Open session" control would sit. It does not exist, in any
         branch, and this sentence is why. Copying an id is not opening a host. -->
    <p class="model-room-no-open">${escapeHtml(panel.noOpenText)}</p>
    <button class="btn" type="button" id="modelRoomCopyId" data-copy="${escapeHtml(panel.id)}">Copy the canonical session ID</button>
    <div class="context-dispatch">${dispatchHtml()}</div>`;
  const copy = $("modelRoomCopyId");
  if (copy) {
    copy.addEventListener("click", async () => {
      try {
        await globalThis.navigator?.clipboard?.writeText(copy.dataset.copy);
        announce("The canonical session ID was copied.");
      } catch {
        announce("The canonical session ID could not be copied; it is shown above.");
      }
    });
  }
}

/* --------------------------------------------------------- the participants */

function renderParticipants() {
  const list = $("modelRoomParticipants");
  const turnList = $("modelRoomTurns");
  const windowLine = $("modelRoomWindow");
  if (!list || !turnList) return;
  if (view.turns.state === "loading") {
    list.innerHTML = "";
    turnList.innerHTML = "";
    if (windowLine) windowLine.textContent = "Taking the room read…";
    return;
  }
  const payload = view.turns.refusal ? null : view.turns.payload;
  if (!payload) {
    list.innerHTML = "";
    turnList.innerHTML = "";
    if (windowLine) {
      windowLine.dataset.state = "unavailable";
      windowLine.textContent = `The room read could not be rendered: ${view.turns.refusal ?? "it did not answer"}.`;
    }
    return;
  }
  const window_ = turnWindow(payload);
  if (windowLine) {
    windowLine.dataset.state = window_.more ? "window" : "whole";
    windowLine.textContent = window_.quietText
      ?? `${window_.shown} turn${window_.shown === 1 ? "" : "s"} read, latest sequence ${window_.latestSeq}.`
        + (window_.windowText ? ` ${window_.windowText}` : "");
  }
  list.innerHTML = participants(payload).map((person) => `<li class="participant" data-seat="${escapeHtml(person.seat)}">
    <p class="participant-name">${escapeHtml(person.seat)} · sponsored by ${escapeHtml(person.sponsor)}</p>
    <p class="small">last turn ${escapeHtml(clock(person.lastAt))} · via ${escapeHtml(person.originChannel)} · as ${escapeHtml(person.originActor)}</p>
  </li>`).join("");
  turnList.innerHTML = window_.turns.map((turn) => `<li class="room-turn" data-kind="${escapeHtml(turn.kind)}">
    <p class="room-turn-head small mono">${escapeHtml(turn.seq)} · ${escapeHtml(turn.seat)} · ${escapeHtml(clock(turn.at))} · ${escapeHtml(turn.kind)}</p>
    <p class="room-turn-body">${escapeHtml(turn.body)}</p>
  </li>`).join("");
}

/* ------------------------------------------------- the topic/work-item history */

function ledgerRowsHtml(ledger) {
  const acting = ledger.actingEmptyText
    ? `<p class="model-room-empty">${escapeHtml(ledger.actingEmptyText)}</p>`
    : `<ul class="history-ledger">${ledger.actingEvents.map((event) => `<li class="history-ledger-row">
        <p class="history-ledger-head small mono">${escapeHtml(clock(event.actedAt))} · ${escapeHtml(event.act)}</p>
        <p class="small">${escapeHtml(event.deliveryState)}</p>
        <dl class="detail-rows">
          <dt>recorded as</dt><dd>${escapeHtml(event.recordedAs ?? "not recorded")}</dd>
          <dt>performed by</dt><dd>${escapeHtml(event.performedBy ?? "not recorded in the call ledger")}</dd>
          <dt>authorization class</dt><dd>${escapeHtml(event.authorizationClass ?? "not recorded")}</dd>
          <dt>via</dt><dd>${escapeHtml(event.via ?? "not recorded")}</dd>
        </dl>
      </li>`).join("")}</ul>`;
  const feedback = ledger.feedbackEmptyText
    ? `<p class="model-room-empty">${escapeHtml(ledger.feedbackEmptyText)}</p>`
    : `<ul class="history-ledger">${ledger.feedbackEvents.map((entry) => `<li class="history-ledger-row">
        <p class="history-ledger-head small mono">${escapeHtml(clock(entry.acceptedAt))} · ${escapeHtml(entry.outcome ?? "outcome not recorded")}</p>
        <p class="small">${escapeHtml(entry.resultSummary ?? "no result summary recorded")}</p>
        <p class="small">accepted by ${escapeHtml(entry.acceptedByActorSlug ?? "not recorded")}</p>
      </li>`).join("")}</ul>`;
  return `<h3 class="atlas-subhead">Acting-identity ledger, server order</h3>${acting}
    <h3 class="atlas-subhead">Accepted outcome feedback, server order</h3>${feedback}`;
}

function renderHistoryPickers() {
  const topicSelect = $("modelRoomHistoryTopic");
  const workItemSelect = $("modelRoomHistoryWorkItem");
  const workItemsState = $("modelRoomHistoryWorkItemsState");
  if (topicSelect) {
    const topics = view.queue.refusal ? [] : historyTopics(view.queue.payload);
    topicSelect.innerHTML = `<option value="">Choose a topic…</option>${topics.map((topic) => `<option value="${escapeHtml(topic.id)}" ${topic.id === view.historyTopicId ? "selected" : ""}>${escapeHtml(topic.title)} (${escapeHtml(topic.status)})</option>`).join("")}`;
  }
  if (workItemSelect) {
    const items = view.workItems.refusal ? [] : historyWorkItems(view.workItems.payload);
    workItemSelect.innerHTML = `<option value="">Choose a work item…</option>${items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === view.historyWorkItemId ? "selected" : ""}>${escapeHtml(item.id)} · ${escapeHtml(item.title)}</option>`).join("")}`;
  }
  if (workItemsState) {
    workItemsState.hidden = view.workItems.state !== "ready" || !view.workItems.refusal;
    workItemsState.textContent = view.workItems.refusal
      ? `The shared work-item list could not be read: ${view.workItems.refusal}.` : "";
  }
}

function renderHistoryPanel() {
  const root = $("modelRoomHistoryPanel");
  if (!root) return;
  if (view.historyWorkItemId) {
    if (view.historyCard.state === "loading") {
      root.innerHTML = "<p class=\"small\">Taking the work-request-card read…</p>";
      return;
    }
    if (view.historyCard.refusal) {
      root.innerHTML = `<p class="small">The work-item history could not be read: ${escapeHtml(view.historyCard.refusal)}.</p>`;
      return;
    }
    const ledger = view.historyCard.payload ? workItemLedger(view.historyCard.payload) : null;
    if (!ledger) { root.innerHTML = "<p class=\"small\">Choose a work item above to see its history.</p>"; return; }
    root.innerHTML = `<div class="context-head">
        <h4>${escapeHtml(ledger.humanRef)} · ${escapeHtml(ledger.title)}</h4>
        <p class="small mono">state: ${escapeHtml(ledger.state)}</p>
      </div>
      <p class="caption">${escapeHtml(WORK_ITEM_HISTORY_SENTENCE)}</p>
      ${ledgerRowsHtml(ledger)}`;
    return;
  }
  if (view.historyTopicId) {
    const found = view.queue.refusal ? null : topicHistory(view.historyTopicId, view.queue.payload);
    if (!found || !found.found || !found.card) {
      root.innerHTML = "<p class=\"small\">This topic is no longer in the current projection.</p>";
      return;
    }
    root.innerHTML = `<div class="context-head">
        <h4>${escapeHtml(found.card.taskId)} · ${escapeHtml(found.card.title)}</h4>
        <p class="small mono">status: ${escapeHtml(found.card.status)} · target: ${escapeHtml(found.card.target)}</p>
      </div>
      <p class="caption">${escapeHtml(found.sentence)}</p>
      <dl class="detail-rows">
        <dt>updated</dt><dd>${escapeHtml(clock(found.card.updatedAt))}</dd>
        <dt>priority</dt><dd>${escapeHtml(found.card.priority)}</dd>
        <dt>cap</dt><dd>${escapeHtml(found.card.cap)}</dd>
        <dt>summary</dt><dd>${escapeHtml(found.card.summary)}</dd>
        <dt>${escapeHtml(found.card.sourceSeqText)}</dt><dd></dd>
      </dl>`;
    return;
  }
  root.innerHTML = "<p class=\"small\">Choose a topic or a work item above to see its history.</p>";
}

function renderHistory() {
  renderHistoryPickers();
  renderHistoryPanel();
}

/* -------------------------------------------------------- V5-UX-C13b: composer */

/**
 * `add-room-turn`, the composer's one write. `composerRequest` validates and
 * builds the verb's own shape (body, seat: "human", room: TURN_ROOM); a send
 * that fails validation, or that the record layer refuses, keeps the draft
 * exactly as typed (composerDraftAfterAttempt) and shows the server's own
 * refusal verbatim rather than a paraphrase.
 */
function renderComposer() {
  const result = $("modelRoomComposerResult");
  if (result) {
    result.hidden = !view.composerSend.message;
    result.dataset.state = view.composerSend.state;
    result.textContent = view.composerSend.message ?? "";
  }
}

async function submitComposer() {
  // A second submit while one is already in flight is refused here rather
  // than re-entered, so a double click cannot post the draft twice.
  if (view.composerSend.state === "sending") return;
  const request = composerRequest({ text: view.composer.text });
  if (!request) {
    view.composer = composerDraftAfterAttempt(view.composer);
    view.composerSend = { state: "invalid", message: "Enter a message before sending; the draft is kept." };
    renderComposer();
    return;
  }
  view.composerSend = { state: "sending", message: "Sending…" };
  renderComposer();
  try {
    // A fresh idempotency key per attempt — minted here, not left to the
    // client. live-client.js's write() would mint one on its own, but
    // fixture-client.js requires the caller to supply one; this line is what
    // makes the composer actually send in fixture/demo mode as well as live.
    const result = await client.addRoomTurn({ ...request, idempotency_key: uuidv4() });
    // Sent, not fabricated: the confirmation is the server's own answer
    // (its sequence number), never an "ok" this file invented.
    view.composer = { text: "" };
    const input = $("modelRoomComposerText");
    if (input) input.value = "";
    view.composerSend = { state: "sent", message: `Sent — recorded as turn ${result?.seq ?? "unknown"}.` };
    announce("The Model Room request was sent.");
    if (client.roomTurns) await take("turns", () => client.roomTurns(turnRequest()), refuseRoomTurns);
  } catch (error) {
    // The draft survives every failure, and the message shown is the
    // record layer's own refusal, verbatim — never a paraphrase of it.
    view.composer = composerDraftAfterAttempt(view.composer);
    view.composerSend = {
      state: "failed",
      message: `Not sent: ${String(error?.payload?.error || error?.message || "the write did not answer")}.`,
    };
  }
  renderComposer();
}

/* ------------------------------------------------- V5-UX-C13c: answer form */

/**
 * `answer-work-request-for-joe`'s base_version comes from the card currently
 * loaded for view.historyWorkItemId — never re-derived, never defaulted. A
 * null result (no work item chosen, the read failed, or the read succeeded
 * but carried no version) is the sole gate for the honest-unavailable state.
 */
function currentAnswerBaseVersion() {
  if (!view.historyWorkItemId || view.historyCard.refusal || !view.historyCard.payload) return null;
  return answerBaseVersion(view.historyCard.payload);
}

function renderAnswer() {
  const unavailable = $("modelRoomAnswerUnavailable");
  const form = $("modelRoomAnswerForm");
  const result = $("modelRoomAnswerResult");
  if (!unavailable || !form) return;
  const baseVersion = currentAnswerBaseVersion();
  const offered = Boolean(view.historyWorkItemId) && baseVersion !== null;
  unavailable.hidden = !view.historyWorkItemId || offered;
  unavailable.textContent = view.historyWorkItemId && !offered ? ANSWER_VERSION_UNAVAILABLE_SENTENCE : "";
  form.hidden = !offered;
  if (offered) {
    const textInput = $("modelRoomAnswerText");
    const evidenceInput = $("modelRoomAnswerEvidence");
    const scopeInput = $("modelRoomAnswerScopeConfirmed");
    const counter = $("modelRoomAnswerCounter");
    const submit = $("modelRoomAnswerSubmit");
    if (textInput && textInput.value !== view.answer.answerText) textInput.value = view.answer.answerText;
    if (evidenceInput && evidenceInput.value !== view.answer.evidenceRef) evidenceInput.value = view.answer.evidenceRef;
    if (scopeInput && scopeInput.checked !== view.answer.scopeConfirmed) scopeInput.checked = view.answer.scopeConfirmed;
    if (counter) counter.textContent = `${view.answer.answerText.length} / ${ANSWER_TEXT_MAX}`;
    // Submit stays disabled until the checkbox is ticked AND there is answer
    // text — never a fake-disabled control, a real one with a real reason.
    const ready = view.answer.scopeConfirmed && view.answer.answerText.trim().length > 0
      && view.answerSend.state !== "sending";
    if (submit) submit.toggleAttribute("disabled", !ready);
  }
  if (result) {
    result.hidden = !view.answerSend.message;
    result.dataset.state = view.answerSend.state;
    result.textContent = view.answerSend.message ?? "";
  }
}

async function submitAnswer() {
  if (view.answerSend.state === "sending") return;
  const baseVersion = currentAnswerBaseVersion();
  const request = answerWorkRequestRequest({
    humanRef: view.historyWorkItemId,
    baseVersion,
    answerText: view.answer.answerText,
    scopeConfirmed: view.answer.scopeConfirmed,
    evidenceRef: view.answer.evidenceRef,
  });
  if (!request) {
    view.answer = answerDraftAfterAttempt(view.answer);
    view.answerSend = { state: "invalid", message: "Tick the checkbox and enter an answer before sending; the draft is kept." };
    renderAnswer();
    return;
  }
  view.answerSend = { state: "sending", message: "Sending…" };
  renderAnswer();
  try {
    // A fresh idempotency key per attempt, minted here for the same reason as
    // the composer's: fixture-client.js requires one, and this is the one
    // real write this form makes.
    const result = await client.answerWorkRequestForJoe({ ...request, idempotency_key: uuidv4() });
    view.answer = { answerText: "", evidenceRef: "", scopeConfirmed: false };
    view.answerSend = { state: "sent", message: `Sent — recorded as ${result?.state ?? "triaged"}.` };
    announce(`The answer for ${view.historyWorkItemId} was sent.`);
    // Re-read the card and the queue, so the ledger and the picker both show
    // the transition rather than a state this file invented.
    const args = workRequestCardRequest(view.historyWorkItemId);
    if (args) await take("historyCard", () => client.workRequestCard(args), refuseWorkRequestCard);
    await take("workItems", () => client.currentWorkRequests(),
      (payload) => (validCurrentWorkRequestsPayload(payload) ? null : "current_work_requests_unavailable"));
  } catch (error) {
    const code = String(error?.payload?.error || error?.message || "the write did not answer");
    view.answer = answerDraftAfterAttempt(view.answer);
    view.answerSend = {
      state: "failed",
      message: code === "version_conflict" ? ANSWER_VERSION_CONFLICT_SENTENCE : `Not sent: ${code}.`,
    };
  }
  renderAnswer();
}

function render() {
  renderAssignments();
  renderSessions();
  renderContext();
  renderParticipants();
  renderHistory();
  renderComposer();
  renderAnswer();
}

/* --------------------------------------------------------------------- reads */

async function take(slot, run, refuse) {
  const sequence = ++view.sequence[slot];
  view[slot] = { state: "loading", payload: null, refusal: null };
  render();
  try {
    const payload = await run();
    if (sequence !== view.sequence[slot]) return;
    const refusal = refuse(payload);
    view[slot] = { state: "ready", payload: refusal ? null : payload, refusal };
  } catch (error) {
    if (sequence !== view.sequence[slot]) return;
    view[slot] = {
      state: "ready",
      payload: null,
      refusal: String(error?.payload?.error || error?.message || "the read did not answer"),
    };
  }
  render();
}

async function readAll() {
  await Promise.all([
    take("queue", () => client.roomQueue(queueRequest()), refuseRoomQueue),
    take("sessions", () => client.sessionIdentity({}), refuseSessionIdentity),
    take("turns", () => client.roomTurns(turnRequest()), refuseRoomTurns),
    // V5-UX-C13a: the work-item picker's own list. Still lazy — it fires with
    // the rest of this tab's reads, never on page boot.
    take("workItems", () => client.currentWorkRequests(),
      (payload) => (validCurrentWorkRequestsPayload(payload) ? null : "current_work_requests_unavailable")),
  ]);
  announce("The Model Room reads have answered.");
}

function selectHistoryTopic(taskId) {
  view.historyTopicId = taskId ?? "";
  if (view.historyTopicId) {
    view.historyWorkItemId = "";
    view.historyCard = { state: "idle", payload: null, refusal: null };
  }
  render();
}

async function selectHistoryWorkItem(humanRef) {
  view.historyWorkItemId = humanRef ?? "";
  // A different work item means a different card and a different
  // base_version: the answer draft and send state from the last one would be
  // stale evidence for this one, so both are cleared exactly like the
  // composer clears on a successful send.
  view.answer = { answerText: "", evidenceRef: "", scopeConfirmed: false };
  view.answerSend = { state: "idle", message: null };
  if (!view.historyWorkItemId) {
    view.historyCard = { state: "idle", payload: null, refusal: null };
    render();
    return;
  }
  view.historyTopicId = "";
  const args = workRequestCardRequest(view.historyWorkItemId);
  if (!args) {
    view.historyCard = { state: "ready", payload: null, refusal: "work_request_ref_invalid" };
    render();
    return;
  }
  await take("historyCard", () => client.workRequestCard(args), refuseWorkRequestCard);
  announce(`The history for ${view.historyWorkItemId} has answered.`);
}

async function searchSessions(query) {
  const args = dispatchSearchRequest(query);
  if (!args) {
    announce("Enter a session name or canonical ID to search dispatch history.");
    return;
  }
  view.searchQuery = args.query;
  view.selected = null;
  view.dispatch = { state: "idle", payload: null, refusal: null };
  await take("sessions", () => client.sessionIdentity(args), refuseSessionIdentity);
  announce(`The dispatch-history search for ${args.query} has answered.`);
}

async function clearSessionSearch() {
  view.searchQuery = "";
  view.selected = null;
  view.dispatch = { state: "idle", payload: null, refusal: null };
  const input = $("modelRoomDispatchQuery");
  if (input) input.value = "";
  await take("sessions", () => client.sessionIdentity({}), refuseSessionIdentity);
  announce("The full visible session list has been restored.");
}

function selectSession(id) {
  view.selected = id ?? null;
  view.dispatch = { state: "idle", payload: null, refusal: null };
  render();
  if (!id) return;
  readDispatch(id);
}

async function readDispatch(id) {
  view.dispatch = { state: "loading", payload: null, refusal: null };
  renderContext();
  try {
    const payload = await client.dispatchHistory({ session_id: id });
    if (view.selected !== id) return;
    const refusal = refuseDispatchHistory(payload);
    view.dispatch = { state: "ready", payload: refusal ? null : payload, refusal };
  } catch (error) {
    if (view.selected !== id) return;
    view.dispatch = {
      state: "ready",
      payload: null,
      refusal: String(error?.payload?.error || error?.message || "the dispatch read did not answer"),
    };
  }
  renderContext();
}

/* ----------------------------------------------------------------- the mount */

/** Mounted once, on demand. A second call is refused, as mountSessions is. */
export function mountModelRoom({ outage = null } = {}) {
  if (mounted) return;
  mounted = true;
  view.outage = outage;
  // Written from the model so deleting them from the page alone cannot blur
  // room participation into dispatch acknowledgement.
  const room = $("modelRoomQueueRoom");
  if (room) room.textContent = QUEUE_ROOM_SENTENCE;
  const ack = $("modelRoomNoAck");
  if (ack) ack.textContent = ACKNOWLEDGEMENT_SENTENCE;
  $("modelRoomRetry")?.addEventListener("click", () => readAll());
  $("modelRoomQueueRetry")?.addEventListener("click", () => readAll());
  $("modelRoomDispatchSearch")?.addEventListener("submit", (event) => {
    event.preventDefault();
    searchSessions($("modelRoomDispatchQuery")?.value ?? "");
  });
  $("modelRoomDispatchClear")?.addEventListener("click", () => clearSessionSearch());
  // V5-UX-C13a: the topic/work-item history picker. Choosing one clears the
  // other, so the panel below is never asked to render two histories at once.
  $("modelRoomHistoryTopic")?.addEventListener("change", (event) => selectHistoryTopic(event.target.value));
  $("modelRoomHistoryWorkItem")?.addEventListener("change", (event) => selectHistoryWorkItem(event.target.value));
  // V5-UX-C13b: the composer. Typing is kept in `view.composer`; submitting
  // calls `add-room-turn` for real (see submitComposer).
  $("modelRoomComposerText")?.addEventListener("input", (event) => { view.composer.text = event.target.value; });
  $("modelRoomComposerForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitComposer();
  });
  // V5-UX-C13c: the Waiting-for-Joe answer form. Typing is kept in
  // view.answer; submitting calls `answer-work-request-for-joe` for real
  // (see submitAnswer). Re-rendered on every keystroke so the character
  // counter and the submit-ready state stay live.
  $("modelRoomAnswerText")?.addEventListener("input", (event) => {
    view.answer.answerText = event.target.value;
    renderAnswer();
  });
  $("modelRoomAnswerEvidence")?.addEventListener("input", (event) => {
    view.answer.evidenceRef = event.target.value;
    renderAnswer();
  });
  $("modelRoomAnswerScopeConfirmed")?.addEventListener("change", (event) => {
    view.answer.scopeConfirmed = event.target.checked === true;
    renderAnswer();
  });
  $("modelRoomAnswerForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAnswer();
  });
  const location = globalThis.location || { hostname: "", search: "" };
  const resolved = resolveDealroomBoot(location);
  const boot = resolved.mode === "live"
    ? Promise.resolve(createLiveClient())
    : createFixtureClient({ ...resolved.options, ...(outage ? { outage } : {}) });
  Promise.resolve(boot).then((ready) => {
    client = ready;
    return readAll();
  });
}

export { view };
