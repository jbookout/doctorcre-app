import { createLiveClient } from "./live-client.js";
import { uuidv4 } from "./uuid.js";
import { boardView, answerRequest } from "./progress-board-model.js";

const boardId = new URLSearchParams(location.search).get("board");
const client = createLiveClient();
const pendingRequests = new Map();
const title = document.getElementById("board-title");
const meta = document.getElementById("board-meta");
const error = document.getElementById("board-error");
const stages = document.getElementById("board-stages");
const questions = document.getElementById("board-questions");
const taskCount = document.getElementById("task-count");
const questionCount = document.getElementById("question-count");

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function setError(message) {
  error.textContent = message || "";
  error.hidden = !message;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined,
    { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderStages(view) {
  stages.replaceChildren();
  let count = 0;
  for (const [index, stage] of view.stages.entries()) {
    const section = element("section", "stage");
    section.dataset.stage = stage.id;
    const head = element("div", "stage-header");
    head.append(element("span", "stage-index", String(index + 1).padStart(2, "0")),
      element("span", "stage-title", stage.label),
      element("span", "stage-count", String(stage.tasks.length).padStart(2, "0")));
    section.append(head);
    for (const task of stage.tasks) {
      count += 1;
      const card = element("article", "task-card");
      card.dataset.health = task.status === "blocked" || task.status === "failed" ? "blocked"
        : task.question || task.status === "review" ? "question" : "healthy";
      card.append(element("strong", "task-title", task.title || task.id),
        element("span", "task-meta", [task.executor, task.pr ? `PR ${task.pr}` : null]
          .filter(Boolean).join(" · ") || task.id));
      section.append(card);
    }
    if (!stage.tasks.length) section.append(element("p", "empty", "No tasks"));
    stages.append(section);
  }
  taskCount.textContent = `${count} TASK${count === 1 ? "" : "S"}`;
}

function answerForm(q, view) {
  const form = element("form", "answer-form");
  const message = element("p", "form-message");
  let choiceInputs = [];
  let freeText = null;
  if (q.choices.length) {
    const options = element("div", "answer-options");
    for (const [index, choice] of q.choices.entries()) {
      const id = `choice-${q.question_id}-${index}`;
      const label = element("label", "answer-option");
      const input = element("input");
      input.type = "radio";
      input.name = `answer-${q.question_id}`;
      input.value = choice;
      input.id = id;
      choiceInputs.push(input);
      label.append(input, element("span", "", choice));
      options.append(label);
    }
    form.append(options);
  }
  if (q.allow_free_text) {
    const id = `free-${q.question_id}`;
    const label = element("label", "", q.choices.length ? "Or write your answer" : "Your answer");
    label.htmlFor = id;
    freeText = element("textarea");
    freeText.id = id;
    freeText.maxLength = 4000;
    freeText.placeholder = "Type your answer";
    form.append(label, freeText);
  }
  if (q.default_answer) form.append(element("p", "question-detail", `If unanswered: ${q.default_answer}`));
  const button = element("button", "", "Send answer");
  button.type = "submit";
  form.append(button, message);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const value = freeText?.value.trim() || choiceInputs.find(input => input.checked)?.value || "";
    const retained = pendingRequests.get(q.question_id);
    const key = retained?.idempotency_key || uuidv4();
    let args;
    try { args = retained || answerRequest(q, view.board_id, value, key); }
    catch (cause) { message.textContent = cause.message; return; }
    pendingRequests.set(q.question_id, args);
    button.disabled = true;
    message.textContent = "Saving answer…";
    try {
      await client.answerBoardQuestion(args);
      await refresh(true);
      pendingRequests.delete(q.question_id);
    } catch (cause) {
      button.disabled = false;
      message.textContent = cause.payload?.error === "board_version_conflict" ||
        cause.payload?.error === "board_answer_already_sent"
        ? "This question changed or was answered elsewhere. Refreshing…"
        : "Answer status is unconfirmed. Retry will use the same request.";
      if (cause.payload?.error === "board_version_conflict" || cause.payload?.error === "board_answer_already_sent") {
        pendingRequests.delete(q.question_id);
        await refresh(true).catch(() => {});
      }
    }
  });
  return form;
}

function renderQuestions(view) {
  questions.replaceChildren();
  questionCount.textContent = `${view.questions.filter(q => !q.status).length} WAITING`;
  if (!view.questions.length) {
    questions.append(element("p", "empty", "No questions on this board."));
    return;
  }
  for (const q of view.questions) {
    const card = element("article", "question-card");
    if (q.status) card.dataset.status = q.status;
    const top = element("div", "question-top");
    top.append(element("h3", "question-title", q.prompt), element("span", "status", q.status || "Waiting"));
    card.append(top);
    if (q.status) {
      card.append(element("p", "answer-text", q.answer_text || ""));
      const detail = [q.answered_by ? `Answered by ${q.answered_by}` : null,
        q.status === "Applied" && q.effect_ref ? `Applied: ${q.effect_ref}` : null]
        .filter(Boolean).join(" · ");
      if (detail) card.append(element("p", "question-detail", detail));
    } else {
      card.append(answerForm(q, view));
    }
    questions.append(card);
  }
}

async function refresh(force = false) {
  if (!boardId) { setError("Open a published board link to choose a project."); meta.textContent = "No board selected"; return; }
  if (!force && questions.contains(document.activeElement)) return;
  const read = await client.readProgressBoard({ board_id: boardId });
  const view = boardView(read);
  if (!view.version) { setError("This board has not been published yet."); return; }
  setError("");
  title.textContent = view.title;
  document.title = `${view.title} · DoctorCRE`;
  meta.textContent = `${view.board_id} · Published ${formatTime(view.updated_at)} · Version ${view.version}`;
  renderStages(view);
  renderQuestions(view);
}

refresh().catch(() => setError("The board could not be loaded. Refresh to try again."));
setInterval(() => refresh().catch(() => setError("The board could not be refreshed.")), 15000);
