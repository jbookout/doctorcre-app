// Wiring for the V5-UX-S01 prototype pages. Synthetic fixtures only: nothing
// here reaches CARR, the network or a real record. The page attribute
// data-prototype names which surface to wire; the pure decisions live in
// visual-system.js so they can be tested without a browser.
//
// The 2026-09-16 review set the information design this file implements:
// tabs and popups instead of one long scroll, tiles that list their actual
// items, one floating Doc, drag-and-drop with a keyboard equivalent, AM/PM
// times everywhere, calendar pickers for dates, and titles with no
// description paragraph under them.
import {
  contrastRatio, formatCalendarDate, formatClock,
  formatDueStamp, orderWork, parseQuickAdd, preferenceAttributes,
  resolvePreferences, weekdayName,
} from "./visual-system.js";
import { createCommandState, feedbackStateFor, performCommand } from "./command-feedback.mjs";
import { createCommandDock } from "./command-dock.js";
import { mountDocDock } from "./doc-dock.js";

const PREFS_KEY = "doctorcre.presentation.v1";
const VIEWER = "joe";
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

// ---------------------------------------------------------------- preferences
// Each preference is ONE icon button. Filled (aria-pressed=true) is on, hollow
// is off; the only words are the accessible label and the tooltip.
function readStoredPreferences() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
}
function storePreferences(preferences) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); } catch { /* storage is a convenience, never a requirement */ }
}
function systemPreferences() {
  return { prefersReducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches };
}
const PREF_WORDS = {
  theme: { light: "Light theme", dark: "Dark theme" },
  density: { compact: "Compact density", comfortable: "Comfortable density" },
  motion: { reduced: "Motion paused", full: "Motion on" },
};
export function applyPreferences(preferences) {
  for (const [name, value] of Object.entries(preferenceAttributes(preferences))) document.documentElement.setAttribute(name, value);
  document.querySelectorAll("button[data-pref][data-on]").forEach((button) => {
    const key = button.dataset.pref;
    const on = preferences[key] === button.dataset.on;
    button.setAttribute("aria-pressed", String(on));
    const words = `${PREF_WORDS[key][preferences[key]]}. Switch to ${PREF_WORDS[key][on ? button.dataset.off : button.dataset.on].toLowerCase()}.`;
    button.setAttribute("aria-label", words);
    button.setAttribute("title", words);
  });
  const live = $("prefsLive");
  if (live) live.textContent = `${PREF_WORDS.theme[preferences.theme]}, ${PREF_WORDS.density[preferences.density]}, ${PREF_WORDS.motion[preferences.motion]}.`;
}
function wirePreferences() {
  let current = resolvePreferences(readStoredPreferences(), systemPreferences());
  applyPreferences(current);
  document.querySelectorAll("button[data-pref][data-on]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.pref;
    const next = current[key] === button.dataset.on ? button.dataset.off : button.dataset.on;
    current = resolvePreferences({ ...current, [key]: next }, systemPreferences());
    storePreferences(current);
    applyPreferences(current);
  }));
}

// ---------------------------------------------------------------- tabs
// One screen at a time. A "go to" link elsewhere on the page switches tabs
// instead of scrolling; links to another surface open in a new browser tab.
function wireTabs(listId) {
  const strip = $(listId);
  if (!strip) return null;
  const tabs = [...strip.querySelectorAll('[role="tab"]')];
  const select = (tab, focus = true) => {
    for (const candidate of tabs) {
      const chosen = candidate === tab;
      candidate.setAttribute("aria-selected", String(chosen));
      candidate.tabIndex = chosen ? 0 : -1;
      const panel = $(candidate.getAttribute("aria-controls"));
      if (panel) panel.hidden = !chosen;
    }
    if (focus) tab.focus();
  };
  strip.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) select(tab);
  });
  strip.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step) { event.preventDefault(); select(tabs[(index + step + tabs.length) % tabs.length]); }
    if (event.key === "Home") { event.preventDefault(); select(tabs[0]); }
    if (event.key === "End") { event.preventDefault(); select(tabs[tabs.length - 1]); }
  });
  select(tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || tabs[0], false);
  // Any in-page link that names a tab switches to it rather than scrolling.
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-tab]");
    if (!link) return;
    const tab = $(link.dataset.tab);
    if (!tab) return;
    event.preventDefault();
    select(tab);
    document.querySelectorAll(".mobile-nav a").forEach((item) => item.toggleAttribute("aria-current", item === link));
    if (link.hasAttribute("aria-current")) link.setAttribute("aria-current", "page");
  });
  return { select: (id) => { const tab = $(id); if (tab) select(tab); } };
}

// ---------------------------------------------------------------- popups
// One detail dialog per page. A read opens it nonmodal; a popup that asks for
// input opens it modal. Either way focus returns to what opened it.
let detailOpener = null;
function openDetail({ eyebrow = "Detail", title, rows = [], body = [], form = null, links = [] }, trigger) {
  const dialog = $("detailDialog");
  if (!dialog) return;
  detailOpener = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  $("detailEyebrow").textContent = eyebrow;
  $("detailTitle").textContent = title;
  const children = [];
  if (rows.length) children.push(el("dl", { class: "detail-list" }, rows.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", { text: value })])));
  children.push(...[].concat(body));
  if (form) children.push(form);
  if (links.length) children.push(el("p", { class: "dialog-links" }, links.map(([text, href]) => el("a", { class: "btn btn-quiet", href, target: "_blank", rel: "noopener", text: `${text} (new tab)` }))));
  $("detailBody").replaceChildren(...children);
  if (dialog.open) dialog.close();
  if (form) dialog.showModal(); else dialog.show();
  (dialog.querySelector("input, select, textarea, button") || $("detailClose")).focus();
}
function wireDetailDialog() {
  const dialog = $("detailDialog");
  if (!dialog) return;
  $("detailClose")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { detailOpener?.focus(); detailOpener = null; });
  dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") dialog.close(); });
}

// ---------------------------------------------------------------- toast
// Shows briefly, then is fully gone. With motion reduced it simply disappears.
function showToast(text) {
  document.querySelectorAll(".toast").forEach((node) => node.remove());
  const toast = el("div", { class: "toast", role: "status" }, [el("span", { class: "orb", "data-state": "healthy", "aria-hidden": "true" }), document.createTextNode(text)]);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 4100);
}

// ---------------------------------------------------------------- command feedback
// The prototype runs the REAL kernel (command-feedback.mjs) against a simulated
// transport, so what a reviewer sees on these pages is the product's own
// behaviour: one key per logical operation, a double click that sends nothing,
// an unknown outcome that is reconciled by re-sending the frozen request rather
// than by guessing, and a refusal that keeps the person's input.
const feedbackDock = () => $("receiptDock");
const SIMULATED_ROUND_TRIP = 700;
let commandState = createCommandState();
let mintedKeys = 0;
let simulatedEvents = 0;
// What each operation is called on screen. The kernel holds the requests; this
// holds the words, which is the one thing it has no opinion about.
const commandSummaries = new Map();

let dock = { record: () => {}, render: () => {}, mount: () => {} };

function mountCommandDock() {
  const root = feedbackDock();
  if (!root) return;
  dock = createCommandDock({
    root,
    onDispatch: (operationKey) => runCommand(operationKey, { outcome: outcomeChoice() }),
    onReconcile: (operationKey) => runCommand(operationKey, { replay: true }),
    onUndo: (operationKey) => {
      const entry = commandSummaries.get(operationKey);
      dock.record(operationKey, { summary: entry?.summary || "", status: "undone" });
      document.dispatchEvent(new CustomEvent("prototype:undone", { detail: { operationId: operationKey, state: "undone" } }));
    },
  });
  dock.mount();
}

/**
 * The simulated record layer. `confirm` accepts and names the event it
 * committed; `refuse` answers with a stale-version refusal, which the kernel
 * reads as a conflict; `timeout` throws with no status and no payload, which is
 * the only honest shape for "nothing came back". A reconcile resolves as a
 * replay, which is what a re-send under a spent key really returns.
 */
function simulatedCall(outcome, { replay = false } = {}) {
  return () => new Promise((resolve, reject) => setTimeout(() => {
    if (replay) { resolve({ ok: true, replayed: true, event_id: `sim-${++simulatedEvents}` }); return; }
    if (outcome === "refuse") {
      const refusal = new Error("prototype: the change was refused");
      refusal.payload = { error: "version_conflict", hint: "Stale version: Dell changed this card 40 seconds ago. Your input is kept." };
      reject(refusal);
      return;
    }
    if (outcome === "timeout") { reject(new Error("prototype: nothing came back")); return; }
    resolve({ ok: true, event_id: `sim-${++simulatedEvents}` });
  }, SIMULATED_ROUND_TRIP));
}

async function runCommand(operationKey, { outcome = "confirm", replay = false } = {}) {
  const entry = commandSummaries.get(operationKey);
  if (!entry) return null;
  const reconciling = Boolean(commandState[operationKey]);
  const result = await performCommand({
    operationKey, args: entry.args,
    getState: () => commandState,
    setState: (next) => {
      commandState = next;
      // The claim is published before the request is awaited, so the badge is
      // on screen for the round trip and a second click sees it.
      if (next[operationKey]?.status === "pending") {
        dock.record(operationKey, { summary: entry.summary, status: "sending", retry: reconciling, undo: entry.undo });
      }
    },
    newKey: () => `sim-key-${++mintedKeys}`,
    call: simulatedCall(outcome, { replay }),
  });
  if (!result.started) return result;
  dock.record(operationKey, {
    summary: entry.summary, status: result.status,
    reason: result.hint || result.message, retry: result.retry, undo: entry.undo,
    request: result.request,
  });
  const state = feedbackStateFor({ status: result.status });
  document.dispatchEvent(new CustomEvent("prototype:settled", {
    detail: { operationId: operationKey, state, reason: result.reason, summary: entry.summary },
  }));
  return result;
}

/**
 * Every call site names its operation and what it is called. The operation id
 * IS the operation key; the idempotency key is minted by the kernel and shown
 * on the receipt when there is no reason to show instead.
 */
export function dispatchCommand(operationId, summary, outcome = "confirm") {
  commandSummaries.set(operationId, {
    summary,
    // The arguments this operation is defined by. Stable across every attempt,
    // which is what lets a retry be the same operation instead of a new one.
    args: commandSummaries.get(operationId)?.args || { operation: operationId, summary },
    undo: true,
  });
  return runCommand(operationId, { outcome });
}

const outcomeChoice = () => $("outcomeSimulator")?.value || "confirm";

// ---------------------------------------------------------------- business fixtures
const TODAY = "2026-09-16T14:00:00Z";
const STATUS_WORDS = { todo: "To do", in_progress: "In progress", waiting: "Waiting", done: "Done" };
const WORK = [
  { id: "t1", action: "Send LOI redline to landlord counsel", record: "Demo Gulf Breeze Dental", owner: "joe", contact: "Demo Dr. Avery", due: "2026-09-15", dueTime: "5:00 PM", status: "in_progress", ask: "What did counsel come back with?" },
  { id: "t2", action: "Confirm survey window with vendor", record: "Demo Pace Pediatrics", owner: "dell", contact: "Demo Dr. Okafor", due: "2026-09-18", dueTime: "10:00 AM", status: "waiting", waitingOn: "Demo Coastal Surveying", followUp: "2026-09-17", followUpTime: "2:00 PM", ask: "Which window did the vendor offer?" },
  { id: "t3", action: "Assemble information request for the practice CPA", record: "Demo Navarre Ortho", owner: "joe", contact: "Demo Dr. Lin", blocked: true, blockedOn: "signed ETL", status: "todo", ask: "What is still missing from the request?" },
  { id: "t4", action: "Research exhibitor list and pricing", record: "Demo Regional Health Summit (event)", owner: "dell", contact: "—", due: "2026-10-02", dueTime: "9:00 AM", status: "todo", ask: "What did the exhibitor sheet say?" },
  { id: "t5", action: "Property search refresh: 4,000–6,000 sf medical", record: "Demo Milton Family Care", owner: "joe", contact: "Demo Dr. Reyes", due: "2026-09-20", dueTime: "4:30 PM", status: "todo", pinned: true, ask: "Which buildings made the short list?" },
];
const CHANGES = [
  { id: "ch1", who: "Dell", what: "Moved Demo Crestview Derm to Engaged", at: "11:20 AM", detail: "The phase moved from Warm prospect to Engaged on a signed ETL uploaded the same morning.", record: "Demo Crestview Derm" },
  { id: "ch2", who: "Doc", what: "Polished the note on Demo Pace Pediatrics", at: "10:04 AM", detail: "Wording only. The dates, parties and amounts were not touched, and the previous version is kept.", record: "Demo Pace Pediatrics" },
  { id: "ch3", who: "Joe", what: "Handed the survey window to Dell", at: "9:41 AM", detail: "Ownership of the survey-window follow-up moved from Joe to Dell. The due date did not change.", record: "Demo Pace Pediatrics" },
];
const WAITING = [
  { id: "w1", label: "Waiting on: Demo Crestview landlord", what: "Counter due Thu 2:00 PM", detail: "The counter on the base rent was promised for Thursday at 2:00 PM. Dell sent the reminder Tuesday 9:15 AM.", owner: "dell" },
  { id: "w2", label: "Waiting on: Demo Coastal Surveying", what: "Survey window, follow up Thu 2:00 PM", detail: "Two windows were requested. Nothing has come back since Monday 9:12 AM.", owner: "dell" },
];
const DOC_HISTORY = [
  { id: "d1", title: "Crestview counter, what to ask for", at: "Wed, Sep 16, 2026 · 11:32 AM", detail: "Three questions for the landlord and the two numbers that decide the answer." },
  { id: "d2", title: "Gulf Breeze redline, plain-language summary", at: "Tue, Sep 15, 2026 · 4:12 PM", detail: "What changed in the redline, in the order it matters to the practice." },
  { id: "d3", title: "Pace Pediatrics survey window", at: "Mon, Sep 14, 2026 · 8:58 AM", detail: "Who to chase and when, with the vendor's last answer quoted." },
];
const PHASES = ["Warm prospect", "Engaged", "Search", "LOI", "Lease", "Closed"];
const CARDS = [
  { id: "c1", name: "Demo Gulf Breeze Dental", kind: "client", phase: "LOI", owner: "joe" },
  { id: "c2", name: "Demo Pace Pediatrics", kind: "client", phase: "Search", owner: "dell" },
  { id: "c3", name: "Demo Navarre Ortho", kind: "prospect", phase: "Warm prospect", owner: "joe" },
  { id: "c4", name: "Demo Milton Family Care", kind: "client", phase: "Search", owner: "joe" },
  { id: "c5", name: "Demo Crestview Derm", kind: "prospect", phase: "Engaged", owner: "dell" },
];
const EVIDENCE_NEEDED = { Engaged: "a signed ETL or accepted equivalent", Lease: "the selected winning lease LOI" };
const boardFilter = new Set(["prospect", "client"]);
let phaseFocus = null;

function partnerAvatar(owner) {
  return el("span", { class: "owner" }, [el("span", { class: "avatar", "data-partner": owner, "aria-hidden": "true", text: owner === "joe" ? "J" : "D" }), el("span", { text: owner === "joe" ? "Joe" : "Dell" })]);
}
const dueText = (item) => (item.due ? formatDueStamp(item.due, item.dueTime) : "no date recorded");

// A tile row is a button; it opens the item's popup.
const tileRow = (id, title, meta, trailing) => el("li", {}, [
  el("button", { class: "tile-row", type: "button", "data-item": id }, [
    el("span", { text: title }),
    trailing ? el("b", { text: trailing }) : el("b", { text: "" }),
    meta ? el("em", { text: meta }) : null,
  ]),
]);

function renderHome() {
  const title = $("homeTitle");
  if (title) title.textContent = `${weekdayName(TODAY)} · Priority Items`;
  const asOf = $("homeAsOf");
  if (asOf) asOf.textContent = `As of ${formatClock(TODAY)} · source CARR`;
  const pipeAsOf = $("pipeAsOf");
  if (pipeAsOf) pipeAsOf.textContent = `as of ${formatClock(TODAY)}`;

  const today = orderWork(WORK.filter((item) => item.priority !== "ordinary" || item.due), TODAY)
    .filter((item) => item.priority !== "ordinary").slice(0, 4);
  $("todayList")?.replaceChildren(...today.map((item) => tileRow(item.id, item.action, `for ${item.record}`, dueText(item))));
  $("todayTitle") && ($("todayTitle").textContent = `${today.length} actions, ${today.filter((i) => i.priority === "overdue").length} overdue`);

  $("changeList")?.replaceChildren(...CHANGES.map((change) => tileRow(change.id, change.what, change.who, change.at)));
  $("changedTitle") && ($("changedTitle").textContent = `${CHANGES.length} changes`);

  $("waitingList")?.replaceChildren(...WAITING.map((item) => tileRow(item.id, item.label, item.what, null)));
  $("waitingTitle") && ($("waitingTitle").textContent = `${WAITING.length} waiting`);

  const counts = PHASES.map((phase) => [phase, CARDS.filter((card) => card.phase === phase).length]).filter(([, count]) => count > 0);
  $("phaseList")?.replaceChildren(...counts.map(([phase, count]) => tileRow(`phase:${phase}`, phase, null, `${count}`)));
  $("pipeTitle") && ($("pipeTitle").textContent = `${CARDS.length} assignments`);

  $("docHistoryList")?.replaceChildren(...DOC_HISTORY.map((entry) => tileRow(entry.id, entry.title, null, entry.at)));
}

function answerForm(item) {
  const form = el("form", { class: "field-grid", id: "answerForm", "data-answer": item.id });
  form.append(
    el("div", { class: "field" }, [el("label", { for: "answerText", text: item.ask || "Your answer" }), el("input", { id: "answerText", type: "text", autocomplete: "off", placeholder: "Type what happened" })]),
    el("div", { class: "field" }, [el("label", { for: "answerDate", text: "Effective date" }), el("input", { id: "answerDate", type: "date", value: item.due || "" })]),
    el("div", { class: "row-wrap", style: "grid-column:1/-1" }, [el("button", { class: "btn btn-primary", type: "submit", text: "Save answer" }), el("button", { class: "btn btn-quiet", type: "button", "data-close-detail": true, text: "Cancel" })]),
  );
  return form;
}

function openWorkItem(item, trigger) {
  openDetail({
    eyebrow: "Needs action today",
    title: item.action,
    rows: [
      ["Record", item.record],
      ["Owner", item.owner === "joe" ? "Joe" : "Dell"],
      ["Due", dueText(item)],
      ["Status", STATUS_WORDS[item.status]],
      ["Contact", item.contact],
      item.blocked ? ["Blocked on", item.blockedOn] : null,
      item.waitingOn ? ["Waiting on", `${item.waitingOn}, follow up ${formatDueStamp(item.followUp, item.followUpTime)}`] : null,
    ].filter(Boolean),
    form: answerForm(item),
  }, trigger);
}
function openChange(change, trigger) {
  openDetail({
    eyebrow: "Change",
    title: change.what,
    rows: [["Who", change.who], ["When", change.at], ["Record", change.record], ["What it means", change.detail]],
    links: [["Open the record", "/work-inventory"]],
  }, trigger);
}
function openWaiting(item, trigger) {
  openDetail({
    eyebrow: "Waiting on others",
    title: item.label,
    rows: [["Expecting", item.what], ["Detail", item.detail], ["Owner", item.owner === "joe" ? "Joe" : "Dell"]],
  }, trigger);
}
function openDocHistory(entry, trigger) {
  openDetail({ eyebrow: "Doc history", title: entry.title, rows: [["When", entry.at], ["Summary", entry.detail]] }, trigger);
}
function openPhase(phase, trigger) {
  phaseFocus = phase;
  const cards = CARDS.filter((card) => card.phase === phase);
  openDetail({
    eyebrow: "Pipeline phase",
    title: `${phase} · ${cards.length}`,
    body: [
      el("ul", { class: "tile-list" }, cards.map((card) => el("li", {}, [el("button", { class: "tile-row", type: "button", "data-item": card.id }, [el("span", { text: card.name }), el("b", { text: card.kind === "client" ? "Client" : "Prospect" })])]))),
      el("div", { class: "row-wrap" }, [el("button", { class: "btn btn-secondary", type: "button", "data-goto-pipeline": phase }, [document.createTextNode("Open this phase on the board "), el("span", { "aria-hidden": "true", text: "›" })])]),
    ],
  }, trigger);
}

function renderWork(scope = "team") {
  const list = $("workList");
  if (!list) return;
  const visible = WORK.filter((item) => scope === "team" || item.owner === VIEWER);
  list.replaceChildren(...orderWork(visible, TODAY).map((item) => el("li", { class: "work-item", "data-priority": item.priority, "data-id": item.id }, [
    el("div", {}, [
      el("h3", {}, [item.pinned ? el("span", { class: "pin", "aria-label": "Pinned", text: "★ " }) : null, document.createTextNode(item.action)]),
      el("div", { class: "work-meta" }, [
        el("span", { html: `for <b>${item.record}</b>` }),
        el("span", { html: `contact <b>${item.contact}</b>` }),
        item.waitingOn ? el("span", { html: `waiting on <b>${item.waitingOn}</b>` }) : null,
        el("span", { html: `due <b>${dueText(item)}</b>` }),
      ]),
    ]),
    el("div", { class: "stack-end" }, [
      partnerAvatar(item.owner),
      el("span", { class: "work-status", "data-status": item.status, text: STATUS_WORDS[item.status] }),
      el("button", { class: "btn btn-secondary", type: "button", "data-handover": item.id }, [
        document.createTextNode(`Hand over to ${item.owner === "joe" ? "Dell" : "Joe"} `), el("span", { "aria-hidden": "true", text: "›" }),
      ]),
    ]),
  ])));
}

// ---------------------------------------------------------------- Kanban: drag + keyboard
// createBoard returns a board whose cards move by mouse drag and by keyboard.
// The keyboard path is the accessible equivalent of the drag, announced
// through an aria-live region: Enter or Space lifts, arrows choose a column,
// Enter drops, Escape cancels.
function createBoard({ boardId, liveId, columns, items, label, onMove, evidence = {}, describe }) {
  const board = $(boardId);
  const live = $(liveId);
  if (!board) return null;
  let lifted = null;
  let target = null;

  const announce = (text) => { if (live) live.textContent = text; };
  const render = () => {
    board.replaceChildren(...columns.map((column) => {
      const cards = items().filter((item) => item.phase === column);
      const section = el("section", { class: "kanban-column glass", "data-column": column, "aria-label": `${column}, ${cards.length} cards` }, [
        el("h3", {}, [document.createTextNode(column), el("small", { text: `${cards.length}` })]),
        ...cards.map((card) => el("article", {
          class: "kanban-card", "data-kind": card.kind, "data-id": card.id, draggable: "true", tabindex: "0",
          "data-pending": card.pending ? "true" : null, "data-lifted": lifted === card.id ? "true" : null,
          "aria-label": `${card.name}, ${column}. Press Enter to lift and move.`,
        }, [
          el("h4", { text: card.name }),
          el("div", { class: "work-meta" }, [el("span", { class: "kanban-lane-label", text: card.kind === "client" ? "Active client work" : "Warm prospect" }), partnerAvatar(card.owner)]),
          describe ? el("p", { class: "small", text: describe(card) }) : null,
        ])),
      ]);
      if (target === column) section.dataset.drop = evidence[column] ? "blocked" : "true";
      return section;
    }));
  };

  const drop = (cardId, column) => {
    target = null; lifted = null;
    const card = items().find((item) => item.id === cardId);
    if (!card || card.phase === column) { render(); return; }
    announce(`${card.name} dropped in ${column}.`);
    onMove(card, column);
  };

  board.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".kanban-card");
    if (!card) return;
    card.dataset.dragging = "true";
    event.dataTransfer.setData("text/plain", card.dataset.id);
    event.dataTransfer.effectAllowed = "move";
  });
  board.addEventListener("dragend", () => { board.querySelectorAll('[data-dragging="true"]').forEach((card) => card.removeAttribute("data-dragging")); target = null; render(); });
  board.addEventListener("dragover", (event) => {
    const column = event.target.closest(".kanban-column");
    if (!column) return;
    event.preventDefault();
    if (target !== column.dataset.column) { target = column.dataset.column; render(); }
  });
  board.addEventListener("drop", (event) => {
    const column = event.target.closest(".kanban-column");
    if (!column) return;
    event.preventDefault();
    drop(event.dataTransfer.getData("text/plain"), column.dataset.column);
  });

  board.addEventListener("keydown", (event) => {
    const card = event.target.closest(".kanban-card");
    if (!card) return;
    const id = card.dataset.id;
    const record = items().find((item) => item.id === id);
    if ((event.key === "Enter" || event.key === " ") && lifted !== id) {
      event.preventDefault();
      lifted = id; target = record.phase;
      announce(`${record.name} lifted from ${record.phase}. Use the arrow keys to choose a column, Enter to drop, Escape to cancel.`);
      render();
      board.querySelector(`.kanban-card[data-id="${id}"]`)?.focus();
      return;
    }
    if (lifted !== id) return;
    if (event.key === "Escape") {
      event.preventDefault(); lifted = null; target = null;
      announce(`Move cancelled. ${record.name} stays in ${record.phase}.`);
      render(); board.querySelector(`.kanban-card[data-id="${id}"]`)?.focus();
      return;
    }
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step) {
      event.preventDefault();
      const index = columns.indexOf(target ?? record.phase);
      target = columns[(index + step + columns.length) % columns.length];
      announce(`${target} selected${evidence[target] ? `, needs ${evidence[target]}` : ""}. Enter drops ${record.name} here.`);
      render(); board.querySelector(`.kanban-card[data-id="${id}"]`)?.focus();
      return;
    }
    if (event.key === "Enter") { event.preventDefault(); const chosen = target; drop(id, chosen); }
  });

  board.setAttribute("aria-label", label);
  render();
  return { render, announce, cancel: () => { lifted = null; target = null; render(); } };
}

let pipelineBoard = null;
// The two kind chips and Reset really filter the board; a control that looks
// interactive does something.
function visibleCards() {
  return CARDS.filter((card) => boardFilter.has(card.kind));
}
function movePipelineCard(record, toPhase) {
  const need = EVIDENCE_NEEDED[toPhase];
  if (need) { openCompletion(record, toPhase, need); return; }
  const from = record.phase;
  record.phase = toPhase; record.pending = true; pipelineBoard.render();
  const operation = `move:${record.id}:${toPhase}`;
  const handle = (event) => {
    if (event.detail.operationId !== operation) return;
    if (event.detail.state === "refused") record.phase = from; // confirmed position restored, input kept
    if (event.detail.state !== "unknown") record.pending = false;
    pipelineBoard.render();
    document.removeEventListener("prototype:settled", handle);
  };
  document.addEventListener("prototype:settled", handle);
  document.addEventListener("prototype:undone", (event) => { if (event.detail.operationId === operation) { record.phase = from; pipelineBoard.render(); } }, { once: true });
  dispatchCommand(operation, `${record.name} → ${toPhase}`, outcomeChoice());
}
function openCompletion(record, toPhase, need) {
  const dialog = $("completionDialog");
  if (!dialog) { movePipelineCard({ ...record, phase: record.phase }, toPhase); return; }
  $("completionTitle").textContent = `Move ${record.name} to ${toPhase}`;
  $("completionNeed").textContent = `This move needs ${need}. Cancel leaves the card at ${record.phase}.`;
  const date = $("completionDate");
  if (date) date.value = TODAY.slice(0, 10);
  dialog.returnValue = "";
  dialog.showModal();
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm") {
      const effective = $("completionDate")?.value || TODAY.slice(0, 10);
      record.phase = toPhase;
      pipelineBoard.render();
      dispatchCommand(`move:${record.id}:${toPhase}`, `${record.name} → ${toPhase}, effective ${formatCalendarDate(effective)}`, outcomeChoice());
    } else {
      pipelineBoard.cancel();
      pipelineBoard.announce(`Move cancelled. ${record.name} stays in ${record.phase}.`);
    }
    document.querySelector(`.kanban-card[data-id="${record.id}"]`)?.focus();
  }, { once: true });
}

function openRecordPanel(cardId, trigger) {
  const panel = $("recordPanel");
  const record = CARDS.find((c) => c.id === cardId);
  if (!panel || !record) return;
  panel.hidden = false;
  $("panelTitle").textContent = record.name;
  $("panelSituation").textContent = record.kind === "client"
    ? `Active client assignment at ${record.phase}. ${record.owner === "joe" ? "Joe" : "Dell"} covers the next action.`
    : `Warm prospect at ${record.phase}; a signed ETL would make this a client engagement.`;
  panel.dataset.returnTo = trigger?.dataset.id || "";
  $("panelClose").focus();
}
function closeRecordPanel() {
  const panel = $("recordPanel");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  const returnTo = panel.dataset.returnTo;
  (returnTo ? document.querySelector(`.kanban-card[data-id="${returnTo}"]`) : null)?.focus();
}

function renderQuickAdd() {
  const input = $("quickAddInput");
  if (!input) return;
  const parsed = parseQuickAdd(input.value, { now: Date.parse(TODAY), viewer: VIEWER, records: CARDS.map((card) => card.name) });
  const picked = $("quickAddDate")?.value || null;
  const due = picked || parsed.due;
  $("quickAddParsed").replaceChildren(
    el("div", { html: `<span>Action</span>${parsed.action || "<i>unknown</i>"}` }),
    el("div", { html: `<span>Owner</span>${parsed.owner === "joe" ? "Joe" : "Dell"}${parsed.ownerDefaulted ? " <i>(you, by default)</i>" : ""}` }),
    el("div", { html: `<span>Due</span>${due ? formatDueStamp(due, parsed.dueTime) : "<i>none</i>"}` }),
    el("div", { html: `<span>Related</span>${parsed.related || "<i>none</i>"}` }),
  );
  $("quickAddQuestion").textContent = parsed.complete
    ? `Ready to save: ${parsed.action} · ${parsed.owner === "joe" ? "Joe" : "Dell"}${due ? ` · ${formatDueStamp(due, parsed.dueTime)}` : ""}${parsed.related ? ` · ${parsed.related}` : ""}`
    : `Keep as a draft, or answer: ${parsed.questions.join(" ")}`;
  return { parsed, due };
}

function wireBusiness() {
  const tabs = wireTabs("businessTabs");
  renderHome();
  renderWork("team");
  renderQuickAdd();
  pipelineBoard = createBoard({
    boardId: "kanban", liveId: "dragLive", columns: PHASES, items: visibleCards,
    label: "Pipeline by phase. Drag a card to another column, or focus a card and press Enter to lift it.",
    evidence: EVIDENCE_NEEDED, onMove: movePipelineCard,
  });

  const openItem = (id, trigger) => {
    if (id.startsWith("phase:")) return openPhase(id.slice(6), trigger);
    const work = WORK.find((item) => item.id === id);
    if (work) return openWorkItem(work, trigger);
    const change = CHANGES.find((item) => item.id === id);
    if (change) return openChange(change, trigger);
    const waiting = WAITING.find((item) => item.id === id);
    if (waiting) return openWaiting(waiting, trigger);
    const entry = DOC_HISTORY.find((item) => item.id === id);
    if (entry) return openDocHistory(entry, trigger);
    const card = CARDS.find((item) => item.id === id);
    if (card) { $("detailDialog")?.close(); tabs?.select("tabPipeline"); openRecordPanel(card.id); }
    return undefined;
  };
  document.addEventListener("click", (event) => {
    const row = event.target.closest("button[data-item]");
    if (row) { openItem(row.dataset.item, row); return; }
    const goto = event.target.closest("button[data-goto-pipeline]");
    if (goto) {
      $("detailDialog")?.close();
      tabs?.select("tabPipeline");
      const phase = goto.dataset.gotoPipeline;
      $("boardHint").textContent = `Drag a card between columns, or press Enter on a card to lift it. Showing every phase; ${phase} holds ${CARDS.filter((c) => c.phase === phase).length}.`;
      return;
    }
    if (event.target.closest("[data-close-detail]")) $("detailDialog")?.close();
  });
  document.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-answer]");
    if (!form) return;
    event.preventDefault();
    const item = WORK.find((w) => w.id === form.dataset.answer);
    const answer = form.querySelector("#answerText").value.trim() || "no detail given";
    const effective = form.querySelector("#answerDate").value || null;
    $("detailDialog")?.close();
    dispatchCommand(`answer:${item.id}:${Date.now()}`, `Answered “${item.action}”: ${answer.slice(0, 40)}${effective ? ` · ${formatCalendarDate(effective)}` : ""}`, outcomeChoice());
  });

  $("scopeSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scope]");
    if (!button) return;
    $("scopeSwitch").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    renderWork(button.dataset.scope);
  });
  $("workList")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-handover]");
    if (!button) return;
    const item = WORK.find((w) => w.id === button.dataset.handover);
    const to = item.owner === "joe" ? "dell" : "joe";
    const operation = `handover:${item.id}:${to}`;
    dispatchCommand(operation, `Hand over “${item.action}” to ${to === "joe" ? "Joe" : "Dell"}`, outcomeChoice());
    document.addEventListener("prototype:settled", function handle(e) {
      if (e.detail.operationId !== operation) return;
      if (e.detail.state === "confirmed") {
        item.owner = to;
        renderWork($("scopeSwitch")?.querySelector('[aria-pressed="true"]')?.dataset.scope || "team");
        showToast(`Handed over to ${to === "joe" ? "Joe" : "Dell"}`);
      }
      document.removeEventListener("prototype:settled", handle);
    });
  });

  $("boardChips")?.addEventListener("click", (event) => {
    const chip = event.target.closest("button[data-filter]");
    if (!chip) return;
    if (chip.dataset.filter === "reset") {
      boardFilter.clear(); boardFilter.add("prospect"); boardFilter.add("client"); phaseFocus = null;
      $("boardChips").querySelectorAll("button[data-filter]:not(.chip-reset)").forEach((c) => c.setAttribute("aria-pressed", "true"));
    } else {
      const on = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(on));
      if (on) boardFilter.add(chip.dataset.filter); else boardFilter.delete(chip.dataset.filter);
    }
    pipelineBoard.render();
    pipelineBoard.announce(`Board shows ${visibleCards().length} of ${CARDS.length} cards.`);
  });

  $("kanban")?.addEventListener("dblclick", (event) => {
    const card = event.target.closest(".kanban-card");
    if (card) openRecordPanel(card.dataset.id, card);
  });
  $("panelClose")?.addEventListener("click", closeRecordPanel);
  $("panelPin")?.addEventListener("click", (event) => {
    const panel = $("recordPanel");
    const pinned = panel.dataset.pinned !== "true";
    panel.dataset.pinned = String(pinned);
    event.currentTarget.setAttribute("aria-pressed", String(pinned));
  });

  for (const id of ["quickAddInput", "quickAddDate"]) $(id)?.addEventListener("input", renderQuickAdd);
  $("quickAddDate")?.addEventListener("change", renderQuickAdd);
  $("quickAddForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const { parsed, due } = renderQuickAdd();
    dispatchCommand(`quickadd:${Date.now()}`, `Captured “${parsed.action || "draft"}” · ${parsed.owner === "joe" ? "Joe" : "Dell"}${due ? ` · ${formatDueStamp(due, parsed.dueTime)}` : ""}${parsed.related ? ` · ${parsed.related}` : ""}`, outcomeChoice());
  });
  $("quickAddDraft")?.addEventListener("click", () => {
    const { parsed } = renderQuickAdd();
    dispatchCommand(`draft:${Date.now()}`, `Draft kept: “${parsed.action || "empty"}”`, outcomeChoice());
  });
  mountDocDock("Business home");
}

// ---------------------------------------------------------------- state gallery (/design only)
const STATE_COPY = {
  loading: ["Loading", "Reading verified state."],
  refreshing: ["Refreshing", "Showing the last verified read, as of 2:02 PM."],
  empty: ["No records yet", "Nothing is recorded in this view."],
  no_match: ["No matches", "Three filters are active."],
  no_access: ["Not available to you", "This record is outside your access."],
  offline: ["Offline", "Last verified at 1:41 PM. Drafts stay local until sync."],
  draft: ["Draft, not saved", "Your typing is kept through partner updates."],
  refused: ["Refused", "Stale version. Your input is kept."],
  conflict: ["Conflicting edits", "Before, yours and current are shown side by side."],
  unknown: ["Unknown outcome", "The save was sent but not proven."],
  partial: ["Partly complete", "Two of three steps succeeded."],
  stale: ["Stale", "This read is older than its contract allows."],
  permission_changed: ["Access changed", "Revalidating what you may see."],
};
function wireStateGallery() {
  const picker = $("statePicker");
  const block = $("stateDemo");
  if (!picker || !block) return;
  picker.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-state]");
    if (!button) return;
    picker.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    const [title, copy] = STATE_COPY[button.dataset.state];
    block.dataset.state = button.dataset.state;
    block.querySelector("h3").textContent = title;
    block.querySelector("p").textContent = copy;
    block.querySelector(".compare")?.toggleAttribute("hidden", button.dataset.state !== "conflict");
    block.querySelector(".skeleton-line")?.toggleAttribute("hidden", button.dataset.state !== "loading");
  });
}

// ---------------------------------------------------------------- operations fixtures
const COMPONENTS = [
  { id: "records", label: "RECORD LAYER", sub: "Neon · canonical", cat: "data", x: 60, y: 120, health: "ok", purpose: "Canonical business records and events.", deps: ["Neon"], pending: "0 unfinished items" },
  { id: "verbs", label: "VERBS", sub: "MCP · 246", cat: "execution", x: 260, y: 40, health: "ok", purpose: "Typed commands over the record layer.", deps: ["records", "rules"], pending: "2 slices in review" },
  { id: "rules", label: "RULES", sub: "gates · hooks", cat: "rules", x: 260, y: 200, health: "ok", purpose: "Doctrine, permissions and gates.", deps: ["records"], pending: "1 proposed rule" },
  { id: "worker", label: "CARR WORKER", sub: "Cloudflare", cat: "infra", x: 460, y: 120, health: "failed", purpose: "Serves the API and MCP to DoctorCRE.", deps: ["verbs", "rules"], pending: "release 0515 observed" },
  { id: "app", label: "DOCTORCRE", sub: "app.doctorcre.com", cat: "infra", x: 660, y: 120, health: "blocked", purpose: "The human application.", deps: ["worker"], pending: "UX-S01 in prototype" },
  { id: "doc", label: "DOC", sub: "model routes", cat: "execution", x: 660, y: 260, health: "ok", purpose: "Qualified model routing.", deps: ["verbs"], pending: "F04 live" },
];
const EDGES = [["records", "verbs", "healthy"], ["records", "rules", "healthy"], ["verbs", "worker", "stopped"], ["rules", "worker", "stopped"], ["worker", "app", "stopped"], ["verbs", "doc", "healthy"], ["doc", "app", "inferred"]];
const HEALTH_COPY = { ok: "Healthy, verified 2 min ago", failed: "Failed: 42501 permission denied on deal-room-board (fact)", blocked: "Blocked downstream: this component is healthy but starved of input (hypothesis)", degraded: "Degraded", unknown: "Unknown: collector silent since 1:10 PM" };

// Every dashboard tile is a briefing button. The tile carries a number and a
// state; the reasoning, the evidence and what to do about it live in the popup.
const DASHBOARD_TILES = [
  {
    id: "broken", eyebrow: "Broken", value: "1", tone: "urgent", status: "Since 1:58 PM",
    title: "CARR Worker read refused",
    rows: [["What", "deal-room-board refused with 42501 for every reader."], ["Since", "1:58 PM"], ["Impact", "The Deals page cannot load the board. System Work still loads."], ["Certainty", "Fact from the refusal itself; the cause is a hypothesis."], ["What to do", "Point the read at v_deal_room_event, add a role-realistic test, deploy under production authority."]],
    links: [["Open the work inventory", "/work-inventory"], ["Open the business prototype", "/design/business"]],
  },
  {
    id: "running", eyebrow: "Running", value: "3 jobs", tone: "healthy", status: "Fresh",
    title: "Three jobs running",
    rows: [["Sol", "Reviewing the F09 tail · last event 1:44 PM"], ["Claude", "UX-S01 prototype revision · last event 2:01 PM"], ["Nightly export", "Complete 5:30 AM · receipt archived"], ["What to do", "Nothing. Contact state and work state are tracked separately."]],
    links: [["Open the work inventory", "/work-inventory"]],
  },
  {
    id: "stuck", eyebrow: "Stuck", value: "0", tone: "still", status: "None",
    title: "Nothing suspected stalled",
    rows: [["Basis", "Quiet work and disconnection are distinguished; neither is present."], ["Coverage", "7 of 8 collectors reporting."], ["What to do", "Re-run the GitHub usage collector so the eighth leg reports."]],
  },
  {
    id: "repaired", eyebrow: "Detected and repaired", value: "1", tone: "healthy", status: "9:14 AM",
    title: "Standing-context round trips was detected · repaired 9:14 AM",
    rows: [
      ["What was broken", "standing-context issued one database round trip per rule pack, so a cold read took 1.9 seconds."],
      ["How it was found", "The read-latency budget failed its own check at 8:41 AM, before a partner noticed."],
      ["Why this fix", "Batching the pack reads into one statement keeps the same rows and the same authority; widening a grant or caching the result would have changed what the read means."],
      ["How it is better now", "The same read returns in 130 ms, verified at 8:47 AM and again at 9:14 AM. Nothing was approved or declined: the repair had to preserve the read, or it would not have been applied."],
    ],
    links: [["Open the work inventory", "/work-inventory"]],
  },
  {
    id: "changed", eyebrow: "Changed", value: "4 releases", tone: "refreshing", status: "Last 24h",
    title: "Four releases in the last day",
    rows: [["Migration", "0515"], ["Worker", "9cab"], ["App", "6aa0"], ["Registry", "v26"], ["What to do", "Nothing. Each release carries its own receipt."]],
    links: [["Open the work inventory", "/work-inventory"]],
  },
];

const MODEL_COLUMNS = ["Assigned", "In progress", "Blocked", "Done"];
const MODEL_TICKETS = [
  {
    id: "m1", name: "UX-S01 prototype revision", phase: "In progress", kind: "client", owner: "joe", model: "Claude · Opus 5",
    trail: [["Assigned", "Joe · Wed, Sep 16, 2026 · 9:30 AM"], ["Picked up", "Claude b4981d76 · 9:34 AM"], ["Current status", "In progress · last event 2:01 PM"], ["Outcome", "not yet reported"]],
  },
  {
    id: "m2", name: "F09 census tail review", phase: "In progress", kind: "prospect", owner: "dell", model: "Sol · GPT-5.6",
    trail: [["Assigned", "Session 8384f25a · Wed, Sep 16, 2026 · 11:02 AM"], ["Picked up", "Sol f3cd9a10 · 11:05 AM"], ["Current status", "In progress · last event 1:44 PM"], ["Outcome", "not yet reported"]],
  },
  {
    id: "m3", name: "Worker release rehearsal", phase: "Blocked", kind: "client", owner: "joe", model: "Terra · GPT-5.6",
    trail: [["Assigned", "Joe · Tue, Sep 15, 2026 · 3:15 PM"], ["Picked up", "Terra 5cc1a2b8 · 3:20 PM"], ["Current status", "Blocked on an outside reviewer since Tue, Sep 15, 2026 · 6:40 PM"], ["Outcome", "pending"]],
  },
  {
    id: "m4", name: "Nightly export receipt check", phase: "Done", kind: "client", owner: "dell", model: "launchd · system",
    trail: [["Assigned", "Schedule · Wed, Sep 16, 2026 · 5:00 AM"], ["Worked", "launchd · 5:30 AM"], ["Outcome", "12 generations kept, receipt archived"], ["Current status", "Done · verified 5:31 AM"]],
  },
  {
    id: "m5", name: "Collector re-run for Actions minutes", phase: "Assigned", kind: "prospect", owner: "joe", model: "unassigned model",
    trail: [["Assigned", "Joe · Wed, Sep 16, 2026 · 1:15 PM"], ["Current status", "Assigned, not yet picked up"], ["Outcome", "pending"]],
  },
];

function renderAtlas() {
  const svg = $("atlasSvg");
  if (!svg) return;
  const ns = "http://www.w3.org/2000/svg";
  const make = (tag, attrs, text) => { const node = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (text) node.textContent = text; return node; };
  svg.replaceChildren();
  const byId = Object.fromEntries(COMPONENTS.map((c) => [c.id, c]));
  for (const [from, to, flow] of EDGES) {
    const a = byId[from]; const b = byId[to];
    svg.append(make("path", { class: "atlas-edge", "data-flow": flow, d: `M${a.x + 150} ${a.y + 35} C ${a.x + 200} ${a.y + 35}, ${b.x - 50} ${b.y + 35}, ${b.x} ${b.y + 35}` }));
  }
  for (const c of COMPONENTS) {
    const g = make("g", { class: "atlas-node", "data-cat": c.cat, "data-health": c.health, "data-id": c.id, tabindex: "0", role: "button", "aria-label": `${c.label}, ${c.cat}, ${HEALTH_COPY[c.health]}`, transform: `translate(${c.x} ${c.y})` });
    g.append(make("rect", { width: 150, height: 70, rx: 16 }));
    g.append(make("text", { x: 75, y: 32 }, c.label));
    g.append(make("text", { class: "sub", x: 75, y: 52 }, c.sub));
    if (c.health === "failed") g.append(make("circle", { class: "atlas-marker", cx: 150, cy: 0, r: 8 }));
    svg.append(g);
  }
  renderAtlasIndex();
}
function renderAtlasIndex() {
  const list = $("atlasIndex");
  if (!list) return;
  list.replaceChildren(...COMPONENTS.map((c) => el("li", {}, [el("button", { class: "btn btn-quiet", type: "button", "data-focus": c.id, style: "justify-content:flex-start;width:100%", "aria-current": c.id === focusedId ? "true" : null }, [
    el("span", { class: "swatch", "data-cat": c.cat, "aria-hidden": "true" }), document.createTextNode(` ${c.label} `), el("small", { text: HEALTH_COPY[c.health].split(":")[0] }),
  ])])));
}
let focusedId = null;
const focusHistory = [];
function focusComponent(id, push = true) {
  if (push && focusedId && focusedId !== id) focusHistory.push(focusedId);
  focusedId = id;
  document.querySelectorAll(".atlas-node").forEach((node) => node.setAttribute("aria-current", String(node.dataset.id === id)));
  const c = COMPONENTS.find((x) => x.id === id);
  const drawer = $("componentDrawer");
  if (c && drawer) {
    drawer.hidden = false;
    $("componentTitle").textContent = c.label;
    $("componentBody").replaceChildren(el("dl", { class: "detail-list" }, [
      el("dt", { text: "Purpose" }), el("dd", { text: c.purpose }),
      el("dt", { text: "Status" }), el("dd", { text: HEALTH_COPY[c.health] }),
      el("dt", { text: "Depends on" }), el("dd", { text: c.deps.join(", ") }),
      el("dt", { text: "Unfinished" }), el("dd", { text: c.pending }),
      el("dt", { text: "Basis" }), el("dd", { text: "Declared wiring (services.json); observed run at 1:58 PM" }),
    ]));
  }
  renderAtlasIndex();
  $("atlasBack")?.toggleAttribute("disabled", focusHistory.length === 0);
}

function renderDashboardTiles() {
  const grid = $("dashboardTiles");
  if (!grid) return;
  grid.replaceChildren(...DASHBOARD_TILES.map((tile) => el("article", { class: `card glass${tile.tone === "urgent" ? " urgent" : tile.tone === "healthy" ? " healthy" : ""}` }, [
    el("p", { class: "eyebrow", text: tile.eyebrow }),
    el("h2", { text: tile.value }),
    el("span", { class: "status", "data-state": tile.tone }, [el("span", { class: "orb", "data-state": tile.tone, "aria-hidden": "true" }), document.createTextNode(` ${tile.status}`)]),
    el("button", { class: "btn btn-secondary", type: "button", "data-briefing": tile.id }, [document.createTextNode("Briefing "), el("span", { "aria-hidden": "true", text: "›" })]),
  ])));
}

let modelBoard = null;
function renderModelHistory() {
  const list = $("modelHistory");
  if (!list) return;
  list.replaceChildren(...MODEL_TICKETS.flatMap((ticket) => ticket.trail.map(([stage, detail]) => el("li", {}, [
    el("b", { text: `${ticket.name} · ${stage}` }),
    el("span", { text: detail }),
    el("time", { text: `${ticket.model} · ${ticket.phase}` }),
  ]))));
}

function wireOperations() {
  const tabs = wireTabs("operationsTabs");
  renderAtlas();
  renderDashboardTiles();
  renderModelHistory();
  modelBoard = createBoard({
    boardId: "modelKanban", liveId: "modelLive", columns: MODEL_COLUMNS, items: () => MODEL_TICKETS,
    label: "Model tickets by column. Drag a ticket to another column, or focus a ticket and press Enter to lift it.",
    describe: (ticket) => ticket.model,
    onMove: (ticket, column) => {
      const from = ticket.phase;
      ticket.phase = column; ticket.pending = true; modelBoard.render(); renderModelHistory();
      const operation = `ticket:${ticket.id}:${column}`;
      document.addEventListener("prototype:settled", function handle(event) {
        if (event.detail.operationId !== operation) return;
        if (event.detail.state === "refused") ticket.phase = from;
        if (event.detail.state !== "unknown") ticket.pending = false;
        modelBoard.render(); renderModelHistory();
        document.removeEventListener("prototype:settled", handle);
      });
      dispatchCommand(operation, `${ticket.name} → ${column}`, outcomeChoice());
    },
  });

  document.addEventListener("click", (event) => {
    const briefing = event.target.closest("button[data-briefing]");
    if (briefing) {
      const tile = DASHBOARD_TILES.find((t) => t.id === briefing.dataset.briefing);
      openDetail({ eyebrow: `Briefing · ${tile.eyebrow}`, title: tile.title, rows: tile.rows, links: tile.links || [] }, briefing);
      return;
    }
    if (event.target.closest("[data-close-detail]")) $("detailDialog")?.close();
  });
  $("modelKanban")?.addEventListener("dblclick", (event) => {
    const card = event.target.closest(".kanban-card");
    if (!card) return;
    const ticket = MODEL_TICKETS.find((t) => t.id === card.dataset.id);
    openDetail({ eyebrow: "Model ticket", title: ticket.name, rows: [["Model", ticket.model], ...ticket.trail] }, card);
  });

  $("atlasSvg")?.addEventListener("click", (event) => { const node = event.target.closest(".atlas-node"); if (node) focusComponent(node.dataset.id); });
  $("atlasSvg")?.addEventListener("keydown", (event) => { const node = event.target.closest(".atlas-node"); if (node && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); focusComponent(node.dataset.id); } });
  $("atlasIndex")?.addEventListener("click", (event) => { const button = event.target.closest("button[data-focus]"); if (button) { focusComponent(button.dataset.focus); document.querySelector(`.atlas-node[data-id="${button.dataset.focus}"]`)?.focus(); } });
  $("atlasBack")?.addEventListener("click", () => { const previous = focusHistory.pop(); if (previous) focusComponent(previous, false); else { focusedId = null; $("componentDrawer").hidden = true; document.querySelectorAll(".atlas-node").forEach((n) => n.setAttribute("aria-current", "false")); renderAtlasIndex(); } $("atlasBack").toggleAttribute("disabled", focusHistory.length === 0 && !focusedId); });
  $("layerSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-layer]");
    if (!button) return;
    $("layerSwitch").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    const atlas = $("atlas");
    if (button.dataset.layer === "all") atlas.removeAttribute("data-layer"); else atlas.dataset.layer = button.dataset.layer;
    $("layerLive").textContent = `Layer: ${button.textContent.trim()}. Components keep their positions.`;
  });
  $("timeSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-time]");
    if (!button) return;
    $("timeSwitch").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    $("timeLive").textContent = button.dataset.time === "live" ? "Live. Observed 2:02 PM." : "Historical: Mon, Sep 14, 2026 · 11:07 AM. You have left live mode.";
  });
  $("approvalChange")?.addEventListener("click", () => {
    $("approvalCard").dataset.state = "stale";
    $("approvalNote").textContent = "The target changed since this proposal (Worker 5d81 → 9cab). The old approval is void; a refreshed proposal is required before anything executes.";
    $("approvalApprove").disabled = true;
  });
  $("approvalApprove")?.addEventListener("click", () => dispatchCommand("approve:census-sixth-source", "Approve: widen the census read", outcomeChoice()));
  $("ackIncident")?.addEventListener("click", (event) => {
    event.currentTarget.setAttribute("aria-pressed", "true");
    $("ackNote").textContent = "Acknowledged by Joe at 2:03 PM. The incident stays open until recovery is verified.";
  });
  $("composerForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    dispatchCommand(`msg:${Date.now()}`, `Message to Sol (session f3cd…): “${$("composerInput").value.slice(0, 32)}”`, outcomeChoice());
  });
  void tabs;
  mountDocDock("Control Room dashboard");
}

// ---------------------------------------------------------------- index page: token audit
function wireIndex() {
  const table = $("contrastTable");
  if (!table) return;
  const pairs = JSON.parse(table.dataset.pairs || "[]");
  const toHex = (value) => {
    const probe = document.createElement("span"); probe.style.color = value; document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    probe.remove(); return `#${rgb}`;
  };
  const render = () => {
    const current = getComputedStyle(document.documentElement);
    table.querySelector("tbody").replaceChildren(...pairs.map(([fg, bg]) => {
      const ratio = contrastRatio(toHex(current.getPropertyValue(fg).trim()), toHex(current.getPropertyValue(bg).trim()));
      return el("tr", {}, [el("td", { text: `${fg} on ${bg}` }), el("td", { class: "num", text: `${ratio.toFixed(2)}:1` }), el("td", { text: ratio >= 4.5 ? "AA" : "below floor" })]);
    }));
  };
  render();
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

// ---------------------------------------------------------------- boot
wirePreferences();
mountCommandDock();
wireDetailDialog();
const surface = document.body.dataset.prototype;
if (surface === "business") wireBusiness();
if (surface === "operations") wireOperations();
if (surface === "index") { wireTabs("systemTabs"); wireIndex(); wireStateGallery(); mountDocDock("Visual system"); }
