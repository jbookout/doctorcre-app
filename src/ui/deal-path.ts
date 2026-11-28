import { dayOf, shortDate, yearOf } from "./timeline-scale.ts";

type Status = "complete" | "received" | "not_recorded" | "due" | "overdue" | "upcoming";
type Todo = {
  id: string;
  label: string;
  status: Status;
  due_on?: string | null;
  evidence_ref?: string | null;
};
type Phase = { slug: string; label: string };
type Place = "done" | "current" | "ahead";
export type PathView = {
  phases: readonly Phase[];
  current: string | null;
  checklist: unknown;
  showTodos?: boolean;
  today: string;
  canMove: boolean;
  receiptHtml: string;
  focusedItem: string | null;
  signingOn?: string | null;
};

const STATUSES = new Set<unknown>(["complete", "received", "not_recorded", "due", "overdue", "upcoming"]);
const FINISHED = new Set<Status>(["complete", "received"]);
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isTodo = (v: unknown): v is Todo =>
  record(v) && typeof v.id === "string" && typeof v.label === "string" && STATUSES.has(v.status);

/** Each checklist group's to-dos under the phase of the same meaning; Invoice's go under Closed. */
export function todosByPhase(checklist: unknown): Map<string, Todo[]> | null {
  if (!record(checklist) || checklist.schema_version !== "deal-checklist.v1" || !Array.isArray(checklist.phases))
    return null;
  if (checklist.template_state === "unavailable" || checklist.template_state === "source_changed") return null;
  const byPhase = new Map<string, Todo[]>();
  for (const group of checklist.phases) {
    if (!record(group) || typeof group.id !== "string" || !Array.isArray(group.items)) return null;
    const phase = group.id === "invoice" ? "closed" : group.id;
    // Critical dates have their own row above the path.
    const todos = group.items.filter(isTodo).filter((todo) => !todo.id.startsWith("critical-date:"));
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), ...todos]);
  }
  return byPhase;
}

function dayWords(day: string, today: string) {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function todoHtml(todo: Todo, today: string, focused: boolean) {
  const finished = FINISHED.has(todo.status);
  const when = todo.due_on && !finished ? dayWords(todo.due_on, today) : "";
  const line = !when ? "" : todo.status === "overdue" ? `Was due ${when}` : `Due ${when}`;
  const detail = todo.evidence_ref || (finished ? "Recorded." : "Not filed yet.");
  return `<li data-todo="${esc(todo.id)}" data-state="${finished ? "done" : todo.status === "overdue" ? "late" : "open"}"><details${focused ? " open data-focused" : ""}><summary title="${esc(todo.label)}"><span>${esc(todo.label)}</span>${line ? `<small>${esc(line)}</small>` : ""}</summary><p>${esc(detail)}</p></details></li>`;
}

// A tile shows its first unfinished to-dos; the rest fold under a count so the path stays one short row.
const SHOWN = 2;

function todoListHtml(todos: Todo[], view: PathView) {
  const items = (list: Todo[]) =>
    `<ul>${list.map((todo) => todoHtml(todo, view.today, todo.id === view.focusedItem)).join("")}</ul>`;
  const ordered = [...todos].sort((a, b) => Number(FINISHED.has(a.status)) - Number(FINISHED.has(b.status)));
  const rest = ordered.slice(SHOWN);
  if (!rest.length) return items(ordered);
  const open = rest.some((todo) => todo.id === view.focusedItem) ? " open" : "";
  return `${items(ordered.slice(0, SHOWN))}<details class="deal-path-more"${open}><summary>${rest.length} more</summary><div class="deal-path-list-panel"><button type="button" data-path-less>Show less</button>${items(rest)}</div></details>`;
}

function tileHtml(phase: Phase, place: Place, todos: Todo[] | undefined, view: PathView) {
  const name =
    view.canMove && place !== "current"
      ? `<button type="button" class="deal-path-name" data-path-phase="${esc(phase.slug)}" title="${esc(phase.label)}" aria-expanded="false">${esc(phase.label)}</button>`
      : `<span class="deal-path-name" title="${esc(phase.label)}">${esc(phase.label)}</span>`;
  const done = todos?.filter((todo) => FINISHED.has(todo.status)).length ?? 0;
  const count = place === "current" && todos?.length ? `<small>${done} of ${todos.length}</small>` : "";
  const check = place === "done" ? '<span class="deal-path-check" aria-label="Finished">✓</span>' : "";
  const list = todos?.length ? todoListHtml(todos, view) : todos ? '<p class="deal-path-empty">Nothing listed</p>' : "";
  const receipt = place === "current" ? `<div data-phase-move aria-live="polite">${view.receiptHtml}</div>` : "";
  const signing =
    place === "current" && view.signingOn
      ? `<button type="button" class="btn btn-quiet deal-plan-signing-link" data-open-deal-plan>Lease signing expected ${shortDate(dayOf(view.signingOn), yearOf(dayOf(view.today)))}</button>`
      : "";
  return `<li class="deal-path-tile" data-phase="${esc(phase.slug)}" data-place="${place}"${place === "current" ? ' aria-current="step"' : ""}><div class="deal-path-head">${name}${check}${count}</div>${receipt}${signing}${list}</li>`;
}

/** Every phase as a tile with its to-dos; a phase name asks before it moves the deal. */
export function dealPathHtml(view: PathView) {
  const showTodos = view.showTodos !== false;
  const byPhase = showTodos ? todosByPhase(view.checklist) : null;
  const at = view.phases.findIndex((phase) => phase.slug === view.current);
  const tiles = view.phases.map((phase, i) => {
    const place: Place = i === at ? "current" : at >= 0 && i < at ? "done" : "ahead";
    return tileHtml(phase, place, byPhase ? (byPhase.get(phase.slug) ?? []) : undefined, view);
  });
  const unread =
    showTodos && !byPhase
      ? '<p class="deal-path-note" role="status">Checklist is unavailable. Refresh the deal.</p>'
      : "";
  const receipt = at < 0 ? `<div data-phase-move aria-live="polite">${view.receiptHtml}</div>` : "";
  return `<section class="deal-path-section" aria-label="Deal path"><ol class="deal-path">${tiles.join("")}</ol>${receipt}${unread}</section>`;
}

/** The question a phase click asks. Closed asks the outcome instead. */
export function pathQuestionHtml(phase: Phase, today: string) {
  const buttons = (submit: string) =>
    `<p role="status" data-path-status></p><div class="deal-path-actions"><button class="btn btn-primary" type="submit">${esc(submit)}</button><button class="btn btn-quiet" type="button" data-path-cancel>Cancel</button></div>`;
  if (phase.slug === "closed")
    return `<form class="deal-path-ask" data-path-move="closed" aria-label="Close this deal" novalidate><p class="deal-path-ask-title">Close this deal</p><fieldset class="deal-path-outcome"><legend class="sr-only">Outcome</legend><label class="chip"><input type="radio" name="outcome" value="won"> <span>Won</span></label><label class="chip"><input type="radio" name="outcome" value="lost"> <span>Lost</span></label></fieldset><label>Closed on<input type="date" name="closedOn" value="${esc(today)}" max="${esc(today)}"></label><label data-when="won">Closed value (optional)<input type="number" name="wonValue" min="0" step="any" inputmode="decimal" autocomplete="off"></label><label data-when="lost">Reason the deal was lost<input name="lostReason" maxlength="500" autocomplete="off"></label>${buttons("Close deal")}</form>`;
  return `<form class="deal-path-ask" data-path-move="${esc(phase.slug)}" aria-label="Move this deal to ${esc(phase.label)}?" novalidate><p class="deal-path-ask-title">Move this deal to ${esc(phase.label)}?</p><input name="reason" maxlength="500" autocomplete="off" placeholder="What changed (optional)" aria-label="What changed (optional)">${buttons(`Move to ${phase.label}`)}</form>`;
}
