import { mountHierarchy } from './progress-hierarchy.js';
import { mountOrchestrator } from './progress-orchestrator.js';
import { mountQueueBoard } from './work-queue-board.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { boardIdFromPath, boardPageUrl } from './progress-board-route.js';
import { governanceTasks, withGovernance } from "./control-room-workspace-model.js";
import { createLiveClient } from "./live-client.js";
import { mountVisibilityPoll, mountLocalTicker, watchPresence } from "./visibility-poll.mjs";
import { mountSystemWorkBoard } from "./system-work-board.js";
import { uuidv4 } from "./uuid.js";
import { workDetailUrl } from "./progress-work-model.js";
import { mountCostView } from './progress-board-costs.js';
import {
  jobLinks, STAGE_DEFINITIONS, PULSES, EXECUTORS, ALL_REPOS_BOARD, LIVE_PREVIEW, legendEntries, boardView, headline,
  answerRequest, taskSummary, modelLine, stageEnteredAt, ageText,
  executorGlyph, executorPool, taskRepo, liveView, readLivePreference,
  writeLivePreference, filterCards, groupByRepo, boardFromSearch, safeHref, sortLive,
  SYSTEM_BOARD_ID, boardDirectory, boardFreshness, nextFreshnessChange, WORK_VIEWS, WORK_LANE_LIMIT, cardsForView,
} from "./progress-board-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const TICK_MS = 30000;

function safeStorage(win) {
  try { return win.localStorage ?? null; } catch { return null; }
}

// One interactive board. Everything it draws comes from the published CARR
// snapshot; every indicator comes from the model's shared constants.
export function mountBoard(deps = {}) {
  const win = deps.window || globalThis;
  const doc = deps.document || win.document;
  const client = deps.client || createLiveClient();
  const storage = "storage" in deps ? deps.storage : safeStorage(win);
  const now = deps.now || (() => new Date());
  // eslint-disable-next-line no-restricted-syntax -- Timer adapter used only by mountLocalTicker; ceil(30 minutes / intervalMs) ticks. Local repaint only; callback error stops the clock without retry The owning mountLocalTicker stops hidden, after 30-minute idle, or on disposal
  const schedule = deps.setInterval || ((fn, ms) => win.setInterval(fn, ms));
  // eslint-disable-next-line no-restricted-syntax -- 1 callback per explicit dispatch; no self-rearm. No automatic retry; deadline, debounce, paint, or completion callback only Completes once or is cancelled/replaced by its owner; never schedules repeating idle work
  const setTimer = deps.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || (id => win.clearTimeout(id));
  // eslint-disable-next-line no-restricted-syntax -- 1 callback per explicit dispatch; no self-rearm. No automatic retry; deadline, debounce, paint, or completion callback only Completes once or is cancelled/replaced by its owner; never schedules repeating idle work
  const requestAnimationFrame = fn => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 0));
  const pathBoardId = boardIdFromPath(deps.location?.pathname ?? win.location?.pathname ?? "");
  const boardId = pathBoardId || boardFromSearch(deps.search ?? win.location?.search ?? "");
  const orchestratorView = boardId === 'orchestrator';
  // The system board page is the record-layer work queue, read live (WR-000557 S4). The Control Room's
  // Boards tab keeps its census pipeline, which also feeds Attention, until its own slice (S6).
  const queueBoardView = boardId === SYSTEM_BOARD_ID && !deps.openTask;
  const byId = id => doc.getElementById(id);
  const costs = mountCostView(byId('board-costs'));
  const location = deps.location || win.location;
  if (orchestratorView) doc.querySelector(".directory-panel").hidden = true;
  byId("board-activity").href = workDetailUrl({ board: boardId || SYSTEM_BOARD_ID });
  byId("board-parent-name").textContent = boardId === SYSTEM_BOARD_ID ? "System board" : "Project board";
  const timers = [];
  let poller = null;
  let disposed = false;
  let governanceRead = null;
  let governanceState = "pending";
  const completedNodes = new Map();
  const blockedNodes = new Map();
  const pendingRequests = new Map();
  // Per question: the form's message, whether a write or read is in flight,
  // and whether the form is obsolete and must be reloaded before any write.
  const formState = new Map();
  const fingerprints = new Map();
  const filters = { repo: "", stage: "", blockedOnly: false };
  let liveExpanded = readLivePreference(storage);
  let currentView = null;
  const standalone = Boolean(doc.querySelector(".progress-main")) && !deps.openTask;
  let workView = "active";
  const workViewState = new Map(WORK_VIEWS.map(view => [view.id, { expanded: new Set(), scroll: 0, cardId: null }]));
  let workViewMenu = null;
  let workViewResize = null;

  let boardState = "pending";
  let lastRead = null;
  let readSeq = 0;
  let latestRead = null;
  // Cards and unchanged question cards keep their nodes across renders, so
  // focus, drafts and the dialog's return target survive every poll.
  const cardNodes = new Map();
  let questionCards = new Map();
  let viewSignature = "";
  let directorySignature = "";
  const badgeTimes = new Map();
  let ageTimer = null, ageAttempts = 0;
  const agePresence = watchPresence({ document: doc, window: win,
    now: () => currentNow().getTime(),
    onResume: () => { ageAttempts = 0; refreshAges(); },
    onWake: () => { ageAttempts = 0; refreshAges(); } });
  // On the system board the pipeline shows the system-work census (unfinished
  // work plus recent Live) instead of snapshot tasks; every other panel still
  // reads the snapshot.
  let systemWork = null;
  let censusPipeline = null;
  let censusObservation = {state:'pending'};
  let pipelineCards = [];
  let hierarchyUI = null;
  let queueUI = null;
  let orchestratorUI = null;
  let boardReadController = null;

  function el(tag, className, text, attributes = {}) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    setAttributes(node, attributes);
    return node;
  }

  // The page CSP (style-src 'self') refuses a style attribute written with setAttribute;
  // the CSSOM write below is allowed, so stage and pulse colours actually paint.
  function setAttributes(node, attributes) {
    for (const [name, value] of Object.entries(attributes)) {
      if (name === "style") node.style.cssText = String(value);
      else node.setAttribute(name, String(value));
    }
  }

  function svg(tag, className, attributes = {}, text) {
    const node = doc.createElementNS(SVG_NS, tag);
    if (className) node.setAttribute("class", className);
    setAttributes(node, attributes);
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function link(href, text) {
    const url = safeHref(href);
    if (!url) return el("span", "", text);
    const anchor = el("a", "", text, { href: url, target: "_blank", rel: "noopener noreferrer" });
    anchor.addEventListener("click", event => event.stopPropagation());
    return anchor;
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined,
      { dateStyle: "medium", timeStyle: "short", hour12: true }).format(date);
  }

  // ── publication freshness ─────────────────────────────────────────────────
  function updateBadge(badge, updatedAt) {
    const age = boardFreshness(updatedAt, currentNow());
    const label = `${age.label}${age.state === "stale" ? " · Stale · 24h+" : ""}`;
    if (badge.textContent !== label) badge.textContent = label;
    badge.setAttribute("data-freshness", age.state);
  }

  // This clock only patches badge text. It never reads the network or rebuilds
  // controls, and wakes at publication-relative minute boundaries (including 24h).
  function refreshAges() {
    if (disposed) return;
    orchestratorUI?.ages();
    clearTimer(ageTimer);
    let delay = Infinity;
    const at = currentNow().getTime();
    for (const [badge, updatedAt] of badgeTimes) {
      if (badge.isConnected === false) { badgeTimes.delete(badge); continue; }
      updateBadge(badge, updatedAt);
      const next = nextFreshnessChange(updatedAt, at);
      if (next !== null) delay = Math.min(delay, next);
    }
    if (Number.isFinite(delay) && agePresence.active() && ageAttempts++ < 1800) ageTimer = setTimer(refreshAges, Math.min(delay, 60000));
  }

  function freshnessBadge(updatedAt) {
    const badge = el("span", "freshness-badge");
    badgeTimes.set(badge, updatedAt);
    updateBadge(badge, updatedAt);
    return badge;
  }

  function announce(message) {
    byId("board-live").textContent = message;
  }

  // ── published board directory ─────────────────────────────────────────────
  function filterDirectory() {
    const query = byId("directory-search").value.trim().toLocaleLowerCase();
    const entries = [...byId("board-directory").querySelectorAll(".board-link")];
    let count = 0;
    for (const entry of entries) {
      entry.hidden = !entry.dataset.search.includes(query);
      if (!entry.hidden) count++;
    }
    byId("directory-results").textContent = entries.length && !count ? "No boards match your search." : "";
  }

  function renderDirectory(read) {
    const boards = boardDirectory(read);
    const directory = byId("board-directory");
    byId("directory-error").hidden = true;
    const signature = JSON.stringify(boards);
    if (signature === directorySignature || directory.contains(doc.activeElement)) return;
    const changed = Boolean(directorySignature);
    directorySignature = signature;
    directory.replaceChildren();
    for (const board of boards) {
      const item = el("a", "board-link", undefined,
        { href: boardPageUrl(board.board_id), target: "_blank", rel: "noopener noreferrer", "data-board-id": board.board_id,
          "data-search": [board.title, board.project, board.board_id].filter(Boolean).join(" ").toLocaleLowerCase() });
      if (board.board_id === boardId) item.setAttribute("aria-current", "page");
      item.append(el("span", "eyebrow", board.board_id === SYSTEM_BOARD_ID ? "System-wide" : "Project"),
        el("h3", "", board.title || board.project || board.board_id));
      const published = el("time", "board-published", formatTime(board.updated_at) || "Publication time unavailable");
      if (board.updated_at) published.dateTime = board.updated_at;
      const counts = Object.entries(board.task_counts || {}).map(([status, count]) => `${count} ${status}`).join(" · ");
      item.append(published, freshnessBadge(board.updated_at), el("span", "board-counts", counts || "0 tasks"));
      directory.append(item);
    }
    if (!boards.length) directory.append(el("p", "empty", "No published boards."));
    filterDirectory();
    refreshAges();
    if (changed) announce("Published boards updated.");
  }

  function clearDirectory() {
    directorySignature = "";
    byId("board-directory").replaceChildren();
    byId("directory-results").textContent = "";
  }

  function loadDirectory(seq) {
    if (orchestratorView || typeof client.listProgressBoards !== "function") return;
    client.listProgressBoards().then(read => {
      if (seq === readSeq) renderDirectory(read);
    }).catch(cause => {
      if (seq === readSeq) readFailure(cause, "directory");
    });
  }

  function setError(message) {
    const error = byId("board-error");
    error.textContent = message || "";
    error.hidden = !message;
  }

  function pulseSpeed(id) {
    return PULSES.find(pulse => pulse.id === id)?.speed || "0s";
  }

  function stageColor(id) {
    return STAGE_DEFINITIONS.find(stage => stage.id === id)?.color || "var(--fg)";
  }

  function clickable(node, open) {
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.addEventListener("click", open);
    node.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
    });
  }

  // ── legend ────────────────────────────────────────────────────────────────
  function renderLegend() {
    const body = byId("legend-body");
    body.replaceChildren();
    for (const group of legendEntries()) {
      const section = el("section", "legend-group");
      section.append(el("h3", "", group.name));
      const list = el("dl", "legend-list");
      for (const entry of group.entries) {
        const row = el("div", "legend-entry", undefined, { "data-legend-id": entry.id });
        const sample = el("dt", "legend-sample");
        sample.setAttribute("aria-hidden", "true");
        if (entry.id.startsWith("stage-")) sample.append(el("span", "swatch", undefined, { style: `--swatch:${entry.swatch}` }));
        else if (entry.id.startsWith("glyph-")) sample.append(el("span", "glyph", entry.glyph));
        else if (entry.id.startsWith("pulse-")) {
          const dot = el("span", "legend-pulse", undefined,
            { "data-pulse": entry.pulse, style: `--pulse-speed:${entry.speed || "0s"};--pulse-color:${entry.swatch}` });
          sample.append(dot);
        } else if (entry.id === "outline-dashed") sample.append(el("span", "dashed-sample"));
        else if (entry.id === "badge-question") sample.append(el("span", "badge-question", "?"));
        else if (entry.id === "flag-stale") sample.append(el("span", "flag-stale", "stale 7h"));
        else if (entry.id === "flag-unrefreshed") sample.append(el("span", "flag-unrefreshed", "not refreshed"));
        else if (entry.id === "note-release-wait") sample.append(el("span", "wait-sample", "waiting"));
        const meaning = el("dd", "");
        meaning.append(el("strong", "", entry.label), el("span", "", entry.meaning));
        row.append(sample, meaning);
        list.append(row);
      }
      section.append(list);
      body.append(section);
    }
  }

  function wireLegend() {
    const toggle = byId("legend-toggle");
    const legend = byId("legend");
    toggle.addEventListener("click", () => {
      legend.hidden = !legend.hidden;
      toggle.setAttribute("aria-expanded", String(!legend.hidden));
    });
    doc.addEventListener("keydown", event => {
      if (event.key === "Escape" && !legend.hidden) {
        legend.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ── cards ─────────────────────────────────────────────────────────────────
  function fingerprint(card) {
    return JSON.stringify([card.stage, card.status, card.health, card.pr_phase, card.pr_head,
      card.updated_at, card.release_wait, card.stale]);
  }

  function cardNode(card, index) {
    const node = el("article", "board-card", undefined, {
      "data-card-id": card.id, "data-task-id": card.id, "data-stage": card.stage, "data-pulse": card.pulse,
      "data-indicators": card.indicators.join(" "),
      style: `--stage-accent:${stageColor(card.stage)};--pulse-speed:${pulseSpeed(card.pulse)};--i:${Math.min(index, 12)}`,
      "aria-label": `${card.title || card.id}, ${STAGE_DEFINITIONS.find(stage => stage.id === card.stage).label}. Open work detail.`,
    });
    if (card.indicators.includes("outline-dashed")) node.classList.add("outline-dashed");
    const previous = fingerprints.get(card.id);
    const now = fingerprint(card);
    if (previous && previous !== now) node.classList.add("changed");
    fingerprints.set(card.id, now);

    const top = el("div", "card-top");
    const pool = executorPool(card.executor);
    const glyph = el("span", "glyph", executorGlyph(card.executor),
      { title: EXECUTORS.find(item => item.pool === pool).label, "data-pool": pool });
    glyph.prepend(el("span", "halo", undefined, { "aria-hidden": "true" }));
    const title = el("strong", "card-title", card.title || card.id, { title: card.title || card.id });
    top.append(glyph, title);
    if (card.indicators.includes("badge-question"))
      top.append(el("span", "badge-question", "?", { title: "Waiting on an answer or a review" }));
    if (card.indicators.includes("flag-stale"))
      top.append(el("span", "flag-stale", `stale ${ageText(card.updated_at, currentNow())}`,
        { "data-stale-since": card.updated_at, title: "No update for 6 hours or more" }));
    if (card.sync_failed)
      top.append(el("span", "flag-unrefreshed", "not refreshed",
        { title: "GitHub could not be read for this card; it shows its last verified state" }));
    node.append(top);

    const compact = Boolean(deps.openTask);
    const summary = taskSummary(card);
    if (!compact || summary.replace(/\.+$/, "") !== String(card.title || card.id).replace(/\.+$/, ""))
      node.append(el("p", "card-summary", summary, { title: summary }));
    const meta = el("p", "card-meta");
    const links = jobLinks(card);
    if (links.workRequest || !compact) meta.append(el("span", "card-wr", links.workRequest || "Work Request unavailable"));
    if (links.prLabel || !compact) meta.append(el("span", "card-pr", links.prLabel || "No PR"));
    const entered = stageEnteredAt(card);
    if (entered || !compact) {
      if (meta.childElementCount) meta.append(el("span", "dot", "·"));
      meta.append(el("span", "stage-timer", `${card.stage} ${ageText(entered, currentNow())}`,
        { "data-stage-since": entered || "", "data-stage": card.stage, title: "Time in this stage" }));
    }
    if (meta.childElementCount) node.append(meta);
    const model = modelLine(card).split(" · ").filter(value => !compact || !/^(unknown|not recorded)$/i.test(value)).join(" · ");
    if (model) node.append(el("p", "card-model", model, { title: model }));
    if (card.blocked) {
      const blocked = el("div", "card-blocked");
      blocked.append(el("p", "", `Why: ${card.blocked.reason}`), el("p", "", `Next: ${card.blocked.next}`));
      node.append(blocked);
    }
    if (card.indicators.includes("note-release-wait")) {
      const wait = `Waiting on release · ${card.release_wait}`;
      node.append(el("p", "card-wait", wait, { title: wait }));
    }
    clickable(node, () => openWork(card.id));
    return node;
  }

  // The first node drawn for a card is kept and updated in place.
  function placeCard(card, index) {
    const fresh = cardNode(card, index);
    const kept = cardNodes.get(card.id);
    if (!kept) { cardNodes.set(card.id, fresh); return fresh; }
    if (fresh.classList.contains("changed")) { kept.classList.remove("changed"); void kept.offsetWidth; }
    for (const attribute of [...kept.attributes]) if (!fresh.hasAttribute(attribute.name)) kept.removeAttribute(attribute.name);
    for (const attribute of fresh.attributes) kept.setAttribute(attribute.name, attribute.value);
    kept.replaceChildren(...fresh.childNodes);
    return kept;
  }

  function currentNow() {
    return now();
  }

  // ── pipeline ──────────────────────────────────────────────────────────────
  function censusCards() {
    if (!censusPipeline) return null;
    const tasks = {};
    for (const stage of censusPipeline.stages)
      for (const task of stage.tasks) tasks[task.id] = { ...task, stage: stage.id };
    return boardView({ snapshot: { board_id: SYSTEM_BOARD_ID, version: 1, snapshot_json: { tasks } } }, currentNow()).cards;
  }

  function findCard(cardId) {
    return pipelineCards.find(card => card.id === cardId) || currentView?.cards.find(card => card.id === cardId) || null;
  }

  function renderRail(visible, stages) {
    const rail = byId("board-rail");
    rail.replaceChildren();
    const step = 600 / stages.length;
    stages.forEach((stage, index) => {
      if (index < stages.length - 1 && stage.sequence !== false && stages[index + 1].sequence !== false)
        rail.append(svg("path", "rail-line", { d: `M ${step / 2 + index * step} 20 H ${step / 2 + (index + 1) * step}` }));
    });
    stages.forEach((stage, index) => {
      const x = step / 2 + index * step;
      const count = visible.filter(card => card.stage === stage.id).length;
      rail.append(svg("circle", "rail-node", { cx: x, cy: 20, r: 7, style: `--stage-accent:${stage.color}`,
        "data-active": count ? "true" : "false" }));
    });
  }

  function renderFilters(view) {
    const repo = byId("filter-repo");
    const stage = byId("filter-stage");
    const repos = [...new Set([...view.repos.map(row => row.repo), ...view.cards.map(taskRepo)])].sort();
    repo.replaceChildren(el("option", "", "All", { value: "" }),
      ...repos.map(name => el("option", "", name.split("/")[1], { value: name })));
    stage.replaceChildren(el("option", "", "All", { value: "" }),
      ...view.stages.map(item => el("option", "", item.label, { value: item.id })));
    if (!repos.includes(filters.repo)) filters.repo = "";
    repo.value = filters.repo;
    stage.value = filters.stage;
    byId("filter-blocked").checked = filters.blockedOnly;
    repo.closest("label").hidden = repos.length < 2;
  }

  function wireFilters() {
    byId("filter-repo").addEventListener("change", event => { filters.repo = event.target.value; renderStages(currentView); });
    byId("filter-stage").addEventListener("change", event => { filters.stage = event.target.value; renderStages(currentView); });
    byId("filter-blocked").addEventListener("change", event => { filters.blockedOnly = event.target.checked; renderStages(currentView); });
    byId("board-filters").addEventListener("submit", event => event.preventDefault());
  }

  function appendCards(container, cards, grouped) {
    let index = 0;
    if (!grouped) {
      for (const card of cards) container.append(placeCard(card, index++));
      return;
    }
    for (const group of groupByRepo(cards)) {
      container.append(el("h4", "repo-group", group.repo.split("/")[1], { title: group.repo }));
      for (const card of group.cards) container.append(placeCard(card, index++));
    }
  }

  function toggleLive() {
    liveExpanded = !liveExpanded;
    writeLivePreference(storage, liveExpanded);
    renderStages(currentView);
    byId("live-toggle")?.focus?.();
  }

  function hasWorkViews(view) {
    return standalone && Boolean(view) && !orchestratorView && !view.hierarchy && !queueBoardView;
  }

  function rememberWorkCard(event) {
    const card = event.target.closest(".board-card");
    if (card && hasWorkViews(currentView)) workViewState.get(workView).cardId = card.dataset.cardId;
  }

  function workScroll() {
    return doc.querySelector(".progress-main")?.closest(".app-layout-center");
  }

  function chooseWorkView(id) {
    if (disposed || !hasWorkViews(currentView) || id === workView) return;
    const state = workViewState.get(workView);
    state.scroll = workScroll()?.scrollTop ?? win.scrollY ?? 0;
    workView = id;
    render(currentView);
    const next = workViewState.get(id);
    const selected = cardNodes.get(next.cardId);
    if (selected?.isConnected) selected.focus({ preventScroll: true });
    const scroller = workScroll();
    if (scroller) scroller.scrollTop = next.scroll;
    else win.scrollTo?.({ top: next.scroll, behavior: "instant" });
  }

  function renderWorkViewMenu(cards, enabled) {
    if (!standalone) return;
    if (!workViewMenu) {
      workViewMenu = el("nav", "work-view-menu", undefined, { "aria-label": "Work views", hidden: "" });
      for (const view of WORK_VIEWS) {
        const button = el("button", "work-view-button", view.label, {
          type: "button", "data-work-view": view.id, "aria-pressed": "false" });
        button.addEventListener("click", () => chooseWorkView(view.id));
        workViewMenu.append(button);
      }
      doc.querySelector(".pipeline-panel").before(workViewMenu);
      if (win.ResizeObserver) {
        const menu = workViewMenu;
        const main = doc.querySelector(".progress-main");
        workViewResize = new win.ResizeObserver(() => {
          main.style.setProperty("--work-view-menu-height", `${menu.getBoundingClientRect().height}px`);
        });
        workViewResize.observe(menu);
      }
    }
    workViewMenu.hidden = !enabled;
    doc.querySelector(".progress-main").classList.toggle("has-work-views", enabled);
    if (!enabled) return;
    for (const view of WORK_VIEWS) {
      const button = workViewMenu.querySelector(`[data-work-view="${view.id}"]`);
      button.textContent = `${view.label} · ${cardsForView(cards, view.id).length}`;
      button.setAttribute("aria-pressed", String(view.id === workView));
    }
  }

  function applyWorkViewVisibility(view) {
    if (!hasWorkViews(view)) return;
    const history = workView === "history";
    for (const node of doc.querySelectorAll(".blocked-panel, .completed-panel, .lower-grid")) node.hidden = !history;
    if (!history)
      for (const node of doc.querySelectorAll(".repos-panel, .cost-panel")) node.hidden = true;
    byId("system-work-panel").hidden = !history || !systemWork;
    doc.querySelector(".questions-panel").hidden = !["active", "history"].includes(workView) || !view.questions.length;
  }

  function renderStages(view) {
    if (disposed) return;
    const container = byId("board-stages");
    if (queueBoardView) {
      queueUI ||= mountQueueBoard({ container, client, document: doc, window: win, onJobs: (jobs, observation) => {
        byId("task-count").textContent = observation.state === "read" ? `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}` : "—";
      } });
      byId("pipeline-title").textContent = "Work queue";
      for (const id of ["board-rail", "board-filters"]) byId(id).setAttribute("hidden", "");
      for (const id of ["board-completed", "completed-list", "board-blocked", "board-ledger"])
        byId(id)?.closest(".panel")?.setAttribute("hidden", "");
      return;
    }
    if (!view && boardState === "pending") {
      container.setAttribute("aria-busy", "true");
      container.classList.add("hierarchy-board");
      byId("pipeline-title").textContent = boardId === SYSTEM_BOARD_ID ? "Work Requests" : "Loading board";
      const loading = el("div", "hierarchy-loading");
      loading.setAttribute("aria-hidden", "true");
      loading.append(el("div", "hierarchy-toolbar"));
      const rows = el("div", "hierarchy-grid");
      for (let index = 0; index < 3; index++) rows.append(el("div", "hierarchy-card hierarchy-skeleton"));
      loading.append(rows);
      container.replaceChildren(loading);
      return;
    }
    container.removeAttribute("aria-busy");
    renderWorkViewMenu([], false);
    if (orchestratorView) {
      byId('pipeline-title').textContent = 'Orchestrator';
      for (const id of ['board-rail', 'board-filters']) byId(id).setAttribute('hidden', '');
      for (const id of ['board-completed','completed-list','board-blocked','system-work-panel','board-ledger'])
        byId(id)?.closest('.panel')?.setAttribute('hidden', '');
      if (!view?.orchestrator) {
        if (orchestratorUI) { orchestratorUI.offline(); return; }
        container.textContent = 'The orchestrator view has not been published yet. The last observation is unknown.';
        return;
      }
      orchestratorUI ||= mountOrchestrator({container, window:win, now:currentNow, readPage: args => client.readProgressBoard(args)});
      orchestratorUI.update(view.orchestrator);
      byId('task-count').textContent = `${view.orchestrator.total_cards ?? view.orchestrator.cards.length} recorded ${(view.orchestrator.total_cards ?? view.orchestrator.cards.length) === 1 ? 'item' : 'items'}`;
      return;
    }
    if (view?.hierarchy) {
      pipelineCards = Object.entries(view.hierarchy.cards).map(([id, card]) => ({...card, id, title:card.card_title, summary:card.card_description}));
      if (!hierarchyUI) doc.querySelector("details.directory-panel")?.removeAttribute("open");
      hierarchyUI ||= mountHierarchy({container:byId("board-stages"), window:win, onOpen:card=>openWork(card.id), onClose:deps.closeTask});
      const selected = hierarchyUI.update({hierarchy:view.hierarchy, tasks:view.hierarchy.cards});
      deps.onTasks?.(pipelineCards, {state:boardState, selectedId:selected?.id});
      byId("board-rail").setAttribute("hidden", "");
      byId("board-filters").hidden = true;
      for (const id of ["board-completed", "completed-list", "board-blocked", "system-work-panel", "board-ledger"])
        byId(id)?.closest(".panel")?.setAttribute("hidden", "");
      return;
    }
    container.classList.remove("hierarchy-board");
    byId("pipeline-title").textContent = "The path to live";
    const census = deps.openTask ? censusCards() : null;
    const mode = byId("board-data-mode");
    if (mode) mode.textContent = census ? "Live work · The pipeline shows current work."
      : view ? "Published snapshot · The pipeline shows published work." : "";
    if (!view && !census) { container.querySelector(".hierarchy-loading")?.remove(); return; }
    const original = census || view.cards;
    const approvals = governanceTasks(governanceRead);
    const approvalCards = approvals && boardView({snapshot:{board_id:boardId, version:1,
      snapshot_json:{tasks:Object.fromEntries(approvals.map(task=>[task.id, {...task, source_state:governanceState}]))}}},currentNow()).cards;
    const stages = census ? censusPipeline.stages : view.stages;
    const merged = withGovernance({stages:stages.map(stage=>({...stage,
      tasks:original.filter(card=>card.stage===stage.id)}))},approvalCards);
    const all = merged.stages.flatMap(stage=>stage.tasks.map(task=>({...task,
      ...(boardId !== SYSTEM_BOARD_ID ? {task_id:task.task_id || task.id} : {})})));
    deps.onTasks?.(all,systemWork ? censusObservation : {state:boardState});
    renderFilters({repos:view?.repos || [],cards:all,stages});
    if (!hasWorkViews(view) || workView === "history") renderCompleted({...view, cards:all,stages});
    else (byId("completed-list") || byId("board-completed")).replaceChildren();
    const kind = census ? "project" : view.kind;
    pipelineCards = all;
    const focusedId = [...cardNodes].find(([, node]) => node === doc.activeElement)?.[0];
    const focusedControlId = container.contains(doc.activeElement) ? doc.activeElement.id : null;
    container.replaceChildren();
    const workViews = hasWorkViews(view);
    renderWorkViewMenu(all, workViews);
    const visible = filterCards(workViews ? cardsForView(all, workView) : all, filters);
    const grouped = kind === ALL_REPOS_BOARD;
    byId("task-count").textContent = `${visible.length} OF ${all.length} CARD${all.length === 1 ? "" : "S"}`;
    renderRail(visible, stages);
    stages.forEach(stage => {
      const cards = visible.filter(card => card.stage === stage.id);
      if (!cards.length) return;
      const column = el("section", "column", undefined,
        { "data-stage": stage.id, style: `--stage-accent:${stage.color}`, "aria-label": `${stage.label}: ${cards.length}` });
      const head = el("header", "column-head");
      head.append(el("h3", "stage-label", stage.label), el("span", "stage-count", String(cards.length)));
      if (workViews && cards.length > WORK_LANE_LIMIT) {
        const expanded = workViewState.get(workView).expanded;
        const toggle = el("button", "lane-toggle", expanded.has(stage.id) ? "Show fewer" : `Show all ${cards.length}`, {
          id: `lane-toggle-${stage.id}`, type: "button", "aria-expanded": String(expanded.has(stage.id)),
          "aria-label": `${expanded.has(stage.id) ? "Show fewer" : "Show all"} ${stage.label.toLowerCase()} cards` });
        toggle.addEventListener("click", () => {
          if (expanded.has(stage.id)) expanded.delete(stage.id); else expanded.add(stage.id);
          renderStages(currentView);
          byId(`lane-toggle-${stage.id}`)?.focus({ preventScroll: true });
        });
        head.append(toggle);
      }
      column.append(head);
      const body = el("div", "column-body");
      if (workViews) {
        const shown = workViewState.get(workView).expanded.has(stage.id) ? cards : cards.slice(0, WORK_LANE_LIMIT);
        appendCards(body, shown, grouped);
      } else if (stage.id === "live") {
        const live = liveView(cards, liveExpanded, kind);
        column.dataset.collapsed = String(!liveExpanded);
        if (!liveExpanded && live.total)
          body.append(el("p", "live-summary", `${live.total} live · latest ${Math.min(LIVE_PREVIEW, live.total)} shown`));
        appendCards(body, live.shown, false);
        if (live.total > LIVE_PREVIEW) {
          const button = el("button", "live-toggle", liveExpanded ? `Show latest ${LIVE_PREVIEW}` : `Show all ${live.total}`,
            { id: "live-toggle", type: "button", "aria-expanded": String(liveExpanded) });
          button.addEventListener("click", toggleLive);
          body.append(button);
        }
      } else {
        appendCards(body, cards, grouped);
      }
      column.append(body);
      container.append(column);
    });
    if (!visible.length) container.append(el("p", "empty", all.length ? "No tasks match these filters." : "No tasks on this board yet."));
    for (const id of [...cardNodes.keys()]) if (!all.some(card => card.id === id)) cardNodes.delete(id);
    if (focusedId || focusedControlId) {
      const node = focusedId ? cardNodes.get(focusedId) : byId(focusedControlId);
      (node?.isConnected ? node : byId("board-title")).focus();
    }
    // Cards animate in on the first draw only; later renders (refresh, tick)
    // flash just the cards whose state changed.
    // eslint-disable-next-line no-restricted-syntax -- 1 callback per explicit dispatch; no self-rearm. No automatic retry; deadline, debounce, paint, or completion callback only Completes once or is cancelled/replaced by its owner; never schedules repeating idle work
    requestAnimationFrame(() => { container.dataset.settled = "true"; });
  }

  // ── panels ────────────────────────────────────────────────────────────────
  function renderHeadline(view) {
    const counts = headline(view);
    const box = byId("board-headline");
    box.replaceChildren(
      el("strong", "h-running", `${counts.running} running`),
      el("strong", "h-waiting", `${counts.waiting} need Joe`),
      el("strong", "h-blocked", `${counts.blocked} blocked`),
      el("strong", "h-stale", `${counts.stale} stale`),
      el("strong", "h-live", `${counts.live} live · ${counts.remaining} remaining`));
  }

  function renderRepos(view) {
    const panel = byId("repos-panel");
    panel.hidden = view.kind !== ALL_REPOS_BOARD;
    const list = byId("board-repos");
    list.replaceChildren();
    byId("repo-count").textContent = `${view.repos.length} REPOS`;
    for (const row of view.repos) {
      const item = el("button", "repo-chip", undefined, { type: "button", "data-repo": row.repo, title: row.repo });
      item.append(el("strong", "", row.repo.split("/")[1]),
        el("span", "", `${Number(row.open) || 0} open · ${Number(row.merged) || 0} merged`));
      if (row.error) {
        item.classList.add("repo-error");
        item.append(el("span", "repo-error-text", "gh read failed; showing the last cards"));
      }
      item.addEventListener("click", () => {
        filters.repo = filters.repo === row.repo ? "" : row.repo;
        byId("filter-repo").value = filters.repo;
        renderStages(currentView);
      });
      list.append(item);
    }
  }

  function renderBlocked(view) {
    const list = byId("board-blocked");
    const focusedId = [...blockedNodes].find(([,node])=>node===doc.activeElement)?.[0];
    list.replaceChildren();
    const blocked = view.cards.filter(card => card.blocked);
    byId("blocked-count").textContent = `${blocked.length} BLOCKED`;
    if (!blocked.length) list.append(el("p", "empty", "Nothing is blocked."));
    for (const card of blocked) {
      const item = el("article", "blocked-card", undefined, { "data-card-id": card.id, "data-task-id": card.id, style: `--stage-accent:${stageColor(card.stage)}` });
      const top = el("div", "blocked-top");
      top.append(el("strong", "card-title", card.title || card.id, { title: card.title || card.id }),
        el("span", "card-pr", jobLinks(card).prLabel || "No PR"));
      item.append(top, el("p", "card-wr", jobLinks(card).workRequest || "Work Request unavailable"), el("p", "blocked-why", `Why: ${card.blocked.reason}`),
        el("p", "blocked-next", `Next: ${card.blocked.next}`));
      clickable(item, () => openWork(card.id));
      const retained = blockedNodes.get(card.id);
      if (retained) { retained.replaceChildren(...item.childNodes); retained.style.setProperty("--stage-accent",stageColor(card.stage)); list.append(retained); }
      else { blockedNodes.set(card.id,item); list.append(item); }
    }
    for (const id of blockedNodes.keys()) if (!blocked.some(card=>card.id===id)) blockedNodes.delete(id);
    if (focusedId) (blockedNodes.get(focusedId) || byId("blocked-title") || byId("board-title")).focus();
  }

  function renderLedger(view) {
    const box = byId("board-ledger");
    box.replaceChildren();
    for (const row of view.ledger) {
      const item = el("div", `ledger-row${row.violation ? " ledger-violation" : ""}`, undefined, { "data-pool": row.pool });
      const head = el("div", "ledger-head");
      head.append(el("span", "glyph", row.glyph), el("span", "ledger-label", row.label),
        el("strong", "ledger-count", String(Number(row.count) || 0).padStart(2, "0")));
      item.append(head);
      if (row.violation) item.append(el("p", "ledger-flag", "POLICY VIOLATION · in-plan Claude subagent"));
      for (const model of row.models || []) {
        const text = `${model.provider} · ${model.model} · ${model.effort} ×${model.count}`;
        item.append(el("p", "ledger-model", text, { title: text }));
      }
      box.append(item);
    }
  }

  function renderDeliverables(view) {
    const box = byId("board-deliverables");
    box.replaceChildren();
    byId("deliverable-count").textContent = `${view.deliverables.length} LINKS`;
    if (!view.deliverables.length) { box.append(el("p", "empty", "No deliverables yet.")); return; }
    for (const item of view.deliverables) {
      const row = el("div", "link-row");
      row.append(link(item.link, item.title || "Deliverable"), el("time", "", formatTime(item.created_at)));
      box.append(row);
    }
  }

  function renderDecisions(view) {
    const box = byId("board-decisions");
    box.replaceChildren();
    const answered = view.questions.filter(q => q.status);
    byId("decision-count").textContent = `${view.decisions.length + answered.length} MADE`;
    if (!view.decisions.length && !answered.length) { box.append(el("p", "empty", "No decisions recorded yet.")); return; }
    for (const decision of view.decisions) {
      const row = el("article", "decision");
      row.append(el("strong", "", decision.question), el("p", "", `Answer: ${decision.answer}`),
        el("time", "", formatTime(decision.answered_at)));
      box.append(row);
    }
    for (const q of answered) {
      const row = el("article", "decision", undefined, { "data-status": q.status });
      row.append(el("strong", "", q.prompt), el("p", "", `Answer: ${q.answer_text || ""} · ${q.status}`));
      box.append(row);
    }
  }

  function renderNotes(view) {
    const box = byId("board-notes");
    box.replaceChildren();
    if (!view.notes.length) { box.append(el("p", "empty", "No notes.")); return; }
    for (const note of view.notes) {
      const row = el("article", "note");
      row.append(el("p", "", note.text), el("time", "", formatTime(note.created_at)));
      box.append(row);
    }
  }

  function renderCompleted(view) {
    const box = (byId("completed-list") || byId("board-completed"));
    const focusedId = [...completedNodes].find(([,node])=>node===doc.activeElement)?.[0];
    box.replaceChildren();
    const completed = sortLive(view.cards.filter(card => ["live","recorded"].includes(card.stage)), view.kind);
    const liveCount = completed.filter(card => card.stage === "live").length;
    const recordedCount = completed.length - liveCount;
    const hasRecorded = view.stages.some(stage => stage.id === "recorded");
    byId("completed-count").textContent = hasRecorded ? `${liveCount} LIVE · ${recordedCount} RECORDED` : `${liveCount} LIVE`;
    if (!completed.length) { box.append(el("p", "empty", hasRecorded ? "No completed records yet." : "No live tasks yet.")); if (focusedId) (deps.openTask ? byId("board-title") : byId("completed-title")).focus(); return; }
    for (const card of completed) {
      const item = el("article", "completed-card", undefined, { "data-card-id": card.id, "data-task-id": card.id,
        "data-stage": card.stage, "aria-label": `${card.title || card.id}, ${STAGE_DEFINITIONS.find(stage => stage.id === card.stage).label}. Open work detail.` });
      const top = el("div", "completed-top");
      top.append(el("strong", "card-title", card.title || card.id, { title: card.title || card.id }),
        el("time", "", formatTime(card.completed_at || card.updated_at)));
      const model = modelLine(card);
      const summary = taskSummary(card);
      item.append(top, el("p", "card-summary", summary, { title: summary }),
        el("p", "completed-evidence", card.evidence || ""),
        el("p", "card-model", model, { title: model }),
        el("p", "card-wr", jobLinks(card).workRequest || "Work Request unavailable"), el("p", "card-pr", jobLinks(card).prLabel || "No PR"));
      clickable(item, () => openWork(card.id));
      const kept = completedNodes.get(card.id);
      if (kept) {
        kept.setAttribute("data-stage",card.stage);kept.setAttribute("aria-label",item.getAttribute("aria-label"));
        kept.replaceChildren(...item.childNodes); box.append(kept);
      }
      else { completedNodes.set(card.id,item); box.append(item); }
    }
    for (const id of completedNodes.keys()) if (!completed.some(card=>card.id===id)) completedNodes.delete(id);
    if (focusedId) (completedNodes.get(focusedId) || (deps.openTask ? byId("board-title") : byId("completed-title"))).focus();
  }

  // ── work detail ──────────────────────────────────────────────────────────
  // Card selection belongs to the Control Room popup.
  function openWork(cardId) {
    const card = findCard(cardId);
    if (!card) return;
    if (deps.openTask) deps.openTask({...card,source_state:card.source_state || boardState});
    else location.href = workDetailUrl({board:boardId,task:card.id,workRequest:jobLinks(card).workRequest});
  }

  // ── questions ─────────────────────────────────────────────────────────────
  function liveForm(questionId) {
    return [...byId("board-questions").querySelectorAll(".answer-form")]
      .find(form => form.dataset.questionId === questionId) || null;
  }

  function applyFormState(form, state) {
    const button = form.querySelector("button[type=submit]");
    form.querySelector(".form-message").textContent = state.message || "";
    button.disabled = Boolean(state.busy);
    button.textContent = state.reload ? "Reload question" : "Send answer";
  }

  // Forms are rebuilt on every render, so state lives here and is applied to
  // whichever form is on the page now.
  function setFormState(questionId, patch) {
    const state = { ...(formState.get(questionId) || {}), ...patch };
    formState.set(questionId, state);
    const form = liveForm(questionId);
    if (form) applyFormState(form, state);
  }

  // A conflict makes the form obsolete: only a successful read may replace it.
  async function reloadQuestion(questionId, message) {
    setFormState(questionId, { busy: true, reload: true, message });
    let applied = false;
    try { applied = await refresh(true); } catch { applied = false; }
    if (applied) {
      formState.delete(questionId);
      questionCards.delete(questionId);
      renderQuestions(currentView);
      return;
    }
    setFormState(questionId, { busy: false, reload: true,
      message: "This question changed elsewhere and its latest version could not be loaded. Reload question to try again." });
  }

  function answerForm(q, view, draft) {
    const form = el("form", "answer-form");
    form.dataset.questionId = q.question_id;
    const message = el("p", "form-message");
    const choiceInputs = [];
    let freeText = null;
    if (q.choices.length) {
      const options = el("div", "answer-options");
      for (const [index, choice] of q.choices.entries()) {
        const label = el("label", "answer-option");
        const input = el("input", "", undefined, { type: "radio", name: `answer-${q.question_id}`,
          id: `choice-${q.question_id}-${index}` });
        input.value = choice;
        choiceInputs.push(input);
        label.append(input, el("span", "", choice));
        options.append(label);
      }
      form.append(options);
    }
    if (q.allow_free_text) {
      const id = `free-${q.question_id}`;
      const label = el("label", "", q.choices.length ? "Or write your answer" : "Your answer", { for: id });
      freeText = el("textarea", "", undefined, { id, maxlength: 4000, placeholder: "Type your answer" });
      form.append(label, freeText);
    }
    if (q.default_answer) form.append(el("p", "question-detail", `If unanswered: ${q.default_answer}`));
    const button = el("button", "", "Send answer", { type: "submit" });
    const preview = el("output", "answer-preview", undefined, { "aria-live": "polite" });
    const actions = el("div", "answer-actions");
    actions.append(button, preview);
    form.append(actions, message);
    if (draft) {
      if (freeText && draft.text) freeText.value = draft.text;
      for (const input of choiceInputs) input.checked = input.value === draft.choice;
    }
    const selectedAnswer = () => freeText?.value.trim() || choiceInputs.find(input => input.checked)?.value || "";
    const showAnswer = () => {
      preview.textContent = `Will send: ${pendingRequests.get(q.question_id)?.answer_text || selectedAnswer() || "—"}`;
    };
    const lockAnswer = () => {
      for (const input of choiceInputs) input.disabled = true;
      if (freeText) freeText.disabled = true;
    };
    for (const input of choiceInputs) input.addEventListener("change", () => {
      if (freeText) freeText.value = "";
      showAnswer();
    });
    freeText?.addEventListener("input", () => {
      for (const input of choiceInputs) input.checked = false;
      showAnswer();
    });
    const state = formState.get(q.question_id);
    if (pendingRequests.has(q.question_id) || state?.reload) lockAnswer();
    showAnswer();
    if (state) applyFormState(form, state);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const questionId = q.question_id;
      const current = formState.get(questionId) || {};
      if (current.busy) return;
      if (current.reload) { await reloadQuestion(questionId, "Reloading this question…"); return; }
      const retained = pendingRequests.get(questionId);
      const value = retained?.answer_text || selectedAnswer();
      const key = retained?.idempotency_key || uuidv4();
      let args;
      try { args = retained || answerRequest(q, view.board_id, value, key); }
      catch (cause) { setFormState(questionId, { busy: false, message: cause.message }); return; }
      if (!retained) {
        const generation = readSeq;
        setFormState(questionId, { busy: true, message: "Checking current question…" });
        try {
          const latest = boardView(await client.readProgressBoard({ board_id: view.board_id }), currentNow());
          if (disposed) return;
          if (readSeq !== generation) {
            setFormState(questionId, { busy: false, message: "The board refreshed. Review the current question before sending." });
            return;
          }
          if (latest.error || latest.board_id !== view.board_id) throw new Error("Board unavailable");
          const currentQuestion = latest.questions.find(question => question.question_id === questionId);
          if (!currentQuestion || currentQuestion.status || currentQuestion.revision !== q.revision) {
            await reloadQuestion(questionId, "This question changed. Loading its current version…");
            setFormState(questionId, { busy: false, message: "This question changed. Review the current question and your kept draft before sending." });
            return;
          }
        } catch (cause) {
          if ([401, 403].includes(cause?.status)) readFailure(cause, "board");
          else setFormState(questionId, { busy: false, message: "Answer not sent. The current question could not be verified." });
          return;
        }
      }
      pendingRequests.set(questionId, args);
      lockAnswer();
      showAnswer();
      setFormState(questionId, { busy: true, message: "Saving answer…" });
      try {
        await client.answerBoardQuestion(args);
      } catch (cause) {
        const conflict = cause.payload?.error === "board_version_conflict" ||
          cause.payload?.error === "board_answer_already_sent";
        if (!conflict) {
          setFormState(questionId, { busy: false, message: "Answer status is unconfirmed. Retry will use the same request." });
          return;
        }
        pendingRequests.delete(questionId);
        await reloadQuestion(questionId, "This question changed or was answered elsewhere. Refreshing…");
        return;
      }
      pendingRequests.delete(questionId);
      formState.delete(questionId);
      const applied = await refresh(true).catch(() => false);
      if (!applied) setFormState(questionId, { busy: true, message: "Answer sent. The board will update on the next refresh." });
    });
    return form;
  }

  // Drafts, choices and focus in open forms survive every re-render.
  function captureDrafts(box) {
    const drafts = new Map();
    for (const form of box.querySelectorAll(".answer-form")) {
      drafts.set(form.dataset.questionId, {
        text: form.querySelector("textarea")?.value || "",
        choice: form.querySelector("input[type=radio]:checked")?.value ?? null,
      });
    }
    const active = doc.activeElement;
    const focus = active && box.contains(active) && active.id
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    return { drafts, focus };
  }

  function restoreFocus(focus) {
    if (!focus) return;
    const node = byId(focus.id);
    if (!node || node.disabled) return;
    node.focus();
    try { if (typeof focus.start === "number") node.setSelectionRange(focus.start, focus.end); } catch { /* radios have no selection */ }
  }

  function renderQuestions(view) {
    const box = byId("board-questions");
    const { drafts, focus } = captureDrafts(box);
    const prior = questionCards;
    questionCards = new Map();
    const open = new Set(view.questions.filter(q => !q.status).map(q => q.question_id));
    for (const id of [...formState.keys()]) if (!open.has(id)) formState.delete(id);
    byId("question-count").textContent = `${open.size} WAITING`;
    if (!view.questions.length) { box.replaceChildren(el("p", "empty", "No questions on this board.")); return; }
    const next = [];
    for (const q of view.questions) {
      const signature = JSON.stringify(q);
      const kept = prior.get(q.question_id);
      if (kept?.signature === signature) {
        questionCards.set(q.question_id, kept);
        next.push(kept.card);
        continue;
      }
      const card = el("article", "question-card");
      if (q.status) card.dataset.status = q.status;
      const top = el("div", "question-top");
      top.append(el("h3", "question-title", q.prompt), el("span", "status", q.status || "Waiting"));
      card.append(top);
      if (q.status) {
        card.append(el("p", "answer-text", q.answer_text || ""));
        const detail = [q.answered_by ? `Answered by ${q.answered_by}` : null,
          q.status === "Applied" && q.effect_ref ? `Applied: ${q.effect_ref}` : null].filter(Boolean).join(" · ");
        if (detail) card.append(el("p", "question-detail", detail));
      } else {
        card.append(answerForm(q, view, drafts.get(q.question_id)));
      }
      questionCards.set(q.question_id, { signature, card });
      next.push(card);
    }
    // Unchanged cards stay connected, so a focused control is never detached.
    next.forEach((card, index) => {
      if (box.children[index] !== card) box.insertBefore(card, box.children[index] || null);
    });
    for (const child of [...box.children]) if (!next.includes(child)) child.remove();
    restoreFocus(focus);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  function renderSwitch() {
    const project = byId("switch-project");
    const all = byId("switch-all");
    if (!orchestratorView && boardId && boardId !== ALL_REPOS_BOARD) project.setAttribute("href", boardPageUrl(boardId));
    project.toggleAttribute("aria-current", !orchestratorView && Boolean(boardId) && boardId !== ALL_REPOS_BOARD);
    all.toggleAttribute("aria-current", boardId === ALL_REPOS_BOARD);
  }

  function renderSync(view) {
    const line = byId("board-sync");
    const { state, failed, checked_at, last_verified_at, trimmed } = view.sync;
    const parts = [];
    if (state === "failed") {
      const cards = failed.filter(row => row.card).length;
      const repos = failed.filter(row => !row.card && row.repo).length;
      const what = [cards && `${cards} card${cards === 1 ? "" : "s"}`,
        repos && `${repos} repositor${repos === 1 ? "y" : "ies"}`].filter(Boolean).join(" and ");
      parts.push(`GitHub refresh failed for ${what} at ${formatTime(checked_at) || "an unknown time"}; ` +
        `showing facts last verified ${formatTime(last_verified_at) || "never"}`);
    } else if (state === "ok") {
      parts.push(`GitHub checked ${formatTime(checked_at)} · every card verified`);
    }
    for (const row of trimmed)
      parts.push(`${row.count} older ${row.kind === "history" ? "History row" : `${row.kind[0].toUpperCase()}${row.kind.slice(1)} card`}` +
        `${row.count === 1 ? "" : "s"} not shown`);
    line.textContent = parts.join(" · ");
    line.hidden = parts.length === 0;
    if (state) line.dataset.state = state;
    else delete line.dataset.state;
  }

  function render(view) {
    currentView = view;
    doc.body.classList.toggle("orchestrator-route", orchestratorView);
    costs.update(view.costs);
    byId("board-title").textContent = view.hierarchy ? "Work Requests" : deps.openTask ? "System Job Board" : view.title;
    byId("board-eyebrow").textContent = view.kind === ALL_REPOS_BOARD ? "All repositories" : "Progress board";
    doc.title = "Control Room · DoctorCRE";
    const publication = byId("board-publication");
    byId("board-meta").textContent = publication ? view.board_id : orchestratorView
      ? `Published ${formatTime(view.updated_at)}`
      : `${view.board_id} · Published ${formatTime(view.updated_at)} · Snapshot generation ${view.version}`;
    if (publication) {
      const published = formatTime(view.updated_at);
      const time = el("time", "", published || "Not supplied");
      if (published) time.dateTime = view.updated_at;
      publication.replaceChildren(el("span", "", `Snapshot generation ${view.version}`),
        el("span", "", "Source revision not supplied"));
      const publish = el("span", "", "Last successful publish · ");
      publish.append(time);
      publication.append(publish);
      publication.hidden = false;
    }
    byId("board-meta").hidden = orchestratorView;
    byId("board-freshness").hidden = orchestratorView;
    byId("orchestrator-link")?.toggleAttribute("aria-current", orchestratorView);
    renderSync(view);
    if (hasWorkViews(view)) byId("board-headline").replaceChildren();
    else renderHeadline(view);
    doc.querySelector(".headline").hidden = hasWorkViews(view) || orchestratorView || Boolean(view.hierarchy || queueBoardView);
    byId("board-title").classList.toggle("sr-only", orchestratorView || Boolean(view.hierarchy || queueBoardView) || Boolean(deps.openTask));
    const breadcrumb = doc.querySelector('nav[aria-label="Breadcrumb"]');
    if (breadcrumb) breadcrumb.hidden = !orchestratorView && (Boolean(view.hierarchy || queueBoardView) || Boolean(deps.openTask));
    if (queueBoardView) {
      // Only the cost panel comes from this board's snapshot; its retired task panels stay hidden.
      byId("board-title").textContent = "System Job Board";
      byId("board-meta").textContent = "Live from the record-layer work queue";
      for (const id of ["board-freshness", "board-sync", "repos-panel"]) if (byId(id)) byId(id).hidden = true;
      for (const id of ["board-blocked", "board-questions", "board-ledger", "board-deliverables", "board-decisions", "board-notes", "board-completed"])
        byId(id)?.closest(".panel")?.setAttribute("hidden", "");
      renderStages(view);
      return;
    }
    renderRepos(view);
    renderStages(view);
    if (!hasWorkViews(view) || workView === "history") renderBlocked(view);
    else byId("board-blocked").replaceChildren();
    renderQuestions(view);
    renderLedger(view);
    renderDeliverables(view);
    renderDecisions(view);
    renderNotes(view);
    for (const [id, count] of [["board-questions", view.questions.length], ["board-deliverables", view.deliverables.length],
      ["board-decisions", view.decisions.length + view.questions.filter(q => q.status).length], ["board-notes", view.notes.length]])
      byId(id).closest(".panel").hidden = (orchestratorView || Boolean(view.hierarchy || queueBoardView)) && !count;
    applyWorkViewVisibility(view);
  }

  // Live time: every time-dependent mark (stage ages, stale, stuck, health,
  // counts, blocked details) is derived again from the last read, so a card
  // that crosses a threshold changes without waiting for new data.
  function tick() {
    if (disposed) return;
    if (lastRead) render(boardView(lastRead, currentNow()));
  }

  const BOARD_PANELS = ["board-stages", "board-rail", "board-questions", "board-blocked", "board-ledger",
    "board-deliverables", "board-decisions", "board-notes", "completed-list", "board-completed", "board-headline", "board-repos"];
  const BOARD_COUNTS = ["task-count", "question-count", "blocked-count", "deliverable-count",
    "decision-count", "completed-count", "repo-count"];

  // A confirmed unpublished or denied read removes the protected board.
  function clearBoard(state) {
    const publication = byId("board-publication");
    if (publication) { publication.replaceChildren(); publication.hidden = true; }
    orchestratorUI?.dispose();
    orchestratorUI = null;
    queueUI?.dispose();
    queueUI = null;
    hierarchyUI?.dispose();
    hierarchyUI = null;
    costs.update(null);
    workViewResize?.disconnect();
    workViewResize = null;
    workViewMenu?.remove();
    workViewMenu = null;
    doc.querySelector(".progress-main")?.classList.remove("has-work-views");
    workView = "active";
    for (const state of workViewState.values()) {
      state.expanded.clear(); state.scroll = 0; state.cardId = null;
    }
    boardState = state;
    if (state !== "unpublished") {
      governanceRead = null;
      byId("conventionProposals")?.replaceChildren();
    }
    deps.onTasks?.([], {state});
    censusPipeline = null;
    if (byId("board-data-mode")) byId("board-data-mode").textContent = "";
    currentView = null;
    lastRead = null;
    viewSignature = "";
    cardNodes.clear();
    completedNodes.clear();
    blockedNodes.clear();
    questionCards = new Map();
    fingerprints.clear();
    formState.clear();
    pendingRequests.clear();
    for (const id of BOARD_PANELS) byId(id)?.replaceChildren();
    byId("board-stages").removeAttribute("aria-busy");
    byId("board-stages").classList.remove("hierarchy-board");
    for (const id of BOARD_COUNTS) byId(id).textContent = "—";
    if (state === "unpublished") {
      byId("board-stages").append(el("p", "empty", "Tasks appear when this board is published."));
      byId("board-blocked").append(el("p", "empty", "Blocked work appears when this board is published."));
    }
    byId("repos-panel").hidden = true;
    byId("board-sync").hidden = true;
    byId("board-title").textContent = deps.openTask ? "System Job Board" : "Progress";
    doc.title = "Control Room · DoctorCRE";
    const meta = byId("board-meta");
    meta.textContent = state === "unpublished" ? "No published snapshot" : "Board access unavailable";
    meta.setAttribute("data-read-state", state);
    const freshness = byId("board-freshness");
    badgeTimes.delete(freshness);
    freshness.textContent = "";
    freshness.removeAttribute("data-freshness");
  }

  function readFailure(cause, target) {
    if (disposed) return;
    const status = cause?.status;
    const state = status === 401 ? "signed-out" : status === 403 ? "unauthorized"
      : cause?.code === "read_timeout" ? "timeout"
        : win.navigator?.onLine === false ? "offline" : "unavailable";
    let message;
    if (status === 401 || status === 403) {
      message = status === 401 ? "Sign-in required" : "You do not have access to this board.";
      ++readSeq; clearBoard(state); clearDirectory();
      systemWork?.clearAccess(cause);
    } else {
      if (target === "board") { boardState="unknown"; deps.onTasks?.([], {state:"unknown"}); }
      message = state === "timeout" ? "The request timed out." : state === "offline" ? "You are offline." : `Could not load board “${boardId}”. Retry to load its published tasks.`;
    }
    if (target === "directory") {
      const error = byId("directory-error");
      error.textContent = message;
      error.hidden = false;
      error.setAttribute("data-read-state", state);
    } else {
      if (!currentView) renderStages(null);
      setError(message);
      const meta = byId("board-meta");
      meta.setAttribute("data-read-state", state);
      // A failed first read must not keep saying "Loading" beside the error.
      meta.textContent = currentView ? `Updated ${formatTime(currentView.updated_at)} ↻` : "Board not loaded";
    }
    if (status === 401) byId("board-sign-in").hidden = false;
    byId("board-retry").hidden = false;
    refreshAges();
  }

  // Reads are ordered: a read that finishes after a newer one started is
  // discarded, and its caller waits for the newest read instead. Returns true
  // when a board was drawn. A poll waits while an answer form has focus; an
  // answer, a reload or Retry reads at once (force). The directory is read
  // alongside and never holds up the board.
  async function refresh(force = false) {
    if (disposed) return false;
    if (!force && byId("board-questions").contains(doc.activeElement)) return false;
    if (!boardId) {
      setError("Choose a board: Project or All repositories.");
      byId("board-meta").textContent = "No board selected";
      return false;
    }
    boardReadController?.abort();
    boardReadController = new AbortController();
    const controller = boardReadController;
    const seq = ++readSeq;
    systemWork?.refresh(false, { force });
    if (force) queueUI?.refresh();
    loadDirectory(seq);
    const run = (async () => {
      let read;
      try { read = await client.readProgressBoard({ board_id: boardId }, {signal:controller.signal}); }
      catch (cause) {
        if (disposed || controller.signal.aborted) return false;
        if (seq !== readSeq) return "superseded";
        orchestratorUI?.offline();
        readFailure(cause, "board");
        if (force) throw cause;
        return false;
      }
      if (disposed || controller.signal.aborted) return false;
      if (seq !== readSeq) return "superseded";
      const view = boardView(read, currentNow());
      if (view.error) { boardState="unknown"; deps.onTasks?.([], {state:"unknown"}); setError(view.error); return false; }
      if (!view.version && queueBoardView) {
        // The queue board does not depend on a snapshot; an unpublished one only means no cost panel.
        costs.update(null);
        byId("board-meta").textContent = "Live from the record-layer work queue · no cost snapshot published";
        byId("board-meta").setAttribute("data-read-state", "unpublished");
        byId("board-retry").hidden = false;
        return false;
      }
      if (!view.version) {
        clearBoard("unpublished");
        setError(byId("board-data-mode") ? "" : "This board has not been published yet.");
        byId("board-retry").hidden = false;
        return false;
      }
      boardState = "read";
      lastRead = read;
      byId("board-retry").hidden = false;
      setError("");
      byId("board-sign-in").hidden = true;
      byId("board-meta").setAttribute("data-read-state", "published");
      const signature = JSON.stringify(read);
      if (signature !== viewSignature) {
        announce(viewSignature ? `${view.title} updated.` : `${view.title} loaded.`);
        viewSignature = signature;
      }
      render(view);
      badgeTimes.set(byId("board-freshness"), view.updated_at);
      refreshAges();
      return true;
    })();
    latestRead = run;
    let observed = run;
    let result = await observed;
    let supersededReads = 0;
    while (result === "superseded" && supersededReads++ < 20) {
      // A directory denial invalidates this epoch without starting a newer
      // board read. Only a distinct read can settle a superseded caller.
      if (latestRead === observed) return false;
      observed = latestRead;
      result = await observed;
    }
    return result === "superseded" ? false : result;
  }

  // Agents adopt rules themselves and tell Joe (WR-000631); this list only shows what is pending.
  function renderConventions() {
    const container = byId("conventionProposals");
    if (!container) return;
    const rows = governanceRead?.pending_convention_proposals || [];
    container.replaceChildren(...rows.map(row => {
      const node = el("article", "convention-proposal", undefined, { "data-convention": row.section_id });
      const time = el("time", "", formatTime(row.updated_at) || "Time unavailable");
      if (row.updated_at) time.dateTime = row.updated_at;
      const meta = el("p", "work-meta");
      meta.append(time);
      node.append(el("h3", "", row.section_key.split("/").at(-1)), meta);
      if (row.adoptable !== true) node.append(el("p", "", row.problem));
      else {
        node.append(el("p", "convention-body", row.statement));
        if (row.packs.length) node.append(el("p", "", `Packs: ${row.packs.join(", ")}`));
      }
      return node;
    }));
    if (!rows.length) container.textContent = governanceState === "read" ? "No pending convention proposals." : "";
  }

  function start() {
    renderStages(currentView);
    if (!orchestratorView && boardId === SYSTEM_BOARD_ID && typeof client.unfinishedWork === "function" && byId("system-work-panel"))
      systemWork = mountSystemWorkBoard({ client, openTask:deps.openTask, onAccessDenied: cause => readFailure(cause, "board"), onPipeline: (pipeline, observation) => { if (pipeline) censusPipeline = pipeline; censusObservation = observation; renderStages(currentView); } });
    // The queue board refreshes itself; its snapshot only carries costs, so it is read once.
    refresh().catch(() => setError("Progress temporarily unavailable.")).finally(() => {
      if (disposed || queueBoardView) return;
      poller = mountVisibilityPoll({ document: doc, window: win, setTimeout: setTimer, clearTimeout: clearTimer,
        poll: () => refresh().catch(() => { setError("Progress temporarily unavailable."); return false; }) });
    });
    timers.push(mountLocalTicker({ document: doc, window: win, tick, intervalMs: TICK_MS, setInterval: schedule, clearInterval: id => win.clearInterval(id) }));
  }

  byId("directory-search").addEventListener("input", filterDirectory);
  byId("board-retry").addEventListener("click", () => refresh(true).catch(() => {}));
  // eslint-disable-next-line no-restricted-syntax -- 0 automatic HTTP reads; local state or input handling only. No network retry in this listener Returns after local repaint, cancellation, or trusted input observation; does not renew presence from lifecycle/scroll
  doc.addEventListener("visibilitychange", refreshAges);
  renderLegend();
  wireLegend();
  wireFilters();
  if (standalone) byId("board-stages").addEventListener("focusin", rememberWorkCard);
  renderSwitch();

  function dispose() {
    if (disposed) return;
    disposed = true; readSeq++; boardReadController?.abort();
    orchestratorUI?.dispose(); queueUI?.dispose(); hierarchyUI?.dispose(); poller?.dispose();
    workViewResize?.disconnect();
    timers.forEach(timer => timer.dispose()); agePresence.dispose(); clearTimer(ageTimer);
    byId("directory-search").removeEventListener("input", filterDirectory);
    doc.removeEventListener("visibilitychange", refreshAges);
    win.removeEventListener?.('doctorcre-session-invalidated', dispose);
    currentView = lastRead = governanceRead = null;
    byId("board-stages").removeEventListener("focusin", rememberWorkCard);
    cardNodes.clear(); completedNodes.clear(); blockedNodes.clear(); questionCards.clear();
    fingerprints.clear(); formState.clear(); pendingRequests.clear(); badgeTimes.clear();
    byId("conventionProposals")?.replaceChildren();
  }
  win.addEventListener?.('doctorcre-session-invalidated', dispose);

  return { start, refresh, tick, toggleLive, filters,
    setGovernance(read, observation = {}) {
      if (disposed) return;
      const tasks = governanceTasks(read);
      governanceState = tasks ? "read" : "unknown";
      if (tasks) governanceRead = read;
      else if (observation.reason === "Sign in required") {
        governanceRead = null;
        byId("conventionProposals")?.replaceChildren();
      }
      const status = byId("governanceState");
      status.hidden = governanceState === "read";
      status.textContent = governanceState === "read" ? "" : `Approvals unavailable${governanceRead ? " · last-known cards" : ""}`;
      renderConventions();
      renderStages(currentView);
    },
    dispose,
    get view() { return currentView; }, get liveExpanded() { return liveExpanded; } };
}

if (typeof document !== "undefined" && document.getElementById("board-completed") && !globalThis.__BOARD_NO_AUTOMOUNT) {
  const boot = resolveDealroomBoot(globalThis.location);
  const client = boot.mode === 'live' ? createLiveClient()
    : await (await import('./fixture-client.js')).createFixtureClient(boot.options);
  mountBoard({ client }).start();
}
