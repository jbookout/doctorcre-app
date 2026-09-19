// V5-UX-C12 — the Model Room tab: DOM wiring only.
//
// Every decision about a payload is in ./model-room-model.js. This file reads,
// paints, and does nothing else. It writes nothing: all four verbs on this
// surface are reads, none carries an idempotency key, and none names an actor,
// a sponsor or a tenant.
//
// The reads are LAZY, like the Atlas and Sessions tabs: they fire on the first
// selection of this tab, never on page boot, so the Control Room's four
// dashboard reads keep their time-to-glance. Nothing polls: one read per panel
// per visit, plus the explicit "Read again" control the other tabs carry.
//
// THERE IS NO OPEN CONTROL IN THIS FILE, in any branch, and no element claims a
// session was acknowledged or unacknowledged. Search it: `open` appears only as
// `contextPanel().open`, false everywhere, and as the <details> that reveals
// dispatch already read. The two sentences that say why are written from the
// model, so deleting them from the page cannot leave a tab that quietly implies
// otherwise.
import {
  NO_ACKNOWLEDGEMENT_SENTENCE, NO_DISPATCH_SEARCH_SENTENCE, NO_OPEN_SENTENCE,
  QUEUE_ROOM_SENTENCE, UNPROVABLE_STAGES_SENTENCE,
  assignmentBoard, contextPanel, countsLine, dispatchView, listState, participants,
  queueFreshness, queueRequest, refuseDispatchHistory, refuseRoomQueue, refuseRoomTurns,
  refuseSessionIdentity, sessionCards, turnRequest, turnWindow,
} from "./model-room-model.js";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { formatClock } from "./visual-system.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

let mounted = false;
let client = null;

const view = {
  outage: null,
  /** One counter per slot: three reads run together and must not cancel each other. */
  sequence: { queue: 0, sessions: 0, turns: 0 },
  status: "idle",
  queue: { state: "idle", payload: null, refusal: null },
  sessions: { state: "idle", payload: null, refusal: null },
  turns: { state: "idle", payload: null, refusal: null },
  /** canonical_session_id of the selected card; null until one is chosen. */
  selected: null,
  dispatch: { state: "idle", payload: null, refusal: null },
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
  list.innerHTML = board.cards.map((card) => `<article class="card glass assignment-card" data-task="${escapeHtml(card.taskId)}" data-status="${escapeHtml(card.status)}">
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
    <span data-stage="acted">acted: recorded per event</span>
  </p>
  <p class="dispatch-honesty">${escapeHtml(UNPROVABLE_STAGES_SENTENCE)}</p>
  <p class="dispatch-honesty">${escapeHtml(NO_DISPATCH_SEARCH_SENTENCE)}</p>`;
  if (view.dispatch.state === "loading") return `${stages}<p class="small">Taking the dispatch read…</p>`;
  if (view.dispatch.refusal) {
    return `${stages}<p class="small">The dispatch read could not be rendered: ${escapeHtml(view.dispatch.refusal)}.</p>`;
  }
  if (!view.dispatch.payload) return stages;
  const drawer = dispatchView(view.dispatch.payload);
  const empty = drawer.emptySentence ? `<p class="dispatch-empty">${escapeHtml(drawer.emptySentence)}</p>` : "";
  const events = drawer.events.map((event) => `<li class="dispatch-event" data-stage="${escapeHtml(event.stage)}">
    <p class="dispatch-when">${escapeHtml(event.stage)} · ${escapeHtml(clock(event.at))}</p>
    <p class="dispatch-evidence">${escapeHtml(event.evidence ?? "no evidence recorded")}</p>
    ${event.rationale ? `<p class="dispatch-rationale">${escapeHtml(event.rationale)}</p>` : ""}
  </li>`).join("");
  return `${stages}${empty}<ul class="dispatch-list">${events}</ul>`;
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

function render() {
  renderAssignments();
  renderSessions();
  renderContext();
  renderParticipants();
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
  ]);
  announce("The Model Room reads have answered.");
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
  // Written from the model so deleting them from the page alone cannot leave a
  // tab that implies it opens sessions or knows about acknowledgment.
  const room = $("modelRoomQueueRoom");
  if (room) room.textContent = QUEUE_ROOM_SENTENCE;
  const ack = $("modelRoomNoAck");
  if (ack) ack.textContent = NO_ACKNOWLEDGEMENT_SENTENCE;
  $("modelRoomRetry")?.addEventListener("click", () => readAll());
  $("modelRoomQueueRetry")?.addEventListener("click", () => readAll());
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
