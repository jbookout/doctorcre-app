// V5-UX-C15 — the independent status page: DOM wiring only.
//
// Every decision lives in ./status-model.js. This page reads, paints, and does
// nothing else: no write verb, no command dock, no Doc mount. Doc needs CARR,
// and this page has to work when CARR does not.
//
// Reads settle independently: app release, Control Room coverage, and the
// selected assurance scope. Device snapshots contain coverage clocks only.
// Assurance evidence is never stored or reused as a last-known health label.
import {
  APP_READ_ID, INTEGRATION_GAPS, PROVIDER_LINKS, REFUSAL_SENTENCE,
  readSnapshot, snapshotFromReads, statusChips, statusHeadline, writeSnapshot,
} from "./status-model.js";
import { assuranceHealthRequest, assuranceHealthState, loadAssuranceHealth } from "./assurance-health-model.js";
import { READS, READ_LABEL } from "./control-room-model.js";
import { WORK_INVENTORY_ENDPOINT } from "./work-inventory-model.js";
import { acceptsResponse } from "./workspace-command-center-model.js";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountPrefs } from "./shell.js";
import { formatClock } from "./visual-system.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const view = {
  sequence: 0,
  outage: null,
  release: { state: "pending" },
  reads: { incidents: { state: "pending" }, work: { state: "pending" }, needs_joe: { state: "pending" }, census: { state: "pending" } },
  snapshot: null,
  assuranceScope: null,
  assurance: null,
  assuranceSequence: 0,
  assurancePending: false,
  assuranceError: null,
};

let client = null;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

const settledReads = () => Object.fromEntries(Object.entries(view.reads).filter(([, read]) => read.state !== "pending"));

/* -------------------------------------------------------------------- painting */

function renderHeadline() {
  const release = view.release.state === "pending" ? { state: "pending" } : view.release;
  const model = statusHeadline({ release, reads: settledReads(), snapshot: view.snapshot });
  $("statusHeadline").textContent = model.headline;
  $("statusAction").textContent = model.action;
  $("statusOrb").setAttribute("data-state", model.scenario === 1 ? "healthy" : model.scenario === 2 ? "attention" : "urgent");
  $("statusLive").textContent = model.headline;
  return model;
}

function renderChips(model) {
  const strip = $("statusChips");
  // Scenario 4 has nothing to state per read, so every chip says the same true
  // thing rather than implying a read was taken and came back empty.
  const chips = model.scenario === 4
    ? [APP_READ_ID, ...READS].map((id) => ({
      id, state: "unknown", text: `${id === APP_READ_ID ? "app" : READ_LABEL[id]}: ${model.emptyChipText}`,
    }))
    : statusChips({ release: view.release, reads: settledReads() });
  strip.innerHTML = `<span class="chip-label">Each read states its own clock</span>${chips
    .map((chip) => `<span class="chip" data-state="${escapeHtml(chip.state)}">${escapeHtml(chip.text)}</span>`)
    .join("")}`;
}

/** C21: a timestamped last-known picture, every chip dimmed and captioned. */
function renderLastKnown(model) {
  const block = $("lastKnownBlock");
  if (!model.lastKnown) {
    block.hidden = true;
    $("lastKnownChips").innerHTML = "";
    return;
  }
  block.hidden = false;
  $("lastKnownTitle").textContent = model.lastKnownTitle;
  $("lastKnownAsOf").textContent = model.lastKnownAsOf;
  $("lastKnownChips").innerHTML = (view.snapshot?.reads || []).map((row) => {
    const clock = row.state === "read" ? formatClock(row.observed_at) : null;
    const name = row.id === APP_READ_ID ? "app" : (READ_LABEL[row.id] || row.id);
    const text = clock ? `${name}: read at ${clock}` : `${name}: unknown (${row.reason || REFUSAL_SENTENCE})`;
    return `<span class="chip" data-state="${escapeHtml(row.coverage_word === "read" ? "read" : "unknown")}" data-current="no">${escapeHtml(text)} · not current</span>`;
  }).join("");
}

function renderIdentity() {
  const payload = view.release.state === "read" ? view.release.payload : null;
  const commit = typeof payload?.source_commit === "string" ? payload.source_commit.slice(0, 7) : null;
  $("statusIdentity").textContent = commit && payload?.environment
    ? `App build ${commit} · ${payload.environment}`
    : "App build unknown";
}

function renderStatic() {
  $("providerLinks").innerHTML = PROVIDER_LINKS
    .map((link) => `<li><a class="btn" href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a></li>`)
    .join("");

}

function render() {
  const model = renderHeadline();
  renderChips(model);
  renderLastKnown(model);
  renderIdentity();
  renderAssurance();
}

const LAYER_LABEL = {
  artifact_assessment: "Artifact assessment", execution_assessment: "Execution assessment",
  controller_assessment: "Controller assessment", candidate_outcome_oracle: "Candidate outcome oracle",
  activation_readback: "Activation readback", actual_business_outcome: "Business outcome",
};
let lastAssuranceHtml = null;
function renderAssurance() {
  const model = assuranceHealthState(view.assurance, view.assuranceScope);
  if (view.assuranceError) model.reason = view.assuranceError;
  else if (view.assurancePending) model.reason = "Taking the scoped assurance read…";
  const html = INTEGRATION_GAPS.map(gap => {
    const covered = gap.id === "v5-a01";
    const state = covered ? model.state : "unknown";
    const orb = covered && model.green ? "healthy" : state === "failed" ? "urgent" : state === "degraded" ? "attention" : "still";
    const scope = covered && model.scope ? `<p class="assurance-context">${escapeHtml(model.scope.workflow_key)} · v${model.scope.workflow_version}${model.scope.work_request_id ? ` · ${escapeHtml(model.scope.work_request_id)}` : ""} · this scope only</p>` : "";
    const layers = covered && model.evidence.length ? `<ul class="assurance-evidence">${model.evidence.map(row =>
      `<li data-layer="${row.layer}"><span>${LAYER_LABEL[row.layer]}</span><span>${escapeHtml(row.state)} · ${escapeHtml(row.age)}${row.expired ? " · expired" : ""}</span></li>`).join("")}</ul>` : "";
    return `<div class="state-block" data-state="${state}" data-gap="${gap.id}">
      <h3><span class="orb" data-state="${orb}" aria-hidden="true"></span> ${escapeHtml(gap.title)}</h3>
      ${scope}<p><span class="gap-word">${state}</span> · ${escapeHtml(covered ? model.reason : gap.reason)}</p>${layers}
    </div>`;
  }).join("");
  if (html !== lastAssuranceHtml) { $("integrationGaps").innerHTML = html; lastAssuranceHtml = html; }
  const subject = model.scope ? ` for ${model.scope.workflow_key} v${model.scope.workflow_version}${model.scope.work_request_id ? `, ${model.scope.work_request_id}` : ""}` : "";
  const announcement = `Assurance health${subject}: ${model.state}.${model.state === "unknown" ? ` ${model.reason}` : ""}`;
  // The persistent live region changes only with the scoped result, never its ticking ages.
  if ($("assuranceLive").textContent !== announcement) $("assuranceLive").textContent = announcement;
}
function scopeFromInputs() {
  const scope = { workflow_key: $("assuranceWorkflow").value, workflow_version: Number($("assuranceVersion").value) };
  const workRequest = $("assuranceWorkRequest").value;
  if (workRequest) scope.work_request_id = workRequest;
  return assuranceHealthRequest({ scope }).scope;
}
async function takeAssurance() {
  const sequence = ++view.assuranceSequence;
  const scope = view.assuranceScope;
  view.assurance = null;
  view.assurancePending = Boolean(scope);
  renderAssurance();
  const answer = await loadAssuranceHealth(client, scope);
  if (sequence !== view.assuranceSequence) return;
  view.assurance = answer; view.assurancePending = false;
  renderAssurance();
}
function readSelectedScope() {
  view.assuranceError = null;
  try { view.assuranceScope = scopeFromInputs(); }
  catch {
    view.assuranceSequence += 1; view.assuranceScope = null; view.assurance = null;
    view.assurancePending = false;
    view.assuranceError = "Enter a workflow, a positive whole version, and an optional WR-number work request.";
    renderAssurance(); return;
  }
  return takeAssurance();
}

/* --------------------------------------------------------------------- reading */

/** One read, settled on its own. The server's words never survive this guard. */
async function take(id, run) {
  const sequence = view.sequence;
  const isRelease = id === APP_READ_ID;
  try {
    const payload = await run();
    if (!acceptsResponse(view.sequence, sequence)) return;
    const settled = { state: "read", payload, observed_at: new Date().toISOString() };
    if (isRelease) view.release = settled; else view.reads[id] = settled;
  } catch {
    if (!acceptsResponse(view.sequence, sequence)) return;
    const settled = { state: "unknown", reason: REFUSAL_SENTENCE };
    if (isRelease) view.release = settled; else view.reads[id] = settled;
  }
  render();
}

async function appRelease() {
  // In fixture mode the switch rides along as a query param, because the
  // fixture server answers /app-release and this page's own client cannot.
  const query = view.outage ? `?outage=${encodeURIComponent(view.outage)}` : "";
  const response = await fetch(`/app-release${query}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`app-release -> ${response.status}`);
  return response.json();
}

async function census() {
  if (view.outage === "census" || view.outage === "all") throw new Error("census outage requested by the fixture switch");
  const response = await fetch(`${WORK_INVENTORY_ENDPOINT}?kinds=work_request`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`census -> ${response.status}`);
  return response.json();
}

async function load() {
  view.sequence += 1;
  view.release = { state: "pending" };
  for (const id of Object.keys(view.reads)) view.reads[id] = { state: "pending" };
  render();
  await Promise.all([
    take(APP_READ_ID, () => appRelease()),
    take("incidents", () => client.incidentBoard({ state: "open" })),
    take("work", () => client.currentWorkItem()),
    take("needs_joe", () => client.currentWorkRequests()),
    take("census", () => census()),
    takeAssurance(),
  ]);
  render();
  writeSnapshot(storage(), snapshotFromReads({ [APP_READ_ID]: view.release, ...view.reads }, Date.now()));
}

/* ------------------------------------------------------------------------ boot */

/** `?outage=all` refuses everything at once; the named values refuse one read. */
function allDownClient() {
  const refuse = () => { throw new Error("fixture outage: every read is unreachable"); };
  return { readAssuranceHealth: refuse, incidentBoard: refuse, currentWorkItem: refuse, currentWorkRequests: refuse };
}

async function boot() {
  mountPrefs();
  renderStatic();
  view.snapshot = readSnapshot(storage());
  $("retryRead")?.addEventListener("click", () => load());
  const location = globalThis.location || { hostname: "", search: "" };
  const resolved = resolveDealroomBoot(location);
  const outage = new URLSearchParams(location.search || "").get("outage");
  view.outage = resolved.mode === "live" ? null : outage;
  if (resolved.mode === "live") client = createLiveClient();
  else if (view.outage === "all") client = allDownClient();
  else client = await createFixtureClient({ ...resolved.options, ...(view.outage ? { outage: view.outage } : {}) });
  const params = new URLSearchParams(location.search || "");
  for (const [key, id] of [["workflow_key", "assuranceWorkflow"], ["workflow_version", "assuranceVersion"], ["work_request_id", "assuranceWorkRequest"]]) {
    $(id).value = params.get(key) || "";
    $(id).addEventListener("input", () => {
      view.assuranceSequence += 1; view.assuranceScope = null; view.assurance = null;
      view.assurancePending = false; view.assuranceError = null; renderAssurance();
    });
  }
  $("readAssurance").addEventListener("click", readSelectedScope);
  if (params.has("workflow_key") || params.has("workflow_version") || params.has("work_request_id")) {
    try { view.assuranceScope = scopeFromInputs(); }
    catch { view.assuranceError = "The supplied workflow scope is invalid."; }
  }
  // Evidence ages and expiry are reevaluated while the page stays open and on return.
  setInterval(renderAssurance, 1000);
  document.addEventListener("visibilitychange", renderAssurance);
  await load();
}

boot();

export { view };
