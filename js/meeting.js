// V5-UX-B11 — the shared Meeting Mode page: DOM wiring only.
//
// Every decision about a payload, a state or a sentence lives in
// ./meeting-model.js; every decision about what a command DID lives in the
// shared kernel (./command-feedback.mjs) and its dock; what this device keeps
// between loads lives in ./meeting-memory.mjs. This file reads, paints and sends.
//
//   1. The meeting is a READ. Notes, actions, the lease and the recap are what
//      `read-meeting` returned; the stream is merged by seq and a reconnect
//      resumes after the last seq held, so nothing is drawn twice.
//   2. Every write goes through performCommand under one operation key per
//      intent per subject. Unanswered entries are persisted, so a reload's
//      "Check outcome" re-sends the SAME request under the SAME key.
//   3. An accepted action is finished by reconciling FIRST
//      (finishAcceptedAction). The canonical call reuses the store's key.
//   4. There is no microphone, recorder or Doc dictation on this page.
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand, settleCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountPrefs } from "./shell.js";
import { formatClock } from "./visual-system.js";
import {
  D03_DEFERRED, DETECTION_UNAVAILABLE, LEASE_RENEW_MS, NO_RECORDING, PROPOSAL_IS_NOT_DONE, STREAM_PAGE,
  actionRows, claimArgs, classifyMeetingReadFailure, clientInstanceFor, decideArgs, decideOperationKey,
  dispatchOperationKey, endArgs, endOperationKey, finishAcceptedAction, finishSentence, followUpCommand,
  joinArgs, joinOperationKey, joinedHere, meetingHeader, meetingRoute, meetingState, mergeStream, noteArgs,
  noteOperationKey, noteRows, outcomeArgs, processingOperationKey, processingOwner, proposeArgs,
  proposeOperationKey, recapView, reconcileOperationKey, releaseOperationKey, reviseNoteOperationKey,
  shouldRenewLease, startArgs, startOperationKey, streamCursor, streamRows, validMeetingPayload,
} from "./meeting-model.js";
import { browserMeetingStorage, createMeetingMemory } from "./meeting-memory.mjs";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const view = {
  route: { state: "missing", id: null, given: null },
  sequence: 0,
  read: { state: "pending" },
  stream: [],
  revising: null,
};

let client = null;
let instance = null;
let memory = null;
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {}, forget: () => {} };
const operations = new Map();
const finishing = new Set();
const storage = browserMeetingStorage();

function announce(text) {
  const live = $("meetingLive");
  if (live && text && live.textContent !== text) live.textContent = text;
}

const payloadOf = () => (view.read.state === "read" ? view.read.payload : null);
const meetingId = () => view.route.id;

/* -------------------------------------------------------------------- painting */

function renderHero() {
  const payload = payloadOf();
  const header = meetingHeader(payload);
  const state = meetingState(view.read, view.route);
  $("meetingAsOf").textContent = view.read.observed_at ? `As of ${formatClock(view.read.observed_at)}` : "unknown";
  $("meetingState").setAttribute("data-state", state.state);
  $("meetingStateTitle").textContent = state.sentence || "";
  $("meetingOrb").setAttribute("data-state", state.state === "ready" ? "healthy"
    : ["refused", "unavailable", "not_found", "malformed", "invalid"].includes(state.state) ? "urgent" : "still");
  if (!header) {
    $("pageTitle").textContent = "Meeting";
    $("meetingId").textContent = view.route.given || "no meeting open";
    $("modeBadge").setAttribute("data-mode", "none");
    $("modeBadge").textContent = view.route.state === "missing" ? "No meeting is open" : "Not read yet";
    $("heroFacts").innerHTML = "";
    return;
  }
  $("pageTitle").textContent = header.title;
  $("meetingId").textContent = header.id;
  $("modeBadge").setAttribute("data-mode", header.ended ? "ended" : "live");
  $("modeBadge").textContent = header.modeWord;
  const facts = [`Started by ${header.startedBy} · ${header.startedClock}`, `Source: ${header.source}`];
  if (header.ended) facts.push(`Ended by ${header.endedBy || "unknown"} · ${header.endedClock}`);
  $("heroFacts").innerHTML = facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("");
}

function renderPresence() {
  const payload = payloadOf();
  const header = meetingHeader(payload);
  $("startBlock").hidden = view.route.state !== "missing";
  for (const id of ["presenceBlock", "actionsBlock", "notesBlock", "recapBlock", "streamBlock"]) $(id).hidden = !header;
  if (!header) return;
  const owner = processingOwner(payload, instance);
  const joined = joinedHere(view.stream, instance);
  $("ownerLine").textContent = owner.sentence;
  $("instanceLine").textContent = `This device is ${instance}${joined ? ", in this meeting" : ", not yet joined"}.`;
  $("joinSave").hidden = header.ended || joined;
  $("claimSave").hidden = header.ended || !joined || !["none", "expired", "released"].includes(owner.state);
  $("releaseSave").hidden = header.ended || owner.state !== "held_here";
  $("endSave").hidden = header.ended;
  $("noteComposer").hidden = header.ended;
  $("actionComposer").hidden = header.ended;
}

function renderNotes() {
  const rows = noteRows(payloadOf());
  $("noteList").innerHTML = rows.map((note) => `<li class="note-item" data-note="${note.number}">
    <div class="item-top"><span class="item-number">Note ${note.number}</span><span>${escapeHtml(note.current.author)} · ${escapeHtml(note.current.clock)}${note.revision > 1 ? ` · revision ${note.revision}` : ""}</span></div>
    <p class="item-body">${escapeHtml(note.current.body)}</p>
    ${note.history.length ? `<details class="item-history"><summary>Earlier revisions (${note.history.length})</summary><ol>${note.history.map((r) => `<li>Revision ${r.revision} · ${escapeHtml(r.author)} · ${escapeHtml(r.clock)}: ${escapeHtml(r.body)}</li>`).join("")}</ol></details>` : ""}
    ${meetingHeader(payloadOf())?.ended ? "" : `<div class="decide-row"><button class="btn" type="button" data-revise-note="${note.number}">Revise this note</button></div>`}
  </li>`).join("");
  const revising = view.revising;
  $("revisingLine").hidden = revising === null;
  $("revisingLine").textContent = revising === null ? "" : `Revising note ${revising}. The earlier text is kept.`;
  $("noteCancelRevise").hidden = revising === null;
  $("noteSave").textContent = revising === null ? "Add note" : `Save revision of note ${revising}`;
  $("draftLine").textContent = memory?.isPersisted()
    ? "Drafts stay on this device until they are saved."
    : "This device cannot keep drafts; save before leaving the page.";
}

function renderActions() {
  const rows = actionRows(payloadOf());
  $("proposalLine").textContent = PROPOSAL_IS_NOT_DONE;
  $("actionList").innerHTML = rows.map((row) => {
    const meta = [`proposed by ${row.proposedBy}`, row.basis === "explicit_instruction" ? "a partner's instruction" : "tentative"];
    if (row.decidedBy) meta.push(`decided by ${row.decidedBy}`);
    if (row.disposition === "delegate" && row.assignee) meta.push(`delegated to ${row.assignee}`);
    const controls = [];
    if (row.controls.confirm) {
      controls.push(`<select aria-label="How to confirm action ${row.number}" data-assignee-for="${row.number}"><option value="">Confirm: do it</option><option value="joe">Confirm: delegate to Joe</option><option value="dell">Confirm: delegate to Dell</option></select>`);
      controls.push(`<button class="btn confirm" type="button" data-decide="accept" data-action="${row.number}">Confirm</button>`);
    }
    if (row.controls.skip) controls.push(`<button class="btn skip-confirm" type="button" data-decide="decline" data-action="${row.number}">Skip</button>`);
    if (row.controls.finish) controls.push(`<button class="btn" type="button" data-finish="${row.number}">Check outcome</button>`);
    const carried = row.controls.finish && !row.controls.appCarriesVerb
      ? `<p class="item-meta">This app does not make ${escapeHtml(row.dispatch.verb)}; the change has to be made and confirmed elsewhere.</p>` : "";
    return `<li class="action-item" data-action="${row.number}" data-tag="${row.tag}">
      <div class="item-top"><span class="item-number">${row.number}</span><span class="item-state">${escapeHtml(row.stateWord)}</span></div>
      <p class="item-body">${escapeHtml(row.summary)}</p>
      ${row.commandLabel ? `<p class="item-meta">${escapeHtml(row.commandLabel)}</p>` : ""}
      <p class="item-meta">${escapeHtml(meta.join(" · "))}${row.revision > 1 ? ` · revision ${row.revision}` : ""}</p>
      ${carried}
      ${row.history.length ? `<details class="item-history"><summary>Earlier revisions (${row.history.length})</summary><ol>${row.history.map((r) => `<li>Revision ${r.revision} · ${escapeHtml(r.by)} · ${escapeHtml(r.clock)}: ${escapeHtml(r.summary)}</li>`).join("")}</ol></details>` : ""}
      ${controls.length ? `<div class="decide-row">${controls.join("")}</div>` : ""}
    </li>`;
  }).join("");
}

function renderRecap() {
  const recap = recapView(payloadOf());
  if (!recap) return;
  $("recapLines").innerHTML = recap.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  $("recapBuckets").innerHTML = recap.buckets.map((bucket) => `<div class="recap-bucket" data-bucket="${bucket.key}">
    <h3>${escapeHtml(bucket.title)} · ${bucket.count}</h3>
    ${bucket.items.length ? `<ul>${bucket.items.map((item) => `<li>${item.number}. ${escapeHtml(item.summary)}${item.assignee && bucket.key === "delegated" ? ` → ${escapeHtml(item.assignee)}` : ""}</li>`).join("")}</ul>` : ""}
  </div>`).join("");
}

function renderStream() {
  $("streamList").innerHTML = streamRows(view.stream).slice(-50).reverse()
    .map((row) => `<li data-seq="${row.seq}"><span><span class="stream-seq">#${row.seq}</span> ${escapeHtml(row.sentence)}</span><span>${escapeHtml(row.clock)}</span></li>`).join("");
}

function render() {
  renderHero();
  renderPresence();
  renderNotes();
  renderActions();
  renderRecap();
  renderStream();
}

/* --------------------------------------------------------------------- reading */

/**
 * One read, paged through the stream from the last seq held. A read that lands
 * after a newer one was issued is discarded.
 */
async function load() {
  if (view.route.state !== "ok") {
    view.read = view.route.state === "malformed" ? { state: "pending" } : { state: "pending" };
    render();
    return;
  }
  view.sequence += 1;
  const sequence = view.sequence;
  try {
    let after = streamCursor(view.stream);
    let payload = null;
    let incoming = [];
    for (let page = 0; page < 20; page += 1) {
      payload = await client.readMeeting({ meeting_id: meetingId(), after_seq: after, limit: STREAM_PAGE });
      if (view.sequence !== sequence) return;
      if (!validMeetingPayload(payload)) break;
      incoming = incoming.concat(payload.stream);
      if (!payload.more) break;
      after = streamCursor(incoming);
    }
    if (!validMeetingPayload(payload)) {
      view.read = { state: "invalid" };
    } else {
      view.stream = mergeStream(view.stream, incoming);
      view.read = { state: "read", payload, observed_at: new Date().toISOString() };
    }
  } catch (error) {
    if (view.sequence !== sequence) return;
    const failure = classifyMeetingReadFailure(error);
    view.read = view.read.state === "read" && failure.state === "unavailable"
      ? { ...view.read, stale: true }
      : { state: failure.state, sentence: failure.sentence };
    if (failure.state === "unavailable") announce(failure.sentence);
  }
  render();
}

/* --------------------------------------------------------------------- writing */

const SENDERS = [
  ["meeting:start:", (r) => client.startMeeting(r)],
  ["meeting:join:", (r) => client.startMeeting(r)],
  ["meeting:processing:", (r) => client.claimMeetingProcessing(r)],
  ["meeting:release:", (r) => client.claimMeetingProcessing(r)],
  ["meeting:note:", (r) => client.addMeetingNote(r)],
  ["meeting:note-revision:", (r) => client.addMeetingNote(r)],
  ["meeting:propose:", (r) => client.proposeMeetingAction(r)],
  ["meeting:decide:", (r) => client.decideMeetingAction(r)],
  ["meeting:reconcile:", (r) => client.recordMeetingActionOutcome(r)],
  ["meeting:dispatch:", (r) => client.dispatchMeetingCommand(r)],
  ["meeting:end:", (r) => client.endMeeting(r)],
];
const senderFor = (operationKey) => SENDERS.find(([prefix]) => operationKey.startsWith(prefix))?.[1] || null;

function setCommands(next) {
  commandState = next;
  memory?.setCommands(next);
}

/** One kernel send. `newKey` is overridden only for a dispatch, whose key the store minted. */
async function send(operationKey, built, summary, { newKey = uuidv4 } = {}) {
  if (!built.ok) {
    announce(built.message);
    dock.record(operationKey, { summary, status: "refused", reason: built.message, undo: false });
    return { status: "refused", message: built.message, response: null };
  }
  const call = senderFor(operationKey);
  dock.record(operationKey, { summary, status: "sending", undo: false });
  const result = await performCommand({
    operationKey, args: built.args,
    getState: () => commandState, setState: setCommands,
    newKey, call: (request) => call(request),
  });
  operations.set(operationKey, { args: built.args, summary, newKey });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announce(result.message);
  return result;
}

async function finish(number) {
  const id = meetingId();
  if (!id || finishing.has(number)) return;
  finishing.add(number);
  try {
    const summary = `Check action ${number} against the record`;
    const outcome = await finishAcceptedAction({
      reconcile: () => send(reconcileOperationKey(id, number), outcomeArgs(id, number, instance), summary),
      dispatch: (retry) => send(dispatchOperationKey(id, number), { ok: true, args: { verb: retry.verb, args: retry.args } },
        `Make the change action ${number} names`, { newKey: () => retry.idempotency_key }),
    });
    if (outcome.stage === "reconciled") {
      // A dispatch left unknown by a lost answer is settled by the record's own
      // evidence, not by re-sending it.
      const op = dispatchOperationKey(id, number);
      if (commandState[op]) {
        setCommands(settleCommand(commandState, op, { status: "ok" }));
        dock.record(op, { status: "ok", undo: false });
      }
    }
    announce(finishSentence(outcome, number));
  } finally {
    finishing.delete(number);
  }
  await load();
}

async function start() {
  const drafts = memory.drafts();
  const built = startArgs({ title: $("startTitleInput").value, instance, newId: uuidv4 });
  const result = await send(startOperationKey(drafts.titleId), built, `Start "${built.args?.title || ""}"`);
  if (result.status !== "ok" || !result.response?.meeting_id) return;
  memory.clearDraft("title");
  await openMeeting(result.response.meeting_id);
  await claim();
}

async function join() {
  const built = joinArgs(payloadOf(), instance);
  const result = await send(joinOperationKey(meetingId()), built, "Join this meeting on this device");
  if (result.status !== "ok") return;
  await load();
  await claim();
}

async function claim() {
  const result = await send(processingOperationKey(meetingId()), claimArgs(meetingId(), instance), "Hold processing on this device");
  if (result.status === "ok" && result.response?.decision === "held_by_other") {
    announce(`Processing is held by ${result.response.lease?.holder} on ${result.response.lease?.holder_instance}. This device joined as a participant.`);
  }
  await load();
}

async function release() {
  await send(releaseOperationKey(meetingId()), claimArgs(meetingId(), instance, { release: true }), "Release processing");
  await load();
}

async function saveNote() {
  const drafts = memory.drafts();
  const revising = view.revising;
  const built = noteArgs(payloadOf(), { body: $("noteInput").value, instance, revises: revising });
  const operationKey = revising === null
    ? noteOperationKey(meetingId(), drafts.noteId)
    : reviseNoteOperationKey(meetingId(), revising, built.args?.base_revision);
  const result = await send(operationKey, built, revising === null ? "Add a note" : `Revise note ${revising}`);
  if (result.status === "ok") {
    memory.clearDraft("note");
    $("noteInput").value = "";
    view.revising = null;
  }
  // A conflict re-reads; the words stay in the box for the partner to decide.
  if (result.status === "ok" || result.status === "refused" || result.status === "conflict") await load();
}

async function propose(basis) {
  const drafts = memory.drafts();
  const followUp = $("followUpInput").value;
  const owner = $("ownerInput").value;
  const command = followUp.trim() || owner ? followUpCommand({ title: followUp, owner }) : null;
  if ((followUp.trim() || owner) && !command) {
    announce("A follow-up needs a task title and an owner. Nothing was sent.");
    return;
  }
  const built = proposeArgs(payloadOf(), { summary: $("actionInput").value, basis, command, instance });
  const result = await send(proposeOperationKey(meetingId(), drafts.actionId), built,
    basis === "explicit_instruction" ? "Instruct: do it now" : "Propose an action");
  if (result.status === "ok") {
    memory.clearDraft("action");
    $("actionInput").value = "";
    $("followUpInput").value = "";
    $("ownerInput").value = "";
  }
  await load();
  const action = result.response?.action;
  if (result.status === "ok" && action?.state === "accepted" && action.dispatch) await finish(action.action_number);
}

async function decide(number, decision) {
  const assignee = decision === "accept" ? (document.querySelector(`[data-assignee-for="${number}"]`)?.value || null) : null;
  const built = decideArgs(payloadOf(), number, decision, instance, { assignee });
  const result = await send(decideOperationKey(meetingId(), number), built,
    decision === "accept" ? `Confirm action ${number} (a decision; the change follows)` : `Skip action ${number}`);
  await load();
  const action = result.response?.action;
  if (result.status === "ok" && action?.state === "accepted" && action.dispatch) await finish(number);
}

async function end() {
  await send(endOperationKey(meetingId()), endArgs(meetingId(), instance), "End the meeting");
  await load();
}

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  const again = (operationKey) => {
    // Finishing an action always reconciles first, whichever step was left open.
    const finishMatch = /^meeting:(?:reconcile|dispatch):[^:]+:(\d+)$/.exec(operationKey);
    if (finishMatch) return finish(Number(finishMatch[1]));
    const entry = operations.get(operationKey);
    if (entry?.args) send(operationKey, { ok: true, args: entry.args }, entry.summary, { newKey: entry.newKey }).then(() => load());
    return null;
  };
  dock = createCommandDock({ root, onDispatch: again, onReconcile: again, onUndo: null });
  dock.mount();
}

/** Restored unanswered commands keep their frozen requests and offer Check outcome. */
function restoreCommands() {
  commandState = memory.commands();
  for (const [operationKey, entry] of Object.entries(commandState)) {
    const { idempotency_key: _key, ...args } = entry.request;
    operations.set(operationKey, { args, summary: "An earlier change from this device, not yet confirmed", newKey: () => entry.request.idempotency_key });
    dock.record(operationKey, { summary: "An earlier change from this device, not yet confirmed", status: "unknown", undo: false, request: entry.request });
  }
}

async function openMeeting(id) {
  view.route = meetingRoute(`?id=${id}`);
  view.read = { state: "pending" };
  view.stream = [];
  memory = createMeetingMemory({ storage, scope: id, newId: uuidv4 });
  restoreCommands();
  fillDrafts();
  try {
    globalThis.history?.pushState?.({ id }, "", `/meeting?id=${id}`);
  } catch { /* the address bar lags; the page does not */ }
  await load();
}

function fillDrafts() {
  const drafts = memory.drafts();
  $("startTitleInput").value = drafts.title;
  $("noteInput").value = drafts.note;
  $("actionInput").value = drafts.action;
  $("followUpInput").value = drafts.followUp;
  $("ownerInput").value = drafts.owner;
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  mountDock();
  $("noRecordingLine").textContent = NO_RECORDING;
  $("detectionLine").textContent = DETECTION_UNAVAILABLE;
  $("d03Line").textContent = D03_DEFERRED;
  instance = clientInstanceFor(storage, uuidv4);
  const location = globalThis.location || { hostname: "", search: "" };
  const params = new URLSearchParams(location.search || "");
  view.route = meetingRoute(location.search || "");
  memory = createMeetingMemory({ storage, scope: view.route.id || "start", newId: uuidv4 });
  restoreCommands();
  fillDrafts();

  $("retryRead")?.addEventListener("click", () => load());
  $("startSave")?.addEventListener("click", () => start());
  $("joinSave")?.addEventListener("click", () => join());
  $("claimSave")?.addEventListener("click", () => claim());
  $("releaseSave")?.addEventListener("click", () => release());
  $("endSave")?.addEventListener("click", () => end());
  $("noteSave")?.addEventListener("click", () => saveNote());
  $("noteCancelRevise")?.addEventListener("click", () => { view.revising = null; render(); });
  $("proposeSave")?.addEventListener("click", () => propose("tentative_discussion"));
  $("instructSave")?.addEventListener("click", () => propose("explicit_instruction"));
  // Every keystroke is kept on this device, so a reload or a dropped
  // connection gives the words back.
  $("startTitleInput")?.addEventListener("input", (e) => memory.setDraft({ title: e.target.value }));
  $("noteInput")?.addEventListener("input", (e) => memory.setDraft({ note: e.target.value }));
  $("actionInput")?.addEventListener("input", (e) => memory.setDraft({ action: e.target.value }));
  $("followUpInput")?.addEventListener("input", (e) => memory.setDraft({ followUp: e.target.value }));
  $("ownerInput")?.addEventListener("change", (e) => memory.setDraft({ owner: e.target.value }));
  $("noteList")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-revise-note]") : null;
    if (!target) return;
    const number = Number(target.getAttribute("data-revise-note"));
    const row = noteRows(payloadOf()).find((note) => note.number === number);
    if (!row) return;
    view.revising = number;
    if (!$("noteInput").value.trim()) {
      $("noteInput").value = row.current.body;
      memory.setDraft({ note: row.current.body });
    }
    render();
  });
  $("actionList")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-decide],[data-finish]") : null;
    if (!target) return;
    if (target.hasAttribute("data-finish")) finish(Number(target.getAttribute("data-finish")));
    else decide(Number(target.getAttribute("data-action")), target.getAttribute("data-decide"));
  });
  globalThis.addEventListener?.("popstate", () => {
    view.route = meetingRoute(globalThis.location?.search || "");
    view.stream = [];
    load();
  });
  // Reconnect: read again from the last seq held. Nothing is re-sent for you.
  globalThis.addEventListener?.("online", () => load());

  const boot_ = resolveDealroomBoot(location);
  const outage = params.get("outage");
  client = boot_.mode === "live"
    ? createLiveClient()
    : await createFixtureClient({ ...boot_.options, ...(outage ? { outage } : {}) });
  await load();

  setInterval(() => {
    if (document.visibilityState === "hidden" || view.route.state !== "ok") return;
    load();
  }, 5000);
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    if (shouldRenewLease(payloadOf(), instance)) claim();
  }, LEASE_RENEW_MS);
}

boot();

export { view };
