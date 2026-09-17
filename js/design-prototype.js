// Wiring for the V5-UX-S01 prototype pages. Synthetic fixtures only: nothing
// here reaches CARR, the network or a real record. The page attribute
// data-prototype names which surface to wire; the pure decisions live in
// visual-system.js so they can be tested without a browser.
import {
  canDispatch, contrastRatio, createFeedback, feedbackLabel, orderWork, parseQuickAdd,
  preferenceAttributes, resolvePreferences, transitionFeedback,
} from "./visual-system.js";

const PREFS_KEY = "doctorcre.presentation.v1";
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
function readStoredPreferences() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
}
function storePreferences(preferences) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); } catch { /* storage is a convenience, never a requirement */ }
}
function systemPreferences() {
  return { prefersReducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches };
}
export function applyPreferences(preferences) {
  for (const [name, value] of Object.entries(preferenceAttributes(preferences))) document.documentElement.setAttribute(name, value);
  document.querySelectorAll("[data-pref]").forEach((group) => {
    const key = group.getAttribute("data-pref");
    group.querySelectorAll("button[data-value]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === preferences[key])));
  });
  const live = $("prefsLive");
  if (live) live.textContent = `Theme ${preferences.theme}, density ${preferences.density}, motion ${preferences.motion}.`;
}
function wirePreferences() {
  let current = resolvePreferences(readStoredPreferences(), systemPreferences());
  applyPreferences(current);
  document.querySelectorAll("[data-pref]").forEach((group) => {
    const key = group.getAttribute("data-pref");
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      current = resolvePreferences({ ...current, [key]: button.dataset.value }, systemPreferences());
      storePreferences(current);
      applyPreferences(current);
    });
  });
}

// ---------------------------------------------------------------- command feedback
const feedbackDock = () => $("receiptDock");
const records = new Map();
function renderReceipts() {
  const dock = feedbackDock();
  if (!dock) return;
  dock.replaceChildren(...[...records.values()].slice(-4).map((record) => {
    const actions = [];
    if (record.state === "confirmed") actions.push(el("button", { class: "btn btn-quiet", type: "button", text: "Undo", "data-op": record.operationId, "data-event": "undo" }));
    if (record.state === "unknown") actions.push(el("button", { class: "btn btn-secondary", type: "button", text: "Check outcome", "data-op": record.operationId, "data-event": "reconcile" }));
    if (record.state === "refused") actions.push(el("button", { class: "btn btn-quiet", type: "button", text: "Try again", "data-op": record.operationId, "data-event": "dispatch" }));
    return el("div", { class: "receipt", role: "status", "data-state": record.state }, [
      el("span", { class: "receipt-badge", text: feedbackLabel(record) }),
      el("div", {}, [el("b", { text: record.summary }), el("small", { text: record.reason || `operation ${record.operationId}` })]),
      el("div", {}, actions),
    ]);
  }));
}
function settle(record, outcome) {
  const event = outcome === "refuse" ? "refuse" : outcome === "timeout" ? "timeout" : "confirm";
  const detail = event === "refuse" ? { reason: "Stale version: Dell changed this card 40 seconds ago. Your input is kept." } : {};
  const next = transitionFeedback(record, event, detail);
  records.set(next.operationId, next);
  renderReceipts();
  document.dispatchEvent(new CustomEvent("prototype:settled", { detail: next }));
}
export function dispatchCommand(operationId, summary, outcome = "confirm") {
  const existing = records.get(operationId) || createFeedback(operationId, summary);
  if (!canDispatch(existing)) return existing; // double click, reconnect, second device: one logical operation
  const pending = transitionFeedback(existing, "dispatch");
  records.set(operationId, pending);
  renderReceipts();
  setTimeout(() => settle(records.get(operationId), outcome), 700);
  return pending;
}
function wireReceipts() {
  const dock = feedbackDock();
  if (!dock) return;
  dock.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-op]");
    if (!button) return;
    const record = records.get(button.dataset.op);
    const next = transitionFeedback(record, button.dataset.event);
    records.set(next.operationId, next);
    renderReceipts();
    if (next.state === "checking") setTimeout(() => settle(records.get(next.operationId), "confirm"), 900);
    if (next.state === "pending") setTimeout(() => settle(records.get(next.operationId), "confirm"), 700);
    if (next.state === "undone") document.dispatchEvent(new CustomEvent("prototype:undone", { detail: next }));
  });
}
const outcomeChoice = () => $("outcomeSimulator")?.value || "confirm";

// ---------------------------------------------------------------- business fixtures
const TODAY = "2026-09-16T14:00:00Z";
const WORK = [
  { id: "t1", action: "Send LOI redline to landlord counsel", record: "Demo Gulf Breeze Dental", owner: "joe", contact: "Demo Dr. Avery", due: "2026-09-15", status: "in_progress" },
  { id: "t2", action: "Confirm survey window with vendor", record: "Demo Pace Pediatrics", owner: "dell", contact: "Demo Dr. Okafor", due: "2026-09-18", status: "waiting", waitingOn: "Demo Coastal Surveying", followUp: "2026-09-17" },
  { id: "t3", action: "Assemble information request for the practice CPA", record: "Demo Navarre Ortho", owner: "joe", contact: "Demo Dr. Lin", blocked: true, blockedOn: "signed ETL", status: "todo" },
  { id: "t4", action: "Research exhibitor list and pricing", record: "Demo Regional Health Summit (event)", owner: "dell", contact: "—", due: "2026-10-02", status: "todo" },
  { id: "t5", action: "Property search refresh: 4,000–6,000 sf medical", record: "Demo Milton Family Care", owner: "joe", contact: "Demo Dr. Reyes", due: "2026-09-20", status: "todo", pinned: true },
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

function partnerAvatar(owner) {
  return el("span", { class: "owner" }, [el("span", { class: "avatar", "data-partner": owner, "aria-hidden": "true", text: owner === "joe" ? "J" : "D" }), el("span", { text: owner === "joe" ? "Joe" : "Dell" })]);
}
function renderWork(scope = "team") {
  const list = $("workList");
  if (!list) return;
  const visible = WORK.filter((item) => scope === "team" || item.owner === "joe");
  list.replaceChildren(...orderWork(visible, TODAY).map((item) => el("li", { class: "work-item", "data-priority": item.priority, "data-id": item.id }, [
    el("div", {}, [
      el("h3", {}, [item.pinned ? el("span", { class: "pin", "aria-label": "Pinned", text: "★ " }) : null, document.createTextNode(item.action)]),
      el("div", { class: "work-meta" }, [
        el("span", { html: `for <b>${item.record}</b>` }),
        el("span", { html: `contact <b>${item.contact}</b>` }),
        item.waitingOn ? el("span", { html: `waiting on <b>${item.waitingOn}</b>, follow up ${item.followUp}` }) : null,
        item.due ? el("span", { html: `due <b>${item.due}</b>` }) : el("span", { text: "no due date" }),
      ]),
      item.reason ? el("p", { class: "why", text: `Why here: ${item.reason}` }) : null,
    ]),
    el("div", { style: "display:grid;gap:8px;justify-items:end" }, [
      partnerAvatar(item.owner),
      el("span", { class: "work-status", "data-status": item.status, text: item.status.replace("_", " ") }),
      el("button", { class: "btn btn-quiet", type: "button", "data-handover": item.id, text: `Hand over to ${item.owner === "joe" ? "Dell" : "Joe"}` }),
    ]),
  ])));
}
function renderKanban() {
  const board = $("kanban");
  if (!board) return;
  board.replaceChildren(...PHASES.map((phase) => {
    const cards = CARDS.filter((card) => card.phase === phase);
    return el("section", { class: "kanban-column glass", "aria-label": `${phase}, ${cards.length} cards` }, [
      el("h3", {}, [document.createTextNode(phase), el("small", { text: `${cards.length}` })]),
      ...cards.map((card) => el("article", { class: "kanban-card", "data-kind": card.kind, "data-id": card.id, "data-pending": card.pending ? "true" : null, "aria-label": `${card.name}, ${card.kind}` }, [
        el("h4", {}, [el("button", { class: "btn btn-quiet", type: "button", style: "min-height:32px;padding:2px 4px;font-size:14px;text-align:left", "data-open": card.id, text: card.name })]),
        el("div", { class: "work-meta" }, [el("span", { class: "kanban-lane-label", text: card.kind === "client" ? "Active client work" : "Warm prospect" }), partnerAvatar(card.owner)]),
        el("div", { class: "card-actions" }, [
          el("button", { class: "btn", type: "button", "data-move": card.id, "aria-haspopup": "menu", "aria-expanded": "false", text: "Move" }),
          el("button", { class: "btn btn-quiet", type: "button", "data-doc": card.id, text: "Ask Doc" }),
        ]),
      ])),
    ]);
  }));
}
function openMoveMenu(button) {
  closeMenus();
  const card = button.closest(".kanban-card");
  const record = CARDS.find((c) => c.id === card.dataset.id);
  const menu = el("div", { class: "move-menu", role: "menu", "aria-label": `Move ${record.name}` });
  for (const phase of PHASES.filter((p) => p !== record.phase)) {
    const need = EVIDENCE_NEEDED[phase];
    const item = el("button", { type: "button", role: "menuitem", "data-to": phase, "aria-disabled": need ? "true" : null }, [document.createTextNode(phase), need ? el("small", { text: "needs evidence" }) : null]);
    menu.append(item);
  }
  card.append(menu);
  button.setAttribute("aria-expanded", "true");
  menu.querySelector("button").focus();
}
function closeMenus() {
  document.querySelectorAll(".move-menu").forEach((menu) => {
    const button = menu.closest(".kanban-card")?.querySelector("[data-move]");
    if (button) button.setAttribute("aria-expanded", "false");
    menu.remove();
  });
}
function moveCard(cardId, toPhase, trigger) {
  const record = CARDS.find((c) => c.id === cardId);
  const need = EVIDENCE_NEEDED[toPhase];
  closeMenus();
  if (need) { openCompletion(record, toPhase, need, trigger); return; }
  const from = record.phase;
  record.phase = toPhase; record.pending = true; renderKanban();
  const handle = (event) => {
    if (event.detail.operationId !== `move:${cardId}:${toPhase}`) return;
    if (event.detail.state === "refused") record.phase = from; // confirmed position restored, input kept
    if (event.detail.state !== "unknown") record.pending = false;
    renderKanban();
    document.removeEventListener("prototype:settled", handle);
  };
  document.addEventListener("prototype:settled", handle);
  document.addEventListener("prototype:undone", (event) => { if (event.detail.operationId === `move:${cardId}:${toPhase}`) { record.phase = from; renderKanban(); } }, { once: true });
  dispatchCommand(`move:${cardId}:${toPhase}`, `${record.name} → ${toPhase}`, outcomeChoice());
  $("kanban")?.querySelector(`[data-move="${cardId}"]`)?.focus();
}
function openCompletion(record, toPhase, need, trigger) {
  const dialog = $("completionDialog");
  if (!dialog) return;
  $("completionTitle").textContent = `Move ${record.name} to ${toPhase}`;
  $("completionNeed").textContent = `This move needs ${need}. Existing evidence is listed first; cancel leaves the card at ${record.phase}.`;
  dialog.returnValue = "";
  dialog.showModal();
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm") { record.phase = toPhase; renderKanban(); dispatchCommand(`move:${record.id}:${toPhase}`, `${record.name} → ${toPhase} with evidence`, outcomeChoice()); }
    (trigger || $("kanban")?.querySelector(`[data-move="${record.id}"]`))?.focus();
  }, { once: true });
}
function openRecordPanel(cardId, trigger) {
  const panel = $("recordPanel");
  const record = CARDS.find((c) => c.id === cardId);
  if (!panel || !record) return;
  panel.hidden = false;
  $("panelTitle").textContent = record.name;
  $("panelSituation").textContent = record.kind === "client" ? `Active client assignment at ${record.phase}. ${record.owner === "joe" ? "Joe" : "Dell"} covers the next action.` : `Warm prospect at ${record.phase}; a signed ETL would make this a client engagement.`;
  panel.dataset.returnTo = trigger?.dataset.open || "";
  $("panelClose").focus();
}
function closeRecordPanel() {
  const panel = $("recordPanel");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  const returnTo = panel.dataset.returnTo;
  (returnTo ? document.querySelector(`[data-open="${returnTo}"]`) : null)?.focus();
}
function wireBusiness() {
  renderWork("team");
  renderKanban();
  $("scopeSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scope]");
    if (!button) return;
    $("scopeSwitch").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    renderWork(button.dataset.scope);
    $("scopeNote").textContent = button.dataset.scope === "team" ? "Showing the combined team book. Nobody is ranked." : "Showing work recorded as yours. The team book is unchanged.";
  });
  $("workList")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-handover]");
    if (!button) return;
    const item = WORK.find((w) => w.id === button.dataset.handover);
    const to = item.owner === "joe" ? "dell" : "joe";
    dispatchCommand(`handover:${item.id}:${to}`, `Hand over "${item.action}" to ${to === "joe" ? "Joe" : "Dell"}`, outcomeChoice());
    document.addEventListener("prototype:settled", function handle(e) {
      if (e.detail.operationId !== `handover:${item.id}:${to}`) return;
      if (e.detail.state === "confirmed") { item.owner = to; renderWork($("scopeSwitch")?.querySelector('[aria-pressed="true"]')?.dataset.scope || "team"); }
      document.removeEventListener("prototype:settled", handle);
    });
  });
  const board = $("kanban");
  board?.addEventListener("click", (event) => {
    const move = event.target.closest("button[data-move]");
    if (move) { move.getAttribute("aria-expanded") === "true" ? closeMenus() : openMoveMenu(move); return; }
    const to = event.target.closest(".move-menu button[data-to]");
    if (to) { moveCard(to.closest(".kanban-card").dataset.id, to.dataset.to, to.closest(".kanban-card").querySelector("[data-move]")); return; }
    const open = event.target.closest("button[data-open]");
    if (open) { openRecordPanel(open.dataset.open, open); return; }
    const doc = event.target.closest("button[data-doc]");
    if (doc) { $("docPanel").hidden = false; $("docContext").textContent = `Scope: ${CARDS.find((c) => c.id === doc.dataset.doc).name} (one card).`; $("docInput").focus(); }
  });
  board?.addEventListener("keydown", (event) => {
    const menu = event.target.closest(".move-menu");
    if (event.key === "Escape") { const card = event.target.closest(".kanban-card"); closeMenus(); card?.querySelector("[data-move]")?.focus(); }
    if (!menu) return;
    const items = [...menu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".kanban-card")) closeMenus(); });
  $("panelClose")?.addEventListener("click", closeRecordPanel);
  $("panelPin")?.addEventListener("click", (event) => { const panel = $("recordPanel"); const pinned = panel.dataset.pinned !== "true"; panel.dataset.pinned = String(pinned); event.currentTarget.setAttribute("aria-pressed", String(pinned)); });
  $("docClose")?.addEventListener("click", () => { $("docPanel").hidden = true; });
  $("docOpen")?.addEventListener("click", () => { $("docPanel").hidden = false; $("docContext").textContent = "Scope: the filtered board you are looking at."; $("docInput").focus(); });
  $("docForm")?.addEventListener("submit", (event) => { event.preventDefault(); $("docReply").textContent = "Doc (prototype): I would fetch the authorized evidence for that card and propose the next action. Nothing was sent or changed."; });
  $("quickAddInput")?.addEventListener("input", (event) => {
    const parsed = parseQuickAdd(event.target.value, Date.parse(TODAY));
    $("quickAddParsed").replaceChildren(
      el("div", { html: `<span>Action</span>${parsed.action || "<i>unknown</i>"}` }),
      el("div", { html: `<span>Owner</span>${parsed.owner ? (parsed.owner === "joe" ? "Joe" : "Dell") : "<i>unknown</i>"}` }),
      el("div", { html: `<span>Due</span>${parsed.due || "<i>none</i>"}` }),
      el("div", { html: `<span>Related</span>${parsed.related || "<i>none</i>"}` }),
    );
    $("quickAddQuestion").textContent = parsed.complete ? "Ready to save as a task." : `Keep as a draft, or answer: ${parsed.questions.join(" ")}`;
  });
  $("quickAddForm")?.addEventListener("submit", (event) => { event.preventDefault(); dispatchCommand(`quickadd:${Date.now()}`, `Captured "${$("quickAddInput").value.slice(0, 40)}"`, outcomeChoice()); });
  wireStateGallery();
}

// ---------------------------------------------------------------- state gallery (both pages)
const STATE_COPY = {
  loading: ["Loading the team book", "Reading verified state. Nothing here is a count yet."],
  refreshing: ["Refreshing", "Showing the last verified read, as of 14:02. New data replaces it only when it lands."],
  empty: ["No records yet", "There is nothing recorded in this view. Capture the first one."],
  no_match: ["No matches", "Three filters are active. Clear one, or reset all."],
  no_access: ["Not available to you", "This record is outside your access. Ask the owner, or open what you can see."],
  offline: ["Offline", "Last verified at 13:41. Drafts stay local and are labelled until sync."],
  draft: ["Draft, not saved", "Your typing is kept through partner updates and navigation."],
  refused: ["Refused", "Stale version. Your input is kept; compare and resubmit."],
  conflict: ["Conflicting edits", "Original, yours and the current value are shown side by side. Nothing was lost."],
  unknown: ["Unknown outcome", "The save was sent but not proven. Checking before any retry."],
  partial: ["Partly complete", "Two of three steps succeeded. Only the remaining step can be retried."],
  stale: ["Stale", "This read is older than its contract allows. Refresh to trust it."],
  permission_changed: ["Access changed", "Revalidating what you may see. Anything now outside your access is removed."],
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
const HEALTH_COPY = { ok: "Healthy, verified 2 min ago", failed: "Failed: 42501 permission denied on deal-room-board (fact)", blocked: "Blocked downstream: this component is healthy but starved of input (hypothesis)", degraded: "Degraded", unknown: "Unknown: collector silent since 13:10" };

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
    $("componentBody").replaceChildren(
      el("dl", { class: "incident", style: "border-left:0;padding:0;background:none" }, [
        el("dt", { text: "Purpose" }), el("dd", { text: c.purpose }),
        el("dt", { text: "Status" }), el("dd", { text: HEALTH_COPY[c.health] }),
        el("dt", { text: "Depends on" }), el("dd", { text: c.deps.join(", ") }),
        el("dt", { text: "Unfinished" }), el("dd", { text: c.pending }),
        el("dt", { text: "Basis" }), el("dd", { text: "Declared wiring (services.json); observed run 2026-09-16T13:58Z" }),
      ]),
    );
  }
  renderAtlasIndex();
  $("atlasBack")?.toggleAttribute("disabled", focusHistory.length === 0);
}
function wireOperations() {
  renderAtlas();
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
    $("timeLive").textContent = button.dataset.time === "live" ? "Live. Observed 14:02:11." : "Historical: 2026-09-14 11:07. You have left live mode; Return to live is one keystroke away.";
  });
  $("approvalChange")?.addEventListener("click", () => { const card = $("approvalCard"); card.dataset.state = "stale"; $("approvalNote").textContent = "The target changed since this proposal (Worker 5d81 → 9cab). The old approval is void; a refreshed proposal is required before anything executes."; $("approvalApprove").disabled = true; });
  $("approvalApprove")?.addEventListener("click", () => dispatchCommand("approve:fix-42501", "Approve: repair deal-room-board read", outcomeChoice()));
  $("ackIncident")?.addEventListener("click", (event) => { event.currentTarget.setAttribute("aria-pressed", "true"); $("ackNote").textContent = "Acknowledged by Joe at 14:03. The incident stays open until recovery is verified."; });
  $("composerForm")?.addEventListener("submit", (event) => { event.preventDefault(); const text = $("composerInput").value; dispatchCommand(`msg:${Date.now()}`, `Message to Sol (session f3cd…): "${text.slice(0, 32)}"`, outcomeChoice()); $("composerState").textContent = "Sent means transport accepted it. Delivered, acknowledged and acted on are shown separately when evidence arrives."; });
  wireStateGallery();
}

// ---------------------------------------------------------------- index page: token audit
function wireIndex() {
  const table = $("contrastTable");
  if (!table) return;
  const style = getComputedStyle(document.documentElement);
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
  void style;
}

// ---------------------------------------------------------------- boot
wirePreferences();
wireReceipts();
const surface = document.body.dataset.prototype;
if (surface === "business") wireBusiness();
if (surface === "operations") wireOperations();
if (surface === "index") { wireIndex(); wireStateGallery(); }
