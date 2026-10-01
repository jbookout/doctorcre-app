export const STAGES = [
  { id: "queued", label: "Queued" },
  { id: "build", label: "Building" },
  { id: "review", label: "Review" },
  { id: "ci", label: "CI" },
  { id: "merged", label: "Merged" },
  { id: "live", label: "Live" },
];

export const SYSTEM_BOARD_ID = "carr-v5";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function boardFreshness(updatedAt, at = new Date()) {
  const timestamp = typeof updatedAt === "string" && updatedAt.trim()
    ? Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(updatedAt) ? updatedAt : `${updatedAt}Z`) : NaN;
  if (!Number.isFinite(timestamp)) return { state: "unknown", label: "Update time unavailable" };
  const age = Math.max(0, at.getTime() - timestamp);
  const minutes = Math.floor(age / 60000);
  const elapsed = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
      : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h ago`;
  return { state: age >= STALE_AFTER_MS ? "stale" : "fresh", label: `Updated ${elapsed}` };
}

export function boardDirectory(read) {
  if (read?.schema !== "progress-board-directory.v1" || !Array.isArray(read.boards))
    throw new Error("Published board directory is unavailable.");
  return read.boards.filter(board => board && typeof board.board_id === "string")
    .slice().sort((a, b) => a.board_id === SYSTEM_BOARD_ID ? -1
      : b.board_id === SYSTEM_BOARD_ID ? 1 : String(a.title).localeCompare(String(b.title)));
}

const STATUS_STAGE = { queued: "queued", running: "build", review: "review",
  blocked: "review", failed: "ci", done: "build" };
const STATUSES = new Set(["Sent", "Received", "Applied"]);
const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

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

export function taskHealth(task, at = new Date()) {
  let stuck = false;
  if (task.status === "running") {
    const raw = task.updated_at;
    // Python's naive ISO timestamps are UTC in the CARR producer.
    const timestamp = typeof raw === "string" && raw.trim()
      ? Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`) : NaN;
    stuck = !Number.isFinite(timestamp) || at.getTime() - timestamp > STUCK_AFTER_MS;
  }
  if (task.status === "blocked" || task.status === "failed" || task.health === "blocked" || stuck) return "blocked";
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

export function boardView(read) {
  const snapshot = read?.snapshot;
  const data = snapshot?.snapshot_json && typeof snapshot.snapshot_json === "object"
    ? snapshot.snapshot_json : {};
  const tasks = data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)
    ? Object.entries(data.tasks) : [];
  const stages = STAGES.map(stage => ({ ...stage, tasks: [] }));
  for (const [id, task] of tasks) {
    if (!task || typeof task !== "object") continue;
    const stage = taskStage(task);
    stages.find(item => item.id === stage).tasks.push({ id, ...task });
  }
  return {
    board_id: snapshot?.board_id || data.project || null,
    version: snapshot?.version || null,
    title: typeof data.title === "string" ? data.title : "Progress board",
    updated_at: snapshot?.updated_at || null,
    stages,
    questions: Array.isArray(read?.questions) ? read.questions.map(q => ({
      ...q, choices: Array.isArray(q.choices) ? q.choices : [],
      status: STATUSES.has(q.status) ? q.status : null,
    })) : [],
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
