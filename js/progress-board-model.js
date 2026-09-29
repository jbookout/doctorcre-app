// Progress board model: the one interactive board renders the CARR snapshot
// contract (carr-progress-board.v2, older v1 snapshots still read). Every
// visual indicator the renderer can put on a card is declared here once, and
// both the renderer and the legend read these constants, so the key cannot
// drift from what the board shows.

export const SNAPSHOT_SCHEMA = "carr-progress-board.v2";
export const ALL_REPOS_BOARD = "all-repos";
export const DEFAULT_REPO = "jbookout/carr-system";
export const LIVE_PREVIEW = 5;
export const LIVE_PREF_KEY = "carr-board:live-expanded";

export const STAGES = [
  { id: "queued", label: "Queued", color: "#f2f6fc", meaning: "Waiting to start" },
  { id: "build", label: "Building", color: "#fb7b32", meaning: "Being built; a draft PR" },
  { id: "review", label: "Review", color: "#bf9cff", meaning: "Waiting on independent review" },
  { id: "ci", label: "CI", color: "#ff88bd", meaning: "Checks running or failing" },
  { id: "merged", label: "Merged", color: "#65baff", meaning: "On main, not yet in a verified release" },
  { id: "live", label: "Live", color: "#7dddc0", meaning: "Released and verified where it runs" },
];

// Executor pools, in ledger order. Glyphs match the CARR producer's POOLS.
export const EXECUTORS = [
  { pool: "codex", glyph: "C", label: "Codex" },
  { pool: "grok", glyph: "G", label: "Grok" },
  { pool: "flash-next", glyph: "F", label: "Flash Next" },
  { pool: "claude-cloud", glyph: "✦", label: "Claude (cloud credits)" },
  { pool: "orchestrator", glyph: "O", label: "Orchestrator seat" },
  { pool: "unassigned", glyph: "?", label: "Unassigned or a person" },
];

// Pulse speed carries urgency. The renderer sets --pulse-speed from here.
export const PULSES = [
  { id: "healthy", speed: "3.5s", color: "#65baff", label: "Slow pulse", meaning: "Healthy and moving" },
  { id: "attention", speed: "2s", color: "#fb7b32", label: "Faster pulse", meaning: "Needs attention: a question or review" },
  { id: "critical", speed: "1s", color: "#ff696b", label: "Fastest pulse", meaning: "Blocked: see the reason and next action" },
  { id: "still", speed: null, color: "#7dddc0", label: "No pulse", meaning: "Queued or finished" },
];

export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;
const IN_FLIGHT = new Set(["running", "review", "blocked"]);

// Every indicator a card can carry. cardIndicators() only ever returns ids
// from this list, and the legend is built from it.
export const INDICATORS = [
  ...STAGES.map(stage => ({ id: `stage-${stage.id}`, group: "Stage colour", swatch: stage.color,
    label: stage.label, meaning: stage.meaning })),
  ...EXECUTORS.map(executor => ({ id: `glyph-${executor.pool}`, group: "Executor", glyph: executor.glyph,
    label: executor.label, meaning: `Work done by ${executor.label}` })),
  ...PULSES.map(pulse => ({ id: `pulse-${pulse.id}`, group: "Pulse", pulse: pulse.id, speed: pulse.speed,
    swatch: pulse.color, label: pulse.label, meaning: pulse.meaning })),
  { id: "outline-dashed", group: "Marks", label: "Dashed outline", meaning: "Critical, blocked or stuck" },
  { id: "badge-question", group: "Marks", glyph: "?", label: "Question badge", meaning: "Waiting on an answer or a review" },
  { id: "flag-stale", group: "Marks", label: "Stale flag", meaning: "In flight with no update for 6 hours or more; shows the age" },
  { id: "note-release-wait", group: "Marks", label: "Waiting on release", meaning: "Merged, but not in the latest verified release yet" },
];

export function legendEntries() {
  const groups = [];
  for (const entry of INDICATORS) {
    let group = groups.find(item => item.name === entry.group);
    if (!group) groups.push(group = { name: entry.group, entries: [] });
    group.entries.push(entry);
  }
  return groups;
}

const STATUS_STAGE = { queued: "queued", running: "build", review: "review",
  blocked: "review", failed: "ci", done: "build" };
const STATUSES = new Set(["Sent", "Received", "Applied"]);
const PHASE_BLOCKS = {
  "Checks failing": ["CI checks are failing on the PR head", "Read the failing check log, fix, and push"],
  "Review blocked": ["An independent reviewer posted BLOCK", "Address the review findings and push a new head"],
  "Merge conflict": ["Merge conflict with the base branch", "Merge the base branch and resolve the conflict"],
  "Changes requested": ["A reviewer requested changes", "Address the requested changes and re-request review"],
  "Closed unmerged": ["PR closed without merging", "Decide: reopen, replace, or retire the task"],
};

// Python's naive ISO timestamps are UTC in the CARR producer.
export function parseTime(raw) {
  if (typeof raw !== "string" || !raw.trim()) return NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`);
}

export function ageText(raw, at = new Date()) {
  const then = parseTime(raw);
  if (!Number.isFinite(then)) return "unknown";
  const minutes = Math.max(0, Math.floor((at.getTime() - then) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

// Mirrors task_stage in carr-system tools/progress_board.py at the pinned producer revision.
export function taskStage(task) {
  let requested = task.stage === "measured" ? "live" : task.stage;
  const evidence = task.evidence;
  if (requested === "live" && !(typeof evidence === "string" && evidence.trim())) requested = null;
  if (STAGES.some(stage => stage.id === requested)) return requested;
  if (task.status === "done") return task.pr != null && task.pr_phase === "Merged" ? "merged" : "build";
  if (task.status === "measured") return typeof evidence === "string" && evidence.trim() ? "live" : "build";
  return STATUS_STAGE[task.status ?? "queued"] || "queued";
}

function isStuck(task, at) {
  if (task.status === "blocked") return true;
  if (task.status !== "running") return false;
  const timestamp = parseTime(task.updated_at);
  return !Number.isFinite(timestamp) || at.getTime() - timestamp > STUCK_AFTER_MS;
}

export function taskHealth(task, at = new Date()) {
  // A finished card is never blocked: a leftover flag is ignored.
  if (task.status === "done" || taskStage(task) === "live") return "healthy";
  if (task.status === "blocked" || task.status === "failed" || task.health === "blocked" || isStuck(task, at)) return "blocked";
  if (task.status === "review" || task.health === "question" || task.question) return "question";
  return "healthy";
}

export function taskPulse(task, at = new Date()) {
  const health = taskHealth(task, at);
  if (health === "blocked") return "critical";
  if (health === "question") return "attention";
  if (task.status === "done" || task.status === "queued") return "still";
  return "healthy";
}

export function isStale(task, at = new Date()) {
  if (!IN_FLIGHT.has(task.status) || taskStage(task) === "live") return false;
  const updated = parseTime(task.updated_at);
  return Number.isFinite(updated) && at.getTime() - updated >= STALE_AFTER_MS;
}

// Mirrors blocked_detail: every blocked card names why and what happens next.
export function blockedDetail(task, at = new Date()) {
  if (taskHealth(task, at) !== "blocked") return null;
  const phase = PHASE_BLOCKS[task.pr_phase] || null;
  const reason = String(task.blocked_reason || "").trim();
  const action = String(task.next_action || "").trim();
  if (reason) return { reason, next: action || (phase ? phase[1] : "Orchestrator: record the next action") };
  if (phase) return { reason: phase[0], next: phase[1] };
  if (task.status === "failed") return { reason: "Task failed", next: "Decide: retry, replace, or retire the task" };
  if (task.status === "running" && isStuck(task, at)) {
    const age = ageText(task.updated_at, at);
    return { reason: age === "unknown" ? "No update recorded" : `No update for ${age}`,
      next: "Check the executor session; post an update or re-dispatch" };
  }
  return { reason: "Marked blocked without a recorded reason", next: "Orchestrator: record the reason and next action" };
}

export function stageEnteredAt(task) {
  const history = Array.isArray(task.stage_history) ? task.stage_history : [];
  const last = history.length ? history[history.length - 1] : null;
  return task.stage_entered_at || last?.entered_at || last?.at || task.updated_at || task.created_at || null;
}

// "build 2h 14m": read from stage_entered_at, never from updated_at.
export function stageTimer(task, at = new Date()) {
  return `${taskStage(task)} ${ageText(stageEnteredAt(task), at)}`;
}

export function stageDurations(task, at = new Date()) {
  const history = (Array.isArray(task.stage_history) ? task.stage_history : [])
    .map(entry => ({ stage: entry?.stage, entered_at: entry?.entered_at || entry?.at }))
    .filter(entry => entry.stage && entry.entered_at);
  return history.map((entry, index) => {
    const end = index + 1 < history.length ? new Date(parseTime(history[index + 1].entered_at)) : at;
    return { ...entry, duration: ageText(entry.entered_at, end) };
  });
}

export function executorPool(executor) {
  const value = String(executor || "").toLowerCase().trim();
  if (value.includes("orchestrator")) return "orchestrator";
  if (value.includes("claude") || value.includes("opus") || value.includes("sonnet")) return "claude-cloud";
  if (value.includes("flash next") || value.includes("flash-next")) return "flash-next";
  if (value.includes("grok")) return "grok";
  if (value.includes("codex") || value.includes("gpt-")) return "codex";
  return "unassigned";
}

export function executorGlyph(executor) {
  return EXECUTORS.find(item => item.pool === executorPool(executor)).glyph;
}

export function taskIdentity(task) {
  const executor = String(task.executor || "").trim();
  const lower = executor.toLowerCase();
  const effort = lower.match(/\b(low|medium|high|xhigh|max|ultra)\b/)?.[1] || "unknown";
  let derived;
  if (lower.includes("orchestrator")) derived = ["Anthropic", "Claude Opus 5.5"];
  else if (/\bgpt-[\w.-]+/i.test(executor))
    derived = ["Codex", executor.match(/\bgpt-[\w.-]+/i)[0].toLowerCase()];
  else if (/\bclaude\s+(opus|sonnet|haiku)\s+[\d.]+/i.test(executor))
    derived = ["Anthropic", executor.match(/\bclaude\s+(?:opus|sonnet|haiku)\s+[\d.]+/i)[0]];
  else {
    const provider = { codex: "Codex", "claude-cloud": "Anthropic", grok: "xAI", "flash-next": "Google" }[executorPool(executor)];
    derived = [provider || "Unknown", executor || "unknown"];
  }
  return { provider: task.provider || derived[0], model: task.model || derived[1], effort: task.effort || effort };
}

export function modelLine(task) {
  const identity = taskIdentity(task);
  return `${identity.provider} · ${identity.model} · ${identity.effort}`;
}

export function taskSummary(task) {
  const summary = String(task.summary || "").trim();
  if (summary) return summary;
  return String(task.title || "This task").trim().replace(/\.+$/, "") + ".";
}

export function relatedQuestions(task, questions) {
  const refs = new Set(Array.isArray(task.question_ids) ? task.question_ids : []);
  return questions.filter(q => refs.has(q.question_id) ||
    (String(task.id || "").length > 5 && q.question_id?.includes(task.id)));
}

export function taskRepo(task) {
  return typeof task.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(task.repo) ? task.repo : DEFAULT_REPO;
}

// PR numbers are per repository: always name the repo beside the number.
export function prLabel(task) {
  if (task.pr == null) return "No PR";
  return `${taskRepo(task).split("/")[1]} #${task.pr}`;
}

export function prUrl(task) {
  if (task.pr == null || !Number.isSafeInteger(Number(task.pr))) return null;
  return `https://github.com/${taskRepo(task)}/pull/${Number(task.pr)}`;
}

// The indicator ids the renderer puts on this card, all from INDICATORS.
export function cardIndicators(task, at = new Date()) {
  const pulse = taskPulse(task, at);
  const ids = [`stage-${taskStage(task)}`, `glyph-${executorPool(task.executor)}`, `pulse-${pulse}`];
  if (pulse === "critical") ids.push("outline-dashed");
  if (taskHealth(task, at) === "question") ids.push("badge-question");
  if (isStale(task, at)) ids.push("flag-stale");
  if (taskStage(task) === "merged" && task.release_wait) ids.push("note-release-wait");
  return ids;
}

function timeValue(raw) {
  const value = parseTime(raw);
  return Number.isFinite(value) ? value : 0;
}

// Newest first. All repositories: most recently released first. A project
// board: newest completion first, and within one repository the highest PR
// number first.
export function sortLive(cards, kind = "project") {
  const byTime = [...cards].sort((a, b) =>
    timeValue(b.completed_at || b.merged_at || b.updated_at) - timeValue(a.completed_at || a.merged_at || a.updated_at)
    || (Number(b.pr) || 0) - (Number(a.pr) || 0) || String(a.id).localeCompare(String(b.id)));
  if (kind === ALL_REPOS_BOARD) return byTime;
  const result = [...byTime];
  for (const repo of new Set(byTime.filter(card => card.pr != null).map(taskRepo))) {
    const slots = [];
    byTime.forEach((card, index) => { if (card.pr != null && taskRepo(card) === repo) slots.push(index); });
    const ordered = slots.map(index => byTime[index]).sort((a, b) => Number(b.pr) - Number(a.pr));
    slots.forEach((slot, index) => { result[slot] = ordered[index]; });
  }
  return result;
}

export function liveView(cards, expanded, kind = "project") {
  const sorted = sortLive(cards, kind);
  return { total: sorted.length, shown: expanded ? sorted : sorted.slice(0, LIVE_PREVIEW),
    hidden: expanded ? 0 : Math.max(0, sorted.length - LIVE_PREVIEW) };
}

export function readLivePreference(storage) {
  try { return storage?.getItem(LIVE_PREF_KEY) === "1"; } catch { return false; }
}

export function writeLivePreference(storage, expanded) {
  try { storage?.setItem(LIVE_PREF_KEY, expanded ? "1" : "0"); } catch { /* private window: keep the default */ }
}

export function filterCards(cards, filters = {}) {
  return cards.filter(card => (!filters.repo || taskRepo(card) === filters.repo)
    && (!filters.stage || card.stage === filters.stage)
    && (!filters.blockedOnly || card.health === "blocked"));
}

// Group a column's cards by repository, keeping the given order inside each.
export function groupByRepo(cards) {
  const groups = [];
  for (const card of cards) {
    const repo = taskRepo(card);
    let group = groups.find(item => item.repo === repo);
    if (!group) groups.push(group = { repo, cards: [] });
    group.cards.push(card);
  }
  return groups;
}

function ledgerFromTasks(cards) {
  return EXECUTORS.map(({ pool, glyph, label }) => {
    const members = cards.filter(card => executorPool(card.executor) === pool);
    const models = new Map();
    for (const card of members) {
      const { provider, model, effort } = taskIdentity(card);
      const key = `${provider}\u0000${model}\u0000${effort}`;
      models.set(key, { provider, model, effort, count: (models.get(key)?.count || 0) + 1 });
    }
    return { pool, glyph, label, count: members.length, violation: false,
      models: [...models.values()].sort((a, b) => b.count - a.count) };
  }).filter(row => row.pool !== "unassigned" || row.count);
}

export function boardView(read, at = new Date()) {
  const snapshot = read?.snapshot;
  const data = snapshot?.snapshot_json && typeof snapshot.snapshot_json === "object"
    ? snapshot.snapshot_json : {};
  const kind = data.kind === ALL_REPOS_BOARD || snapshot?.board_id === ALL_REPOS_BOARD ? ALL_REPOS_BOARD : "project";
  const entries = data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)
    ? Object.entries(data.tasks) : [];
  const cards = [];
  for (const [id, task] of entries) {
    if (!task || typeof task !== "object") continue;
    const card = { id, ...task };
    card.stage = taskStage(task);
    card.health = taskHealth(task, at);
    card.pulse = taskPulse(task, at);
    card.stale = isStale(task, at);
    card.blocked = blockedDetail(task, at);
    card.identity = taskIdentity(task);
    card.indicators = cardIndicators(task, at);
    cards.push(card);
  }
  const stages = STAGES.map(stage => ({ ...stage, tasks: cards.filter(card => card.stage === stage.id) }));
  const live = stages.find(stage => stage.id === "live");
  live.tasks = sortLive(live.tasks, kind);
  const ledger = Array.isArray(data.ledger) && data.ledger.length ? data.ledger.map(row => ({
    ...row, glyph: EXECUTORS.find(item => item.pool === row.pool)?.glyph ?? "?",
    models: Array.isArray(row.models) ? row.models : [] })) : ledgerFromTasks(cards);
  return {
    board_id: snapshot?.board_id || data.project || null,
    kind,
    schema: data.schema || "carr-progress-board.v1",
    version: snapshot?.version || null,
    title: typeof data.title === "string" ? data.title : "Progress board",
    updated_at: snapshot?.updated_at || null,
    cards,
    stages,
    repos: Array.isArray(data.repos) ? data.repos.filter(row => row && typeof row.repo === "string") : [],
    deliverables: Array.isArray(data.deliverables) ? data.deliverables : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
    decisions: Array.isArray(data.decisions) ? data.decisions : [],
    ledger,
    questions: Array.isArray(read?.questions) ? read.questions.map(q => ({
      ...q, choices: Array.isArray(q.choices) ? q.choices : [],
      status: STATUSES.has(q.status) ? q.status : null,
    })) : [],
  };
}

export function headline(view) {
  const count = predicate => view.cards.filter(predicate).length;
  const live = view.stages.find(stage => stage.id === "live").tasks.length;
  return {
    running: count(card => card.status === "running"),
    waiting: view.questions.filter(q => !q.status).length,
    blocked: count(card => card.health === "blocked"),
    stale: count(card => card.stale),
    live,
    remaining: view.cards.length - live,
  };
}

export function answerRequest(question, boardId, value, idempotencyKey) {
  const answer = String(value ?? "").trim();
  if (!answer) throw new Error("Enter an answer before sending.");
  if (!question.allow_free_text && !question.choices?.includes(answer))
    throw new Error("Choose one of the offered answers.");
  return { board_id: boardId, question_id: question.question_id,
    base_version: question.revision, answer_text: answer, idempotency_key: idempotencyKey };
}

export function boardFromSearch(search) {
  const value = new URLSearchParams(search).get("board");
  return value && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value) ? value : null;
}

// Only http(s) links are ever made clickable from board data.
export function safeHref(raw) {
  try {
    const url = new URL(String(raw));
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
