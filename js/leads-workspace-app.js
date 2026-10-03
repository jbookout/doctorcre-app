import { createLeadBoardClient, validateLeadWorkspace, validateLeadDetail } from "./leads-client.js";
import { mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
import { BOARD_STAGES, FILTER_STAGES, stageLabel, normalizedStage, eligibleLead, leadTitle, marketKey,
  visibleLeads, hottestLeads, marketCounts, stageReview, automaticMove, undoReview } from "./leads-model.js";
import { mountTerritoryMap } from "./leads-territory-map.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortDate = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) : "Date pending";
const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "—";
const summary = value => String(value || "").split(/\n\s*\n/)[0].slice(0, 230);
const score = lead => lead.score == null ? "—" : esc(Math.round(Number(lead.score)));
const options = (rows, selected, all) => `<option value="">${all}</option>${rows.map(([key, text]) => `<option value="${esc(key)}"${key === selected ? " selected" : ""}>${esc(text)}</option>`).join("")}`;

export function mountLeadsWorkspace(doc = document, client = createLeadBoardClient(), { mapFactory = mountTerritoryMap } = {}) {
  const $ = id => doc.getElementById(id), win = doc.defaultView || globalThis.window;
  const state = { board: null, actor: null, epoch: 0, detailEpoch: 0, reviewEpoch: 0, filters: { search: "", owner: "", stage: "", market: "" },
    detail: null, detailId: null, resumeReview: null, commandFeedback: null, connectionFeedback: null, proposal: null, reviewTarget: null, pending: null, writing: false, identityReady: false, trigger: null, drag: null, map: null };
  const leadById = id => state.board?.leads.find(lead => lead.id === id && eligibleLead(lead));
  function card(lead) {
    const move = automaticMove(lead), undo = undoReview(lead);
    const possible = lead.possible_clients || [];
    return `<article class="lead-card" data-lead-id="${esc(lead.id)}" tabindex="0" role="button" aria-label="${esc(leadTitle(lead))}" draggable="true">
      <span class="drag-handle" data-drag-handle aria-hidden="true">⠿</span><h3>${esc(leadTitle(lead))}</h3>
      <div class="card-foot"><span class="party-id" title="${esc(lead.party_id)}">${esc(lead.party_id ? lead.party_id.slice(0, 8) : "Party pending")}</span><span class="score"><small>Score</small>${score(lead)}</span></div>
      ${move ? `<div class="auto-move">Moved by Doc: ${esc(move.reason || "stage updated")} ${shortDate(move.evidence_date || move.occurred_at)}${undo ? `<button data-undo="${esc(lead.id)}">Undo</button>` : ""}</div>` : ""}
      ${possible.map(match => `<div class="client-hint">possible client: ${esc(match.name)} <button data-link="${esc(lead.id)}" data-client-id="${esc(match.client_id)}" aria-label="Link ${esc(leadTitle(lead))} to ${esc(match.name)}">Link</button></div>`).join("")}
    </article>`;
  }
  function focusIdentity(node) {
    const container = node?.closest?.("#leadBoard, #hotLeads, #marketCounts");
    if (container) {
      for (const attr of ["data-claim", "data-undo", "data-link", "data-lead-id", "data-market"]) {
        if (node.hasAttribute(attr)) return { container: container.id, attr, value: node.getAttribute(attr), client: node.dataset.clientId };
      }
    }
    return node?.id ? { id: node.id } : null;
  }
  function restoreFocus(identity) {
    if (!identity) return;
    const node = identity.id ? $(identity.id) : [...$(identity.container).querySelectorAll(`[${identity.attr}]`)]
      .find(node => node.getAttribute(identity.attr) === identity.value && node.dataset.clientId === identity.client);
    (node || $("refreshBoard")).focus({ preventScroll: true });
  }
  function render() {
    const focused = focusIdentity(doc.activeElement);
    const leads = state.board?.leads || [];
    const owners = [...new Set(leads.filter(eligibleLead).map(l => l.owner).filter(Boolean))].sort();
    const markets = [...new Set(leads.filter(eligibleLead).map(marketKey))].sort();
    if (state.board && !owners.includes(state.filters.owner)) state.filters.owner = "";
    if (state.board && !markets.includes(state.filters.market)) state.filters.market = "";
    const shown = visibleLeads(leads, state.filters);
    const active = visibleLeads(leads);
    $("leadCount").textContent = `${active.length}`;
    $("filterSummary").textContent = `${shown.length} leads`;
    $("stageFilter").innerHTML = options(FILTER_STAGES, state.filters.stage, "All stages");
    $("ownerFilter").innerHTML = options(owners.map(k => [k, k.charAt(0).toUpperCase() + k.slice(1)]), state.filters.owner, "All owners");
    const groups = marketCounts(leads, state.filters);
    $("marketFilter").innerHTML = options(markets.map(k => [k, k]), state.filters.market, "All markets");
    $("clearMarket").hidden = !state.filters.market;
    $("marketCounts").innerHTML = groups.map(g => `<button data-market="${esc(g.key)}" aria-pressed="${g.key === state.filters.market}">${esc(g.key)}<b>${g.count}</b></button>`).join("") || '<p class="empty">No leads in these markets</p>';
    state.map?.update(groups, state.filters.market);
    $("hotLeads").innerHTML = hottestLeads(leads).map((lead, i) => `<article class="hot-row" data-lead-id="${esc(lead.id)}" tabindex="0" role="button" aria-label="${esc(leadTitle(lead))}"><span class="hot-rank">${i + 1}</span><div><h3>${esc(leadTitle(lead))}</h3><small>${esc(marketKey(lead))}</small></div><span class="score">${score(lead)}</span><button data-claim="${esc(lead.id)}">Claim</button></article>`).join("") || '<p class="empty">No New leads</p>';
    $("hotLeads").setAttribute("aria-busy", "false");
    if (state.filters.stage === "archived") {
      $("leadBoard").innerHTML = `<div class="filtered-list" aria-label="${stageLabel(state.filters.stage)}">${shown.map(card).join("") || '<p class="empty">No matching leads</p>'}</div>`;
    } else {
      $("leadBoard").innerHTML = `<div class="stage-columns">${BOARD_STAGES.map(([key, text]) => {
        const rows = shown.filter(lead => normalizedStage(lead) === key);
        return `<section class="stage-column" data-stage="${key}" aria-label="${text}"><h2 class="stage-head">${text}<span>${rows.length}</span></h2><div class="lead-stack">${rows.map(card).join("") || '<p class="stage-empty">—</p>'}</div></section>`;
      }).join("")}</div>`;
    }
    $("boardUpdated").textContent = updatedLabel(state.board?.generated_at);
    $("boardUpdated").dateTime = state.board?.generated_at || "";
    $("searchUpdated").textContent = `New-lead search ${state.board?.last_search_at ? stamp(state.board.last_search_at) : "—"}`;
    if (focused?.container) restoreFocus(focused);
  }
  function paintCommandFeedback() {
    const box = $("leadBoardError");
    const command = state.pending ? 'Confirmation pending <button id="checkPending">Check outcome</button>' : esc(state.commandFeedback);
    box.hidden = !state.pending && !state.commandFeedback && !state.connectionFeedback;
    box.innerHTML = [command, esc(state.connectionFeedback)].filter(Boolean).join(" · ");
    $("checkPending")?.addEventListener("click", executePending);
    if (state.pending && $("stageDialog").open) {
      $("saveStage").textContent = "Check outcome"; $("saveStage").disabled = state.writing;
      for (const input of $("stageQuestions").querySelectorAll("textarea")) input.disabled = true;
    }
  }
  function clearPrivateView() {
    state.commandFeedback = null; state.connectionFeedback = null; state.board = null; state.detailId = null; state.detail = null; state.proposal = null; state.reviewTarget = null; state.resumeReview = null; state.pending = null;
    state.filters = { search: "", owner: "", stage: "", market: "" }; state.trigger = null; state.drag = null;
    $("leadSearch").value = ""; $("detailTitle").textContent = ""; $("stageTitle").textContent = "";
    $("stageError").textContent = ""; $("moveAnnouncement").textContent = ""; $("saveStage").disabled = true;
    ++state.detailEpoch; ++state.reviewEpoch; $("leadDetail").close(); $("stageDialog").close();
    $("detailBody").innerHTML = ""; $("stageContext").innerHTML = ""; $("stageQuestions").innerHTML = "";
    render();
  }
  function authorizationFailure(error) {
    if (!["unauthorized", "not_authenticated", "forbidden"].includes(error.code) && ![401, 403].includes(error.status)) return false;
    ++state.epoch; state.identityReady = false; clearPrivateView(); state.actor = null;
    $("leadBoard").setAttribute("aria-busy", "false");
    state.connectionFeedback = "Sign-in required";
    paintCommandFeedback();
    return true;
  }
  async function refresh() {
    const epoch = ++state.epoch;
    state.identityReady = false;
    $("leadBoard").setAttribute("aria-busy", "true");
    try {
      const actor = await client.getActor();
      if (epoch !== state.epoch) return;
      if (!actor) throw Object.assign(new Error("Sign-in required"), { code: "unauthorized" });
      if (state.actor && actor !== state.actor) clearPrivateView();
      state.actor = actor;
      state.identityReady = true;
      const next = await client.getWorkspace();
      if (epoch !== state.epoch) return;
      validateLeadWorkspace(next);
      state.connectionFeedback = null;
      state.board = next; render();
      if (state.pending) {
        const current = next.leads.find(l => l.id === state.pending.lead.id);
        const move = current?.last_stage_move;
        if ((state.pending.kind === "link" && current?.client_id === state.pending.clientId) ||
            (state.pending.kind === "stage" && move?.idempotency_key === state.pending.key) ||
            (state.pending.kind === "claim" && current?.owner === state.pending.actor)) {
          state.pending = null; state.commandFeedback = null; $("stageDialog").close();
        }
      }
      paintCommandFeedback();
      const resumeReview = state.resumeReview;
      state.resumeReview = null;
      if (resumeReview?.actor === state.actor && !state.pending) {
        await openReview(resumeReview.id, resumeReview.target);
        if (state.proposal?.review.question === resumeReview.question) {
          const input = $("stageQuestions").querySelector("textarea");
          if (input) input.value = resumeReview.answer;
        }
      }
      if (!resumeReview && state.reviewTarget && $("stageDialog").open && !state.writing && !state.pending) {
        const { id, target } = state.reviewTarget, current = leadById(id);
        if (!current || target === normalizedStage(current)) $("stageDialog").close();
        else await openReview(id, target, { updating: true });
      }
      if (state.detailId && $("leadDetail").open) {
        if (leadById(state.detailId)) await readDetail(state.detailId, false);
        else if (next.leads.some(lead => lead.id === state.detailId)) { state.detail = null; $("leadDetail").close(); }
        else { state.detail = null; ++state.detailEpoch; $("detailTitle").textContent = "Lead unavailable"; $("detailBody").innerHTML = '<p class="empty">Unavailable</p>'; }
      }
    } catch (error) {
      if (epoch !== state.epoch) return;
      if (authorizationFailure(error)) return;
      // A refused verification/read cannot leave the previous private snapshot visible.
      if (!state.identityReady) state.board = null;
      state.identityReady = false; state.detail = null; state.detailId = null;
      ++state.detailEpoch; state.trigger = null;
      $("leadDetail").close(); $("detailTitle").textContent = ""; $("detailBody").replaceChildren();
      render();
      state.connectionFeedback = state.actor ? "Connection interrupted · reconnecting…" : "Sign-in required";
      paintCommandFeedback();
    } finally { if (epoch === state.epoch) $("leadBoard").setAttribute("aria-busy", "false"); }
  }
  function paintDetail(detail) {
    const active = doc.activeElement;
    const focusedEntry = active?.matches("summary") ? active.closest("#detailBody details")?.dataset.entryKey : null;
    const focusedId = $("detailBody").contains(active) ? active.id : null;
    const expanded = new Set([...$("detailBody").querySelectorAll("details[open]")].map(node => node.dataset.entryKey));
    const scroll = $("leadDetail").scrollTop;
    $("detailTitle").textContent = leadTitle(detail);
    const contact = (kind, value) => value ? `<a href="${kind === "Email" ? "mailto:" : "tel:"}${esc(value)}">${esc(value)}</a>` : "—";
    $("detailBody").innerHTML = `<div class="detail-overview"><section class="detail-panel"><h3>Contact</h3><dl><dt>Phone</dt><dd>${contact("Phone", detail.phone)}</dd><dt>Email</dt><dd>${contact("Email", detail.email)}</dd><dt>Market</dt><dd>${esc(marketKey(detail))}</dd><dt>Vertical</dt><dd>${esc(detail.specialty || detail.vertical || "—")}</dd><dt>Party</dt><dd class="party-id">${esc(detail.party_id || "—")}</dd></dl></section>
      <section class="detail-panel"><h3>Plans</h3><p>${esc(summary(detail.plans || detail.notes) || "—")}</p>${detail.notes ? `<details data-entry-key="plans"><summary>Details</summary><div class="original-entry">${esc(detail.notes)}</div></details>` : ""}<dl class="plan-window"><dt>Lease window</dt><dd>${esc(detail.est_lease_event || "—")}</dd></dl></section>
      <section class="detail-panel"><h3>Lead score</h3><div class="detail-score">${score(detail)}<span>/ 100</span></div><label>Stage<select id="detailStage">${FILTER_STAGES.filter(([key]) => key !== "do_not_contact").map(([key,text]) => `<option value="${key}"${normalizedStage(detail) === key ? " selected" : ""}>${text}</option>`).join("")}</select></label></section></div>
      <div class="detail-columns"><section class="detail-panel"><h3>Correspondence</h3><ol class="correspondence">${(detail.correspondence || []).map(entry => `<li><time>${stamp(entry.occurred_at)}</time><p>${esc(summary(entry.summary))}</p><details data-entry-key="${esc(entry.id)}"><summary>Details</summary><div class="original-entry">${esc(entry.detail || entry.summary)}</div></details></li>`).join("") || '<li class="empty">No correspondence yet</li>'}</ol></section><section class="detail-panel"><h3>Stage history</h3><ol class="history">${(detail.stage_history || []).map(entry => `<li><time>${stamp(entry.occurred_at)}</time>${esc(stageLabel(entry.prior_stage))} → ${esc(stageLabel(entry.stage))}${entry.reason ? `<br><small>${esc(summary(entry.reason))}</small>` : ""}</li>`).join("") || '<li class="empty">No stage changes</li>'}</ol></section></div>`;
    $("detailStage").addEventListener("change", event => openReview(detail.id, event.target.value));
    for (const node of $("detailBody").querySelectorAll("details")) node.open = expanded.has(node.dataset.entryKey);
    const focused = focusedId ? $(focusedId) : [...$("detailBody").querySelectorAll("details")]
      .find(node => node.dataset.entryKey === focusedEntry)?.querySelector("summary");
    focused?.focus({ preventScroll: true });
    $("leadDetail").scrollTop = scroll;
  }
  async function readDetail(id, open = true) {
    const lead = leadById(id), epoch = ++state.detailEpoch, actor = state.actor;
    if (!lead || !state.identityReady) return;
    if (open) { state.detailId = id; state.detail = null; state.trigger = focusIdentity(doc.activeElement); $("detailTitle").textContent = leadTitle(lead); $("detailBody").innerHTML = '<p class="empty">Updating…</p>'; $("leadDetail").showModal(); }
    try {
      const response = await client.getLeadDetail(lead);
      if (epoch !== state.detailEpoch || actor !== state.actor) return;
      if (!leadById(id) || !response.detail || response.detail.id !== id || !eligibleLead(response.detail)) { $("leadDetail").close(); state.detail = null; return; }
      validateLeadDetail(response.detail, id);
      const unchanged = JSON.stringify(state.detail) === JSON.stringify(response.detail);
      state.detail = response.detail; if (!unchanged) paintDetail(response.detail);
    } catch (error) { if (epoch !== state.detailEpoch || authorizationFailure(error)) return; state.detail = null; $("detailBody").innerHTML = '<p class="empty">Connection interrupted · reconnecting…</p>'; }
  }
  async function openReview(id, target, { updating = false } = {}) {
    const lead = leadById(id);
    if (!lead || !state.identityReady || state.writing || state.pending || target === normalizedStage(lead) || !FILTER_STAGES.some(([key]) => key === target)) return;
    const priorQuestion = state.proposal?.review.question;
    state.proposal = null;
    if (!updating) { if (!$("leadDetail").open) state.trigger = focusIdentity(doc.activeElement); ++state.detailEpoch; $("leadDetail").close(); }
    state.reviewTarget = { id, target };
    const epoch = ++state.reviewEpoch, actor = state.actor;
    $("stageTitle").textContent = `Doc · ${leadTitle(lead)}`;
    if (!updating) { $("stageContext").innerHTML = '<p class="empty">Checking correspondence…</p>'; $("stageQuestions").innerHTML = ""; $("stageDialog").showModal(); }
    $("saveStage").disabled = true; $("stageError").hidden = true;
    try {
      const response = await client.getLeadDetail(lead);
      if (epoch !== state.reviewEpoch || actor !== state.actor || !$("stageDialog").open) return;
      const detail = response.detail;
      if (!leadById(id) || !detail || detail.id !== id || !eligibleLead(detail) || normalizedStage(detail) === target) { state.proposal = null; $("stageDialog").close(); return; }
      validateLeadDetail(detail, id);
      const review = stageReview(detail, target);
      state.proposal = { lead: detail, target, review, actor };
      $("stageContext").innerHTML = `<div class="stage-proposal">${esc(stageLabel(normalizedStage(detail)))} <span>→</span> ${esc(stageLabel(target))}</div><ul class="stage-evidence">${review.evidence.map(entry => `<li><b>${esc(summary(entry.summary))}</b> · ${shortDate(entry.occurred_at)}</li>`).join("") || '<li>No supporting mail or calendar entry</li>'}</ul>`;
      if (!updating || review.question !== priorQuestion) $("stageQuestions").innerHTML = review.question ? `<label>${esc(review.question)}<textarea name="answer" required maxlength="1000" autofocus></textarea></label>` : "";
      for (const input of $("stageQuestions").querySelectorAll("textarea")) input.disabled = false;
      $("saveStage").disabled = false; $("saveStage").textContent = target === "archived" ? "Archive lead" : `Confirm ${stageLabel(target)}`;
      if (!updating || review.question !== priorQuestion) $("stageQuestions").querySelector("textarea")?.focus();
    } catch (error) {
      if (epoch !== state.reviewEpoch || authorizationFailure(error)) return;
      $("stageError").textContent = "Correspondence unavailable · reconnecting…"; $("stageError").hidden = false;
    }
  }
  async function command(intent) {
    if (!state.identityReady || state.writing || state.pending) return;
    state.commandFeedback = null;
    state.pending = { ...intent, key: win.crypto.randomUUID(), actor: state.actor };
    return executePending();
  }
  async function executePending() {
    if (state.writing || !state.pending) return;
    state.writing = true;
    $("saveStage").disabled = true;
    const pending = state.pending, epoch = state.epoch;
    let mutationAttempted = false;
    try {
      const actor = await client.getActor();
      if (epoch !== state.epoch) return;
      if (!actor) { authorizationFailure({ code: "unauthorized" }); return; }
      if (actor !== pending.actor) { clearPrivateView(); state.actor = actor; await refresh(); return; }
      mutationAttempted = true;
      if (pending.kind === "link") await client.linkClient(pending.lead, pending.clientId, pending.key, pending.actor);
      else if (pending.kind === "claim") await client.claimLead(pending.lead, pending.key, pending.actor);
      else await client.recordStage(pending.lead, pending.stage, pending.review, pending.key, pending.actor);
      if (state.pending !== pending || state.actor !== actor) return;
      state.pending = null; state.commandFeedback = null; $("stageDialog").close();
      $("moveAnnouncement").textContent = pending.kind === "link" ? "Client linked" : pending.kind === "claim" ? "Lead claimed" : pending.review.undo_event_id ? "Stage restored" : `Moved to ${stageLabel(pending.stage)}`;
      await refresh();
    } catch (error) {
      if (state.pending !== pending) return;
      if (authorizationFailure(error)) return;
      if (mutationAttempted && error.code !== "unknown_outcome") state.pending = null;
      const message = error.code === "unknown_outcome" ? "Confirmation pending · checking current stage…" :
        ["version_conflict", "undo_changed"].includes(error.code) ? "Lead updated" : "Change unavailable";
      state.commandFeedback = message;
      $("stageError").textContent = message; $("stageError").hidden = false;
      paintCommandFeedback();
      if (error.code !== "unknown_outcome") state.writing = false;
      await refresh(); // Read only. An unknown write is never sent again automatically.
      paintCommandFeedback();
    } finally { state.writing = false; paintCommandFeedback(); }
  }
  function selectMarket(key) { state.filters.market = state.filters.market === key ? "" : key; render(); }
  for (const [id, key] of [["leadSearch", "search"], ["ownerFilter", "owner"], ["stageFilter", "stage"], ["marketFilter", "market"]]) {
    $(id).addEventListener(id === "leadSearch" ? "input" : "change", event => { state.filters[key] = event.target.value; render(); });
  }
  $("clearMarket").addEventListener("click", () => { state.filters.market = ""; render(); });
  $("marketCounts").addEventListener("click", event => { const button = event.target.closest("[data-market]"); if (button) selectMarket(button.dataset.market); });
  $("refreshBoard").addEventListener("click", () => refresh());
  $("closeDetail").addEventListener("click", () => $("leadDetail").close());
  $("closeStage").addEventListener("click", () => $("stageDialog").close());
  for (const id of ["leadDetail", "stageDialog"]) $(id).addEventListener("close", () => {
    if ($(id).open) return; // A queued close event may belong to an earlier opening.
    if (id === "stageDialog") { ++state.reviewEpoch; state.reviewTarget = null; state.proposal = null; }
    else { ++state.detailEpoch; state.detailId = null; state.detail = null; }
    paintCommandFeedback();
    if (!$("leadDetail").open && !$("stageDialog").open) restoreFocus(state.trigger);
  });
  $("stageForm").addEventListener("submit", event => {
    event.preventDefault(); if (state.pending) { executePending(); return; } const p = state.proposal;
    if (!p || p.actor !== state.actor || $("saveStage").disabled) return;
    const answer = String(new win.FormData(event.target).get("answer") || "").trim();
    if (p.review.question && !answer) return;
    command({ kind: "stage", lead: p.lead, stage: p.target, review: { reason: p.review.reason || answer,
      evidence_ids: p.review.evidence.map(entry => entry.id), ...(answer ? { human_quote: answer } : {}) } });
  });
  function clickLead(event) {
    const undo = event.target.closest("[data-undo]"); if (undo) { const lead = leadById(undo.dataset.undo), review = lead && undoReview(lead); if (review) command({ kind: "stage", lead, stage: review.stage, review: review.stage_review }); return; }
    const link = event.target.closest("[data-link]"); if (link) { const lead = leadById(link.dataset.link); if (lead) command({ kind: "link", lead, clientId: link.dataset.clientId }); return; }
    const claim = event.target.closest("[data-claim]"); if (claim) { const lead = leadById(claim.dataset.claim); if (lead) command({ kind: "claim", lead }); return; }
    const card = event.target.closest("[data-lead-id]"); if (card && !event.target.closest("[data-drag-handle]")) readDetail(card.dataset.leadId);
  }
  for (const id of ["leadBoard", "hotLeads"]) {
    $(id).addEventListener("click", clickLead);
    $(id).addEventListener("keydown", event => {
      if (event.target.closest("button")) return;
      const card = event.target.closest("[data-lead-id]"); if (!card) return;
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); readDetail(card.dataset.leadId); }
      if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); const lead = leadById(card.dataset.leadId);
        const index = BOARD_STAGES.findIndex(([key]) => key === normalizedStage(lead));
        const next = BOARD_STAGES[index + (event.key === "ArrowRight" ? 1 : -1)]; if (next) openReview(lead.id, next[0]);
      }
    });
  }
  const board = $("leadBoard");
  board.addEventListener("dragstart", event => { const card = event.target.closest("[data-lead-id]"); if (!card || state.pending) { event.preventDefault(); return; } state.drag = card.dataset.leadId; event.dataTransfer.setData("text/plain", state.drag); event.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
  board.addEventListener("dragover", event => { const column = event.target.closest("[data-stage]"); if (column && state.drag) { event.preventDefault(); column.dataset.dropActive = "true"; } });
  board.addEventListener("dragleave", event => { const column = event.target.closest("[data-stage]"); if (column) delete column.dataset.dropActive; });
  board.addEventListener("drop", event => { event.preventDefault(); const column = event.target.closest("[data-stage]"); if (column && state.drag) openReview(state.drag, column.dataset.stage); state.drag = null; });
  board.addEventListener("dragend", () => { state.drag = null; for (const node of board.querySelectorAll(".dragging")) node.classList.remove("dragging"); for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive; });
  let touch = null, scrollFrame = null;
  function highlightDrop(x, y) {
    const column = doc.elementFromPoint?.(x, y)?.closest("[data-stage]");
    for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive;
    if (column) column.dataset.dropActive = "true";
    return column;
  }
  function stopTouch() {
    const prior = touch; touch = null;
    if (scrollFrame !== null) win.cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
    if (prior?.handle.hasPointerCapture?.(prior.pointer)) prior.handle.releasePointerCapture(prior.pointer);
    for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive;
  }
  function scrollTouch() {
    if (!touch) return;
    if (Math.hypot(touch.x-touch.startX, touch.y-touch.startY)>8) {
      const edge = 72, height = win.innerHeight;
      const delta = touch.y < edge ? -18 * (1-touch.y/edge) : touch.y > height-edge ? 18 * (1-(height-touch.y)/edge) : 0;
      if (delta) win.scrollBy(0, delta);
      highlightDrop(touch.x, touch.y);
    }
    scrollFrame = win.requestAnimationFrame(scrollTouch);
  }
  board.addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-drag-handle]"); if (!handle || state.pending || !state.identityReady) return;
    stopTouch(); const card = handle.closest("[data-lead-id]");
    touch = { id: card.dataset.leadId, handle, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    handle.setPointerCapture?.(event.pointerId); scrollFrame = win.requestAnimationFrame(scrollTouch);
  });
  board.addEventListener("pointermove", event => { if (!touch || touch.pointer !== event.pointerId) return; touch.x = event.clientX; touch.y = event.clientY; highlightDrop(touch.x, touch.y); });
  board.addEventListener("pointerup", event => {
    if (!touch || touch.pointer !== event.pointerId) return;
    const { id, startX, startY } = touch, column = highlightDrop(event.clientX, event.clientY);
    stopTouch();
    if (column && Math.hypot(event.clientX-startX,event.clientY-startY)>8) openReview(id,column.dataset.stage);
  });
  board.addEventListener("pointercancel", stopTouch);
  board.addEventListener("lostpointercapture", stopTouch);
  mapFactory($("territoryMap"), selectMarket).then(map => { state.map = map; render(); }).catch(() => { $("territoryMap").innerHTML = '<p class="empty">Map unavailable</p>'; });
  function suspendPrivateView() {
    if (state.proposal && $("stageDialog").open) state.resumeReview = {
      id: state.proposal.lead.id, target: state.proposal.target, actor: state.actor,
      question: state.proposal.review.question, answer: $("stageQuestions").querySelector("textarea")?.value || "",
    };
    stopTouch(); ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch;
    state.identityReady = false; state.board = null; state.detail = null; state.detailId = null;
    state.proposal = null; state.reviewTarget = null; state.trigger = null; state.drag = null;
    $("leadDetail").close(); $("stageDialog").close();
    for (const id of ["detailTitle", "detailBody", "stageTitle", "stageContext", "stageQuestions", "stageError", "moveAnnouncement"]) $(id).replaceChildren();
    render();
  }
  const auto = mountAutoRefresh({ document: doc, window: win, refresh: () => refresh(), onResume: suspendPrivateView, shouldRefresh: () => !state.writing && !touch && !state.drag });
  const resume = () => { if (doc.visibilityState === "hidden") { stopTouch(); state.identityReady = false; ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch; } };
  doc.addEventListener("visibilitychange", resume);
  refresh();
  return { state, refresh, openReview, readDetail, dispose() { stopTouch(); ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch; auto.dispose(); state.map?.dispose(); doc.removeEventListener("visibilitychange", resume); } };
}
if (typeof document !== "undefined" && document.getElementById("hotLeads")) mountLeadsWorkspace();
