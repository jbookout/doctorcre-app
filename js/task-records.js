// V5-UX-B02 — Tasks: DOM wiring only.
//
// Every decision about a payload, an argument set or a sentence lives in
// ./task-records-model.js, and every decision about what a command DID lives in
// the shared kernel (./command-feedback.mjs) and its dock. This file reads the
// board, paints it, and turns a click into one command.
//
// Two rules govern the writes here and they are the reason the file is shaped
// this way:
//
//   1. A write is always preceded by a FRESH read of that one record. The
//      loop_id and base_version a command carries come from that read and from
//      nothing else — never from the row on screen, which may be a minute old.
//      The read happens BEFORE performCommand, so the frozen request is the
//      write alone and a reconcile re-sends exactly what was sent.
//   2. Nothing is patched locally afterwards. A settled write re-reads the
//      board, because the record layer is the only thing that knows what the
//      record now holds.

import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountPrefs } from "./shell.js";
import { formatDueStamp, parseQuickAdd } from "./visual-system.js";
import {
  TASK_KINDS, handoverArgs, handoverTarget, loopRefusalMessage, normalizeBoardRow, operationKeys,
  orderTaskRows, partnerName, quickAddPlan, quickAddRecords, scopeRows, taskDetailRows, closeArgs,
  dueDateArgs, validBoardPayload,
} from "./task-records-model.js";
import { uuidv4 } from "./uuid.js";
import { browserDraftStorage, createLocalDrafts, matchingDraftId } from "./local-drafts.mjs";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  scope: "team",
  status: "loading",
  rows: [],
  message: null,
  open: null,
  closing: null,
  sequence: 0,
};

let client = null;
let viewer = "joe";
let localDrafts = createLocalDrafts({ storage: null, viewer: 'unverified' });
let draftViewer = null;
let restoredDraftId = null;
const draftOperations = new Map();
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();

function announce(text) {
  const live = $("taskLive");
  if (live && live.textContent !== text) live.textContent = text;
}

function showToast(text) {
  document.querySelectorAll(".toast").forEach((node) => node.remove());
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = text;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 4100);
}

/* ---------------------------------------------------------------- preferences */
// The three presentation icons are wired by js/shell.js, which owns them for
// every surface and migrates the prototype's legacy storage key.
/* -------------------------------------------------------------------- painting */

function setBoardStatus(state, label) {
  $("taskOrb")?.setAttribute("data-state", state);
  $("taskStatus")?.setAttribute("data-state", state);
  const text = $("taskStatusLabel");
  if (text) text.textContent = label;
}

function rowHtml(row) {
  const target = handoverTarget(row, viewer);
  const due = row.due_on ? formatDueStamp(row.due_on) : "no date recorded";
  const waiting = row.blocker_class && row.blocker_class !== "human_only" && row.blocker_detail
    ? `<span>waiting on <b>${escapeHtml(row.blocker_detail)}</b></span>` : "";
  const handover = target
    ? `<button class="btn btn-secondary" type="button" data-handover="${escapeHtml(row.kind)}:${escapeHtml(row.number)}">Hand over to ${escapeHtml(partnerName(target))}</button>`
    : "";
  return `<li class="work-item" data-priority="${escapeHtml(row.priority || "ordinary")}" data-kind="${escapeHtml(row.kind)}" data-number="${escapeHtml(row.number)}">
    <div>
      <button class="task-open" type="button" data-task="${escapeHtml(row.kind)}:${escapeHtml(row.number)}">
        <h3>${row.marker === "bell" ? '<span class="pin" aria-label="Flagged">★ </span>' : ""}${escapeHtml(row.title)}</h3>
        <div class="work-meta">
          <span>number <b>${escapeHtml(row.number)}</b></span>
          <span>${escapeHtml(row.kind === "team_loop" ? "Team record" : "Personal record")}</span>
          <span>due <b>${escapeHtml(due)}</b></span>
          ${waiting}
        </div>
      </button>
    </div>
    <div class="stack-end">
      <span class="owner"><span class="avatar" data-partner="${escapeHtml(row.owner)}" aria-hidden="true">${escapeHtml(partnerName(row.owner).slice(0, 1))}</span><span>${escapeHtml(partnerName(row.owner))}</span></span>
      ${handover}
    </div>
  </li>`;
}

const STATE_COPY = {
  loading: "Reading the shared record…",
  offline: "The record layer could not be read",
  no_access: "Your session has ended",
  empty: "Every open record is closed",
  no_match: "No open record is owned by you",
};

function renderState(phase) {
  const block = $("taskState");
  if (!block) return;
  block.hidden = phase === "ready";
  block.setAttribute("data-state", phase === "ready" ? "loading" : phase);
  block.innerHTML = phase === "ready" ? "" : `<h3>${escapeHtml(view.message || STATE_COPY[phase] || STATE_COPY.offline)}</h3>`;
}

function render() {
  document.querySelectorAll("#scopeSwitch button[data-scope]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scope === view.scope)));

  const viewerLabel = $("viewerLabel");
  if (viewerLabel) viewerLabel.textContent = `${partnerName(viewer)}’s workspace`;

  if (view.status === "loading") setBoardStatus("refreshing", "Reading the record…");
  else if (view.status === "unauthorized") setBoardStatus("unknown", "Session ended");
  else if (view.status === "error") setBoardStatus("urgent", "Record read unavailable");
  else setBoardStatus("healthy", "Read from the record layer");

  const list = $("taskList");
  const systemBlock = $("systemOwned");
  const systemList = $("systemList");
  const retry = $("retryRead");

  if (view.status !== "ready") {
    if (list) list.innerHTML = "";
    if (systemBlock) systemBlock.hidden = true;
    if (retry) retry.hidden = view.status === "loading";
    renderState(view.status === "loading" ? "loading" : view.status === "unauthorized" ? "no_access" : "offline");
    announce(view.message || STATE_COPY.loading);
    return;
  }

  const { visible, systemOwned } = scopeRows(view.rows, { scope: view.scope, viewer });
  const ordered = orderTaskRows(visible, Date.now());
  if (list) list.innerHTML = ordered.map(rowHtml).join("");
  if (systemBlock && systemList) {
    systemBlock.hidden = view.scope !== "team" || systemOwned.length === 0;
    const count = $("systemCount");
    if (count) count.textContent = `· ${systemOwned.length}`;
    systemList.innerHTML = orderTaskRows(systemOwned, Date.now()).map(rowHtml).join("");
  }
  if (retry) retry.hidden = true;
  const source = $("sourceLine");
  if (source) source.textContent = `Source: loop-board · kinds ${TASK_KINDS.join(" and ")} · status open · ${deploymentIdentity(client?.mode).detail}`;
  const asOf = $("taskAsOf");
  if (asOf) asOf.textContent = `${view.rows.length} open record(s) read`;
  renderState(ordered.length === 0 ? (view.scope === "mine" ? "no_match" : "empty") : "ready");
  announce(`${ordered.length} record(s) shown in the ${view.scope === "mine" ? "Mine" : "Team"} scope.`);
}

/* --------------------------------------------------------------------- reading */

async function load() {
  const sequence = ++view.sequence;
  if (view.status !== "ready") { view.status = "loading"; render(); }
  try {
    const payloads = await Promise.all(TASK_KINDS.map((kind) => client.loopBoard({
      kind, status: "open", limit: 300, summary: false,
    })));
    if (sequence !== view.sequence) return;
    const rows = [];
    for (const payload of payloads) {
      if (!validBoardPayload(payload)) {
        view.status = "error";
        view.message = "The board answered in a shape this page cannot read, so no part of it is shown as a record.";
        render();
        return;
      }
      for (const row of payload.loops) {
        const normalized = normalizeBoardRow(row);
        if (normalized) rows.push(normalized);
      }
    }
    view.rows = rows;
    view.status = "ready";
    view.message = null;
  } catch (error) {
    if (sequence !== view.sequence) return;
    const status = Number(error?.status || 0);
    view.status = status === 401 || status === 403 ? "unauthorized" : "error";
    view.message = view.status === "unauthorized"
      ? "Sign in again to read the shared record. Nothing is shown from a session that has ended."
      : "The shared record could not be read. Nothing here has been inferred.";
  }
  render();
  renderDrafts();
}

/** The fresh read every write is built from. Errors arrive in the payload. */
async function readFresh(row) {
  try {
    const answer = await client.readLoop({ number: row.number, kind: row.kind });
    if (answer?.error) return { error: answer.error, message: loopRefusalMessage(answer.error, { number: row.number }) };
    if (!answer?.loop) return { error: "not_found", message: loopRefusalMessage("not_found", { number: row.number }) };
    return { loop: answer.loop };
  } catch {
    return { error: "unreadable", message: loopRefusalMessage(null) };
  }
}

/* --------------------------------------------------------------------- writing */

/**
 * One command, end to end: re-read, build, freeze, send, report, re-read the
 * board. `build` receives the fresh loop and returns the arguments; `send` is
 * the verb. The dock keeps the operation so a refusal can be tried again from a
 * NEW read, and an unknown outcome can be reconciled from the SAME request.
 */
async function runCommand(row, { operationKey, summary, build, send }) {
  operations.set(operationKey, { row, summary, build, send });
  dock.record(operationKey, { summary, status: "sending", undo: false });
  const fresh = await readFresh(row);
  if (fresh.error) {
    dock.record(operationKey, { summary, state: "refused", reason: fresh.message, undo: false });
    announce(fresh.message);
    return;
  }
  let args;
  try {
    args = build(fresh.loop);
  } catch (error) {
    dock.record(operationKey, { summary, state: "refused", reason: error.message, undo: false });
    announce(error.message);
    return;
  }
  await dispatch(operationKey, args, send, summary);
}

async function dispatch(operationKey, args, send, summary) {
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  const stored = operations.get(operationKey) || {};
  operations.set(operationKey, { ...stored, args, send, summary });
  dock.record(operationKey, {
    summary,
    status: result.status,
    reason: result.message || null,
    retry: result.retry,
    undo: false,
    request: result.request,
  });
  if (result.message) announce(result.message);
  if (result.status === "ok") {
    const draftId = draftOperations.get(operationKey);
    if (draftId) {
      localDrafts.remove(draftId);
      draftOperations.delete(operationKey);
      if (restoredDraftId === draftId) restoredDraftId = null;
      renderDrafts();
    }
    showToast(`${summary} — confirmed`);
    await load();
  } else if (result.status === "conflict" || result.status === "refused") {
    draftOperations.delete(operationKey);
    await load();
  }
  return result;
}

/* ------------------------------------------------------------------- the popup */

function currentRow() {
  return view.rows.find((row) => `${row.kind}:${row.number}` === view.open) || null;
}

function openTask(key) {
  view.open = key;
  view.closing = null;
  const row = currentRow();
  const dialog = $("taskDialog");
  if (!row || !dialog) return;
  const title = $("taskDialogTitle");
  if (title) title.textContent = row.title;
  const eyebrow = $("taskDialogEyebrow");
  if (eyebrow) eyebrow.textContent = row.kind === "team_loop" ? "Team record" : "Personal record";
  const rows = $("taskDialogRows");
  if (rows) {
    rows.innerHTML = taskDetailRows(row, viewer)
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  }
  const due = $("taskDue");
  if (due) due.value = row.due_on || "";
  const target = handoverTarget(row, viewer);
  const handover = $("taskHandover");
  if (handover) {
    handover.hidden = !target;
    handover.textContent = target ? `Hand over to ${partnerName(target)}` : "Hand over";
  }
  const form = $("taskCloseForm");
  if (form) form.hidden = true;
  const outcome = $("taskOutcome");
  if (outcome) outcome.value = "";
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
}

function closeDialog() {
  const dialog = $("taskDialog");
  if (dialog?.open) dialog.close();
  view.open = null;
  view.closing = null;
}

function revealCloseForm(resolution) {
  view.closing = resolution;
  const form = $("taskCloseForm");
  const label = $("taskOutcomeLabel");
  if (label) label.textContent = resolution === "dropped" ? "Why it is being dropped" : "What happened";
  if (form) form.hidden = false;
  $("taskOutcome")?.focus();
}

/* ---------------------------------------------------------------- Quick add */

/**
 * The Related row. One match names the record; more than one names none of
 * them and asks, in the row itself, which one the sentence meant.
 */
function relatedCell(parsed) {
  if (parsed.related) return escapeHtml(parsed.related);
  const candidates = parsed.relatedCandidates || [];
  if (candidates.length > 1) {
    return `Two records match, say which: ${candidates.map((name) => escapeHtml(name)).join(", ")}`;
  }
  return "<i>none</i>";
}

function renderQuickAdd() {
  const input = $("quickAddInput");
  if (!input) return null;
  const sentence = input.value;
  // Quick add matches against the loop titles this page has actually read, so a
  // sentence naming a row on the board resolves Related to that row's title.
  const parsed = parseQuickAdd(sentence, { now: Date.now(), viewer, records: quickAddRecords(view.rows) });
  const picked = $("quickAddDate")?.value || null;
  const effective = picked ? { ...parsed, due: picked, dueLabel: formatDueStamp(picked, parsed.dueTime) } : parsed;
  const preview = $("quickAddParsed");
  if (preview) {
    preview.innerHTML = [
      `<div><span>Action</span>${effective.action ? escapeHtml(effective.action) : "<i>unknown</i>"}</div>`,
      `<div><span>Owner</span>${escapeHtml(partnerName(effective.owner))}${effective.ownerDefaulted ? " <i>(you, by default)</i>" : ""}</div>`,
      `<div><span>Due</span>${effective.due ? escapeHtml(formatDueStamp(effective.due, effective.dueTime)) : "<i>none</i>"}</div>`,
      `<div><span>Related</span>${relatedCell(effective)}</div>`,
    ].join("");
  }
  const plan = quickAddPlan(effective, { viewer, sentence });
  const question = $("quickAddQuestion");
  if (question) {
    question.textContent = plan.args
      ? `${plan.summary} · files as ${plan.kind === "team_loop" ? "a team record" : "a personal record"}`
      : `Keep it as a draft, or answer: ${plan.questions.join(" ")}`;
  }
  return { plan, sentence, parsed: effective };
}

function renderDrafts() {
  const bar = $("draftBar");
  const list = $("draftList");
  if (!bar || !list) return;
  const drafts = localDrafts?.list() || [];
  bar.hidden = drafts.length === 0 || view.status === 'unauthorized';
  bar.querySelector('.chip-label').textContent = draftViewer && localDrafts.isPersisted()
    ? 'Drafts on this device · select to review' : 'Drafts kept on this page only · select to review';
  if (view.status === 'unauthorized') { list.innerHTML = ''; return; }
  list.innerHTML = drafts.map((draft) =>
    `<button class="chip" type="button" data-restore-draft="${escapeHtml(draft.id)}">${escapeHtml(draft.sentence)}${draft.dueDate ? ` · ${escapeHtml(draft.dueDate)}` : ""}</button>`
  ).join("");
}

/* ---------------------------------------------------------------------- wiring */

function wire() {
  $("scopeSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scope]");
    if (!button) return;
    view.scope = button.dataset.scope === "mine" ? "mine" : "team";
    render();
  });

  document.addEventListener("click", (event) => {
    const open = event.target.closest("button[data-task]");
    if (open) { openTask(open.dataset.task); return; }
    const handover = event.target.closest("button[data-handover]");
    if (!handover) return;
    const row = view.rows.find((entry) => `${entry.kind}:${entry.number}` === handover.dataset.handover);
    if (row) handOver(row);
  });

  $("retryRead")?.addEventListener("click", () => load());
  $("taskDialogClose")?.addEventListener("click", closeDialog);
  $("taskDialog")?.addEventListener("close", () => { view.open = null; view.closing = null; });

  $("taskHandover")?.addEventListener("click", () => {
    const row = currentRow();
    if (!row) return;
    closeDialog();
    handOver(row);
  });

  $("taskComplete")?.addEventListener("click", () => revealCloseForm("done"));
  $("taskDrop")?.addEventListener("click", () => revealCloseForm("dropped"));
  $("taskCloseCancel")?.addEventListener("click", () => {
    view.closing = null;
    const form = $("taskCloseForm");
    if (form) form.hidden = true;
  });

  $("taskCloseForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const row = currentRow();
    const resolution = view.closing || "done";
    const outcome = $("taskOutcome")?.value || "";
    if (!row || !outcome.trim()) {
      announce("Type what happened before confirming; the record layer refuses a close without it.");
      return;
    }
    closeDialog();
    runCommand(row, {
      operationKey: operationKeys.close(row),
      summary: `${resolution === "dropped" ? "Drop" : "Complete"} “${row.title}”`,
      build: (loop) => closeArgs(loop, { resolution, outcome }),
      send: (request) => client.closeLoop(request),
    });
  });

  $("taskDue")?.addEventListener("change", (event) => {
    const row = currentRow();
    const day = event.target.value;
    if (!row || !day) return;
    closeDialog();
    runCommand(row, {
      operationKey: operationKeys.due(row),
      summary: `Due date on “${row.title}” → ${formatDueStamp(day)}`,
      build: (loop) => dueDateArgs(loop, day),
      send: (request) => client.updateLoop(request),
    });
  });

  for (const id of ["quickAddInput", "quickAddDate"]) $(id)?.addEventListener("input", renderQuickAdd);
  $("quickAddDate")?.addEventListener("change", renderQuickAdd);

  $("quickAddForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (globalThis.navigator?.onLine === false) {
      announce("Offline. Keep this as a draft on this device; reconnect and review it before saving.");
      return;
    }
    if (!draftViewer) {
      announce("Confirming your account. Keep this as a draft until it is ready.");
      return;
    }
    const current = renderQuickAdd();
    if (!current) return;
    if (!current.plan.args) {
      announce(`Nothing was filed. ${current.plan.questions.join(" ")}`);
      return;
    }
    const operationKey = operationKeys.quickAdd(current.sentence, viewer);
    const matchedId = matchingDraftId(localDrafts.list(), restoredDraftId, current.sentence, $("quickAddDate")?.value || "");
    if (matchedId) draftOperations.set(operationKey, matchedId);
    operations.set(operationKey, { summary: current.plan.summary, send: (request) => client.addLoop(request) });
    const result = await dispatch(operationKey, current.plan.args, (request) => client.addLoop(request), current.plan.summary);
    // A refusal keeps the person's sentence exactly where it is; only an
    // accepted capture clears the input.
    if (result.status === "ok") {
      const input = $("quickAddInput");
      const date = $("quickAddDate");
      if (input) input.value = "";
      if (date) date.value = "";
      renderQuickAdd();
      renderDrafts();
    }
  });

  $("quickAddDraft")?.addEventListener("click", () => {
    const sentence = $("quickAddInput")?.value || "";
    const dueDate = $("quickAddDate")?.value || "";
    const draft = localDrafts?.save(sentence, dueDate);
    if (!draft) { announce("There is nothing to keep as a draft yet."); return; }
    renderDrafts();
    announce(localDrafts.isPersisted()
      ? "Draft saved on this device only. Reconnect and review it before filing."
      : "Draft kept on this page only; this browser could not save it for a reload.");
  });

  $("draftList")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-restore-draft]");
    const draft = localDrafts?.list().find((item) => item.id === button?.dataset.restoreDraft);
    if (!draft) return;
    restoredDraftId = draft.id;
    $("quickAddInput").value = draft.sentence;
    $("quickAddDate").value = draft.dueDate;
    renderQuickAdd();
    $("quickAddInput").focus();
    announce("Draft restored for review. Nothing was sent.");
  });
}

function handOver(row) {
  const target = handoverTarget(row, viewer);
  if (!target) return;
  runCommand(row, {
    operationKey: operationKeys.handover(row),
    summary: `Hand “${row.title}” to ${partnerName(target)}`,
    build: (loop) => handoverArgs(loop, target),
    send: (request) => client.updateLoop(request),
  });
}

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  dock = createCommandDock({
    root,
    // A refusal is settled: the kernel dropped the entry, so this starts over
    // from a FRESH read and a new key, which is the only correct retry.
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.row && entry?.build) runCommand(entry.row, { operationKey, summary: entry.summary, build: entry.build, send: entry.send });
      else if (entry?.args) dispatch(operationKey, entry.args, entry.send, entry.summary);
    },
    // An unknown outcome is reconciled by re-sending the SAME frozen request;
    // the kernel returns the retained one, so the same arguments are passed.
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.send, entry.summary);
    },
    onUndo: null,
  });
  dock.mount();
}

async function loadViewer() {
  try {
    const board = await client.getBoard({ workspace: 'all' });
    if (!board?.actor) return;
    if (board.actor === draftViewer) return;
    const saved = createLocalDrafts({ storage: browserDraftStorage(), viewer: board.actor });
    if (!draftViewer) for (const draft of localDrafts.list()) saved.save(draft.sentence, draft.dueDate);
    localDrafts = saved;
    draftViewer = board.actor;
    restoredDraftId = null;
    viewer = board.actor;
    renderDrafts();
    renderQuickAdd();
    render();
  } catch {
    // A disconnected page can keep drafts in memory until identity is verified.
  }
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  mountDocDock("Tasks");
  mountDock();
  wire();
  renderQuickAdd();
  renderDrafts();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  viewer = client.selfActor || "joe";
  if (client.selfActor) {
    localDrafts = createLocalDrafts({ storage: browserDraftStorage(), viewer });
    draftViewer = viewer;
  }
  window.addEventListener('online', async () => {
    if (!client) return;
    await loadViewer();
    await load();
  });
  renderDrafts();
  await load();
  if (!client.selfActor) await loadViewer();
}

boot();

export { view };
