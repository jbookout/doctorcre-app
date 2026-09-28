import { createLeadBoardClient } from "./leads-client.js";
import { mountReadOnResume } from "./read-on-resume.mjs";

const client = createLeadBoardClient();
const state = { board: null, claims: null, pendingClaims: new Map(), boardReadEpoch: 0, claimReadEpoch: 0, activeClaim: null, moving: false, resumeDeferred: false, density: false, view: "board", filters: { search: "", owner: "", lane: "", stage: "" } };
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const stageKey = (stage) => stage?.slug || stage?.stage || "unassigned";

// The server owns the stage order. This small fallback makes an unexpected
// historical stage visible instead of silently dropping its lead from view.
function boardStages() {
  const known = [...(state.board?.stages || [])];
  const slugs = new Set(known.map(stageKey));
  for (const lead of state.board?.leads || []) {
    const slug = lead.stage || "unassigned";
    if (!slugs.has(slug)) { known.push({ slug, label: lead.stage_label || title(slug), sort: Number.MAX_SAFE_INTEGER }); slugs.add(slug); }
  }
  return known.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
}

function label(value, fallback = "Not captured") { return value ? esc(value) : fallback; }
function title(value) { return String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
export function isTerminal(lead) {
  return Boolean(lead?.suppressed || lead?.do_not_contact || isDncStage(lead?.stage) ||
    /closed|declin|dead|disqualif|archive|terminal/i.test(lead?.stage || ""));
}
export function isDncStage(stage) { return /(^|[-_ ])dnc($|[-_ ])|do[-_ ]?not[-_ ]?contact/i.test(stage?.slug || stage?.stage || stage?.label || stage || ""); }
function isStageLocked(lead) { return Boolean(lead?.suppressed || lead?.do_not_contact || isDncStage(lead?.stage)); }
export function stageChoices(stages, lead) {
  return stages.filter((stage) => lead?.stage === stageKey(stage) || !isDncStage(stage));
}
function dateTime(value) { const time = Date.parse(value || ""); return Number.isFinite(time) ? time : 0; }
function dateLabel(value) { return dateTime(value) ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Not set"; }
export function freshness(lead) {
  if (isTerminal(lead)) return { key: "terminal", text: lead?.do_not_contact || isDncStage(lead?.stage) ? "Do not contact" : lead?.suppressed ? "Suppressed" : "Terminal stage" };
  const next = dateTime(lead.next_action_date);
  if (next && next < Date.now()) return { key: "overdue", text: `Action date passed ${dateLabel(lead.next_action_date)}` };
  const updated = dateTime(lead.updated_at || lead.last_touch);
  if (!updated || Date.now() - updated > 45 * 86400000) return { key: "attention", text: "Needs a freshness check" };
  return { key: "healthy", text: "Current signal" };
}
export function confidenceInfo(value) {
  if (value === null || value === undefined || String(value).trim() === "") return { text: "Confidence missing", verify: true };
  const word = String(value).trim().toLowerCase();
  if (["high", "medium", "low"].includes(word)) return { text: `${title(word)} confidence`, verify: word !== "high" };
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const percent = Math.round(numeric <= 1 ? numeric * 100 : numeric);
    return { text: `${percent}% confidence`, verify: percent < 70 };
  }
  return { text: `${title(value)} confidence`, verify: true };
}
function options(values, selected, allLabel) {
  return `<option value="">${esc(allLabel)}</option>${values.map((value) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(title(value))}</option>`).join("")}`;
}
function refreshFilters() {
  const leads = state.board?.leads || [];
  const unique = (key) => [...new Set(leads.map((lead) => lead[key]).filter(Boolean))].sort();
  $("ownerFilter").innerHTML = options(unique("owner"), state.filters.owner, "All owners");
  $("laneFilter").innerHTML = options(unique("lane"), state.filters.lane, "All lanes");
  $("stageFilter").innerHTML = options(boardStages().map(stageKey), state.filters.stage, "All stages");
}
function filtered() {
  const search = state.filters.search.trim().toLowerCase();
  return (state.board?.leads || []).filter((lead) => {
    const haystack = [lead.name, lead.specialty, lead.city, lead.county, lead.state, lead.registry_ref, lead.segment].join(" ").toLowerCase();
    return (!search || haystack.includes(search)) && (!state.filters.owner || lead.owner === state.filters.owner) && (!state.filters.lane || lead.lane === state.filters.lane) && (!state.filters.stage || lead.stage === state.filters.stage);
  });
}
function pipeline() {
  const stages = boardStages();
  const nodes = $("pipelineNodes");
  nodes.innerHTML = stages.map((stage, index) => {
    const x = stages.length < 2 ? 420 : 55 + (730 * index / (stages.length - 1));
    return `<g class="pipeline-node" transform="translate(${x} 52)"><circle r="18"></circle><text class="pipeline-number" y="5">${index + 1}</text><text y="39">${esc(stage.label || title(stageKey(stage)))}</text></g>`;
  }).join("");
}
function leadCard(lead) {
  const fresh = freshness(lead);
  const confidence = confidenceInfo(lead.event_confidence);
  const locked = isStageLocked(lead);
  const stageOptions = stageChoices(boardStages(), lead).map((stage) => `<option value="${esc(stageKey(stage))}"${lead.stage === stageKey(stage) ? " selected" : ""}>${esc(stage.label || title(stageKey(stage)))}</option>`).join("");
  const identity = lead.registry_ref || lead.id;
  return `<article class="lead-card" id="lead-${esc(lead.id)}" data-freshness="${fresh.key}" tabindex="-1">
    <div class="lead-card-head"><div><h2 class="lead-name">${label(lead.name, "Unnamed lead")}</h2><p class="lead-place">${label(lead.specialty, "Specialty not captured")} · ${label([lead.city, lead.state].filter(Boolean).join(", "), "Place not captured")}</p></div><span class="lead-ref">${esc(identity)}</span></div>
    <div class="lead-signals"><span class="signal freshness"><i class="freshness-dot" aria-hidden="true"></i><strong>${esc(fresh.text)}</strong></span><span class="signal"><strong>Score ${label(lead.score, "—")}</strong></span><span class="signal${confidence.verify ? " verify" : ""}"><strong>${esc(confidence.text)}</strong></span><span class="signal stage-label"><strong>${esc(lead.stage_label || title(lead.stage))}</strong></span>${lead.suppressed ? '<span class="signal suppressed"><strong>Suppressed</strong></span>' : ""}${confidence.verify ? '<span class="signal verify"><strong>Verify</strong></span>' : ""}</div>
    <div class="lead-meta"><span>Lane<b>${label(lead.lane)}</b></span><span>Owner<b>${label(lead.owner_label || lead.owner)}</b></span><span>Lease event<b>${label(lead.est_lease_event)}</b></span><span>Last touch<b>${dateLabel(lead.last_touch)}</b></span><span>Next action<b>${dateLabel(lead.next_action_date)}</b></span><span>Segment<b>${label(lead.segment)}</b></span></div>
    <div class="lead-move"><label class="sr-only" for="stage-${esc(lead.id)}">Move ${esc(lead.name || identity)} to stage</label><select id="stage-${esc(lead.id)}" data-stage-select="${esc(lead.id)}"${locked ? " disabled" : ""}>${stageOptions}</select><button type="button" data-move-lead="${esc(lead.id)}" aria-label="Move ${esc(lead.name || identity)} to selected stage"${locked ? " disabled" : ""}>Move</button></div>${locked ? '<p class="stage-locked">Stage locked by suppression instruction. Review the record before changing it.</p>' : ""}
  </article>`;
}
function renderBoard() {
  const board = $("leadBoard");
  const leads = filtered();
  const all = state.board?.leads || [];
  board.classList.toggle("compact", state.density);
  $("leadCount").textContent = `${all.length} total`;
  $("filterSummary").textContent = `${leads.length} of ${all.length} leads shown`;
  if (!all.length) { board.innerHTML = '<p class="board-state empty">The Lead Board is connected, but no leads have arrived yet.</p>'; return; }
  if (!leads.length) { board.innerHTML = '<p class="board-state filter-empty">No leads match these filters. Clear one to return to the complete board.</p>'; return; }
  if (state.view === "list") {
    board.innerHTML = `<section aria-label="All matching leads in a single list"><h2 class="lead-list-heading">All matching leads · ${leads.length}</h2><div class="lead-list">${leads.map(leadCard).join("")}</div></section>`;
    return;
  }
  const stages = boardStages();
  board.innerHTML = `<div class="stage-columns">${stages.map((stage) => {
    const key = stageKey(stage); const inStage = leads.filter((lead) => lead.stage === key);
    return `<section class="stage-column${!state.filters.stage || state.filters.stage === key ? " is-mobile-visible" : ""}" data-stage="${esc(key)}" aria-labelledby="stage-heading-${esc(key)}"><h2 class="stage-head" id="stage-heading-${esc(key)}">${esc(stage.label || title(key))}<span class="stage-count">${inStage.length}</span></h2><div class="lead-stack">${inStage.map(leadCard).join("") || '<p class="stage-empty">No matching leads</p>'}</div></section>`;
  }).join("")}</div>`;
}
function notice(message, kind = "") { const node = $("leadBoardNotice"); node.hidden = !message; node.className = `board-notice ${kind}`; node.textContent = message || ""; }
const researchFields = ["name", "company", "phone", "specialty", "market"];
export function claimEvidence(values, observedAt) {
  const sources = [];
  const field_evidence = {};
  for (const field of researchFields) {
    let url;
    try { url = new URL(String(values[field] || "").trim()); }
    catch { throw new Error(`The ${field} source needs a valid HTTPS URL.`); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(`The ${field} source must use HTTPS without credentials in the URL.`);
    field_evidence[field] = [sources.length];
    sources.push({ url: url.toString(), observed_at: observedAt });
  }
  return { sources, field_evidence, discrepancies: values.discrepancies ? [values.discrepancies] : [] };
}
function claimCard(candidate) {
  const id = esc(candidate.pool_id);
  const name = esc(candidate.display_name || "Unnamed candidate");
  const place = esc([candidate.city, candidate.state].filter(Boolean).join(", ") || "Location not captured");
  const duplicate = candidate.dup_tier === "review" ? '<span class="claim-warning">Possible duplicate</span>' : "";
  return `<article class="claim-card" data-pool-id="${id}"><h3>${name}</h3><p>${place}</p>${duplicate}<div class="claim-actions"><button type="button" data-claim-open="promote" data-pool-id="${id}">Claim as lead</button><button type="button" data-claim-open="decline" data-pool-id="${id}">Decline</button></div></article>`;
}
function openClaim(button) {
  const action = button.dataset.claimOpen;
  const poolId = button.dataset.poolId;
  const pending = state.pendingClaims.get(`${action}:${poolId}`);
  const candidate = pending?.candidate || state.claims?.candidates?.find(item => String(item.pool_id) === poolId);
  if (!candidate) return;
  state.activeClaim = { candidate, action, trigger: button };
  const id = esc(candidate.pool_id);
  const sourceFields = researchFields.map(field => `<label>${title(field)} source URL <input type="url" name="${field}" placeholder="https://…" required pattern="https://.*" autocomplete="off"></label>`).join("");
  const duplicate = candidate.dup_tier === "review" ? `<p class="claim-warning">Possible duplicate of ${esc(candidate.dup_ref || "an existing record")}. ${esc(candidate.dup_basis || "Review before claiming.")}</p>` : "";
  $("claimDialogTitle").textContent = `${action === "promote" ? "Claim" : "Decline"} ${candidate.display_name || "candidate"}`;
  $("claimDialogContext").innerHTML = `<p>${esc([candidate.city, candidate.state].filter(Boolean).join(", ") || "Location not captured")} · ${esc(candidate.vertical || "Specialty not captured")}</p><p>Lane: ${esc(candidate.lane || "Unspecified")} · Score: ${esc(candidate.score ?? "Unknown")} · Estimated lease event: ${esc(candidate.est_lease_event || "Unknown")}</p><p>${esc(candidate.segment_play || candidate.score_basis || "Review the source before deciding.")}</p>${duplicate}`;
  $("claimDialogBody").innerHTML = action === "promote"
    ? `<form data-claim-action="promote" data-pool-id="${id}"><p>Check an HTTPS source for each field. The app records the time you confirm these sources.</p><div class="claim-source-grid">${sourceFields}</div><label>Discrepancies found (leave blank if none) <textarea name="discrepancies" rows="2"></textarea></label><label class="claim-confirm"><input type="checkbox" name="checked" required> I checked these sources and their field links now.</label><button type="submit">Claim as lead</button></form>`
    : `<form data-claim-action="decline" data-pool-id="${id}"><label>Reason, in your own words <textarea name="reason" required rows="2"></textarea></label><button type="submit">Decline</button></form>`;
  $("claimDialogError").hidden = true;
  if (pending) {
    const form = $("claimDialogBody").querySelector("form");
    for (const field of form.elements) if (field.type !== "submit") field.disabled = true;
    form.querySelector('button[type="submit"]').textContent = "Retry same request";
    $("claimDialogError").textContent = "The earlier result is unknown. Retry this exact request.";
    $("claimDialogError").hidden = false;
  }
  $("claimDialog").showModal();
  $("claimDialogBody").querySelector("input,textarea,button")?.focus();
}
function renderClaims() {
  const claims = state.claims;
  $("claimSummary").textContent = claims ? `${claims.claimable} claimable · ${claims.needs_contact_count} need a contact channel · Showing ${claims.candidates?.length || 0} ranked candidates` : "Candidates unavailable";
  $("claimCards").innerHTML = claims?.candidates?.length ? claims.candidates.map(claimCard).join("") : '<p class="board-state empty">No claimable candidates on this card.</p>';
}
async function refreshClaims() {
  if (state.pendingClaims.size || $("claimDialog").open) {
    $("claimError").textContent = state.pendingClaims.size ? "A decision has an unknown result. Retry that request before refreshing candidates." : "Close the decision popup before refreshing candidates.";
    $("claimError").hidden = false;
    return;
  }
  const readEpoch = ++state.claimReadEpoch;
  $("claimCards").setAttribute("aria-busy", "true");
  try {
    const claims = await client.getClaimCard();
    if (readEpoch !== state.claimReadEpoch || state.pendingClaims.size || $("claimDialog").open) return;
    state.claims = claims; $("claimError").hidden = true; renderClaims();
  } catch (error) {
    if (readEpoch !== state.claimReadEpoch || state.pendingClaims.size) return;
    state.claims = null;
    renderClaims();
    $("claimError").textContent = errorMessage(error); $("claimError").hidden = false;
  } finally { if (readEpoch === state.claimReadEpoch) $("claimCards").setAttribute("aria-busy", "false"); }
}
async function submitClaim(form) {
  const action = form.dataset.claimAction;
  const pendingId = `${action}:${form.dataset.poolId}`;
  let pending = state.pendingClaims.get(pendingId);
  const candidate = pending?.candidate || state.activeClaim?.candidate || state.claims?.candidates?.find(item => String(item.pool_id) === form.dataset.poolId);
  if (!candidate || String(candidate.pool_id) !== form.dataset.poolId) return;
  if (!pending && state.pendingClaims.size) {
    $("claimDialogError").textContent = "Retry the decision with an unknown result before starting another.";
    $("claimDialogError").hidden = false;
    return;
  }
  if (!pending) {
    const values = Object.fromEntries(new FormData(form).entries());
    let payload;
    try {
      if (action === "promote") payload = claimEvidence(values, new Date().toISOString());
      else { payload = String(values.reason || "").trim(); if (!payload) throw new Error("Give a reason in your own words."); }
    } catch (error) { $("claimDialogError").textContent = error.message; $("claimDialogError").hidden = false; return; }
    pending = { key: crypto.randomUUID(), payload, candidate };
    state.pendingClaims.set(pendingId, pending);
  }
  ++state.claimReadEpoch; // Any read started before this decision cannot repaint its form or result.
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (action === "promote") await client.promoteCandidate(pending.candidate, pending.payload, pending.key);
    else await client.declineCandidate(pending.candidate, pending.payload, pending.key);
    state.pendingClaims.delete(pendingId);
    $("claimError").hidden = true;
    state.resumeDeferred = false; // The confirmed decision refreshes both reads below.
    $("claimDialog").close();
    await Promise.all([refreshClaims(), refresh()]);
    $("moveAnnouncement").textContent = action === "promote" ? "Candidate claimed. The Lead Board has refreshed." : "Candidate declined. The Claim Card has refreshed.";
  } catch (error) {
    if (error.code !== "unknown_outcome") state.pendingClaims.delete(pendingId);
    $("claimDialogError").textContent = error.code === "unknown_outcome" ? "The result is unknown. Retry this request with the same key; do not start another decision." : error.code === "version_conflict" ? "This candidate changed elsewhere. No decision was made; refresh candidates before trying again." : errorMessage(error);
    $("claimDialogError").hidden = false;
    $("claimError").textContent = $("claimDialogError").textContent;
    $("claimError").hidden = false;
    if (error.code === "unknown_outcome") {
      for (const field of form.elements) if (field !== button) field.disabled = true;
      button.textContent = "Retry same request";
    }
  } finally { button.disabled = false; }
}
export function errorMessage(error) {
  if (error.code === "version_conflict") return "This lead changed elsewhere. No stage change was made; the latest board has loaded for review.";
  if (error.code === "not_authenticated" || error.code === "unauthorized") return "Your session has ended. Sign in again, then return to the Lead Board.";
  return error.message || "The Lead Board could not load. No lead data was changed.";
}
function staleNotice() {
  const generated = dateTime(state.board?.generated_at);
  if (generated && Date.now() - generated > 15 * 60000) notice(`Stale snapshot: generated ${new Date(generated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Refresh before relying on it.`, "stale");
  else notice("");
}
async function refresh() {
  const readEpoch = ++state.boardReadEpoch;
  const board = $("leadBoard"); board.setAttribute("aria-busy", "true"); $("leadBoardError").hidden = true;
  try {
    const next = await client.getLeadBoard();
    if (readEpoch !== state.boardReadEpoch) return;
    state.board = next; refreshFilters(); pipeline(); renderBoard(); staleNotice();
  } catch (error) {
    if (readEpoch !== state.boardReadEpoch) return;
    state.board = null;
    $("leadBoardError").textContent = errorMessage(error); $("leadBoardError").hidden = false;
    board.innerHTML = '<p class="board-state empty">The board is unavailable. Existing lead records were not changed.</p>';
  } finally { if (readEpoch === state.boardReadEpoch) board.setAttribute("aria-busy", "false"); }
}
async function refreshAfterReturn() {
  if ($("claimDialog").open || state.pendingClaims.size || state.moving) {
    state.resumeDeferred = true;
    return;
  }
  state.resumeDeferred = false;
  // A returned page cannot keep showing records fetched under an older cookie.
  ++state.boardReadEpoch;
  ++state.claimReadEpoch;
  state.board = null;
  state.claims = null;
  $("leadBoard").innerHTML = '<p class="board-state empty">Refreshing the Lead Board…</p>';
  renderClaims();
  await Promise.all([refresh(), refreshClaims()]);
}
async function moveLead(button) {
  const id = button.dataset.moveLead;
  const lead = state.board?.leads.find((item) => String(item.id) === id);
  const select = document.querySelector(`[data-stage-select="${CSS.escape(id)}"]`);
  if (!lead || !select || isStageLocked(lead) || isDncStage(select.value) || select.value === lead.stage) return;
  const focused = document.activeElement;
  button.disabled = true;
  state.moving = true;
  ++state.boardReadEpoch;
  $("leadBoard").setAttribute("aria-busy", "false"); // Any older read is now invalid.
  try {
    await client.moveLeadStage(lead, select.value);
    await refresh();
    const moved = document.getElementById(`lead-${id}`);
    moved?.focus();
    $("moveAnnouncement").textContent = `${lead.name || lead.registry_ref || "Lead"} moved to ${title(select.value)}.`;
  } catch (error) {
    const message = errorMessage(error);
    if (error.code === "version_conflict") {
      await refresh();
      $("leadBoardError").textContent = message;
      $("leadBoardError").hidden = false;
      document.getElementById(`lead-${id}`)?.focus();
    } else {
      $("leadBoardError").textContent = message;
      $("leadBoardError").hidden = false;
      if (focused instanceof HTMLElement) focused.focus();
    }
  } finally {
    button.disabled = false;
    state.moving = false;
    if (state.resumeDeferred) refreshAfterReturn();
  }
}

if (typeof document !== "undefined") {
  for (const [id, key] of [["leadSearch", "search"], ["ownerFilter", "owner"], ["laneFilter", "lane"], ["stageFilter", "stage"]]) $(id).addEventListener(id === "leadSearch" ? "input" : "change", (event) => { state.filters[key] = event.target.value; renderBoard(); });
  $("densityToggle").addEventListener("click", () => { state.density = !state.density; $("densityToggle").setAttribute("aria-pressed", String(state.density)); $("densityToggle").textContent = state.density ? "Compact density" : "Comfortable density"; renderBoard(); });
  $("refreshBoard").addEventListener("click", refresh);
  for (const view of ["board", "list"]) $(view + "View").addEventListener("click", () => { state.view = view; $("boardView").setAttribute("aria-pressed", String(view === "board")); $("listView").setAttribute("aria-pressed", String(view === "list")); renderBoard(); });
  $("leadBoard").addEventListener("click", (event) => { const button = event.target.closest("[data-move-lead]"); if (button) moveLead(button); });
  $("refreshClaims").addEventListener("click", refreshClaims);
  $("claimCards").addEventListener("click", (event) => { const button = event.target.closest("[data-claim-open]"); if (button) openClaim(button); });
  $("claimDialog").addEventListener("submit", (event) => { const form = event.target.closest("form[data-claim-action]"); if (!form) return; event.preventDefault(); submitClaim(form); });
  $("closeClaimDialog").addEventListener("click", () => $("claimDialog").close());
  $("claimDialog").addEventListener("close", () => {
    state.activeClaim?.trigger?.focus?.(); state.activeClaim = null;
    if (state.resumeDeferred && !state.pendingClaims.size) refreshAfterReturn();
  });
  if (typeof window !== "undefined" && typeof document.addEventListener === "function") {
    mountReadOnResume({ document, window, refresh: refreshAfterReturn });
  }
  refresh();
  refreshClaims();
}
