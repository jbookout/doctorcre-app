export const STAGES = [
  { id: "queued", label: "Queued" },
  { id: "build", label: "Building" },
  { id: "review", label: "Review" },
  { id: "ci", label: "CI" },
  { id: "merged", label: "Merged" },
  { id: "live", label: "Live" },
];

const STATUS_STAGE = { queued: "queued", running: "build", review: "review",
  blocked: "review", failed: "ci", done: "merged", measured: "live" };
const STATUSES = new Set(["Sent", "Received", "Applied"]);

export function boardView(read) {
  const snapshot = read?.snapshot;
  const data = snapshot?.snapshot_json && typeof snapshot.snapshot_json === "object"
    ? snapshot.snapshot_json : {};
  const tasks = data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)
    ? Object.entries(data.tasks) : [];
  const stages = STAGES.map(stage => ({ ...stage, tasks: [] }));
  for (const [id, task] of tasks) {
    if (!task || typeof task !== "object") continue;
    const stage = task.stage === "measured" ? "live" :
      STAGES.some(item => item.id === task.stage) ? task.stage : STATUS_STAGE[task.status] || "queued";
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
