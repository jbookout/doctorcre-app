import { BUSINESS_TIME_ZONE } from './business-date.js';
import { toDay } from './calendar-model.js';
import { engagementWriterFor, engagementStorage } from './prospect-engagement.mjs';
import {onDialogClosed} from './dialog-lifecycle.js';
import { pageDocContext, publishDocRead, selectDocRecord, setDocFilters } from './doc-context.js';
import { createLeadBoardClient, validateLeadWorkspace, validateLeadDetail } from "./leads-client.js";
import { mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
import { BOARD_STAGES, FILTER_STAGES, stageLabel, normalizedStage, eligibleLead, leadTitle, marketKey,
  visibleLeads, hotLeadPanel, marketCounts, stageReview, automaticMove, undoReview } from "./leads-model.js";
import { mountTerritoryMap } from "./leads-territory-map.js";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortDate = (value, calendarDate = false) => Number.isFinite(Date.parse(value)) ? new Date(calendarDate && toDay(value) ? `${toDay(value)}T12:00:00Z` : value).toLocaleDateString("en-US", { timeZone: BUSINESS_TIME_ZONE, month: "numeric", day: "numeric" }) : "Date pending";
const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-US", { timeZone: BUSINESS_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "—";
const summary = value => String(value || "").split(/\n\s*\n/)[0].slice(0, 230);
const score = lead => lead.score == null ? "—" : esc(Math.round(Number(lead.score)));
const ownerName = owner => owner.charAt(0).toUpperCase() + owner.slice(1);
const skeletonCard = '<div class="lead-skeleton" aria-hidden="true"><span class="skeleton-line"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div>';
const options = (rows, selected, all) => `<option value="">${all}</option>${rows.map(([key, text]) => `<option value="${esc(key)}"${key === selected ? " selected" : ""}>${esc(text)}</option>`).join("")}`;

export function mountLeadsWorkspace(doc = document, client = createLeadBoardClient(), { mapFactory = mountTerritoryMap } = {}) {
  const $ = id => doc.getElementById(id), win = doc.defaultView || globalThis.window;
  const engagement = engagementWriterFor(client, engagementStorage(win));
  const engagementChecks = new Set();
  const state = { board: null, readFailed: false, actor: null, epoch: 0, detailEpoch: 0, reviewEpoch: 0, filters: { search: "", owner: "", stage: "", market: "" },
    selectedId: null, detail: null, detailId: null, resumeDetail: null, resumeReview: null, commandFeedback: null, connectionFeedback: null, proposal: null, reviewTarget: null, pending: null, writing: false, identityReady: false, trigger: null, drag: null, map: null };
  const leadById = id => state.board?.leads.find(lead => lead.id === id && eligibleLead(lead));
  const reviewComplete = (lead, target, undoEventId) => (undoEventId ? lead.stage : normalizedStage(lead)) === target;
  function captureReviewDraft() {
    const draft = state.reviewTarget, input = $("stageQuestions").querySelector("textarea");
    if (draft && input) draft.answer = input.value;
    return draft;
  }
  const locationLabel = lead => !state.map ? "Checking location…" : state.map.locate?.(lead) ? "Market area only" : "No location";
  function card(lead) {
    const move = automaticMove(lead), undo = undoReview(lead);
    const possible = lead.possible_clients || [];
    return `<article class="lead-card" data-lead-id="${esc(lead.id)}" data-selected="${lead.id === state.selectedId}" draggable="true">
      <span class="drag-handle" data-drag-handle aria-hidden="true">⠿</span><h3><button class="lead-open" data-open="${esc(lead.id)}" aria-pressed="${lead.id === state.selectedId}">${esc(leadTitle(lead))}</button></h3>
      <div class="card-foot"><span><span class="lead-market">${esc(marketKey(lead))}</span><small class="lead-location">${locationLabel(lead)}</small></span><div class="card-actions"><span class="score"><small>Score</small>${score(lead)}</span>${normalizedStage(lead) === "new" && !lead.owner ? `<button data-claim="${esc(lead.id)}">Claim</button>` : ""}</div></div>
      ${move ? `<div class="auto-move">Moved by Doc: ${esc(move.reason || "stage updated")} ${shortDate(move.evidence_date || move.occurred_at, !!move.evidence_date)}${undo ? `<button data-undo="${esc(lead.id)}">Undo</button>` : ""}</div>` : ""}
      ${possible.map(match => `<div class="client-hint">possible client: ${esc(match.name)} <button data-link="${esc(lead.id)}" data-client-id="${esc(match.client_id)}" aria-label="Link ${esc(leadTitle(lead))} to ${esc(match.name)}">Link</button></div>`).join("")}
    </article>`;
  }
  function focusIdentity(node) {
    const container = node?.closest?.("#leadBoard, #hotLeads, #marketCounts, #mapLeadMembers");
    if (container) {
      for (const attr of ["data-claim", "data-undo", "data-link", "data-open", "data-lead-id", "data-market"]) {
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
    if (!shown.some(lead => lead.id === state.selectedId)) state.selectedId = null;
    setDocFilters(state.filters);
    if (state.board) publishDocRead("getWorkspace", { ...state.board, leads: shown });
    const active = visibleLeads(leads);
    $("leadCount").textContent = `${active.length} total`;
    $("filterSummary").textContent = `${shown.length} matching ${shown.length === 1 ? "lead" : "leads"}`;
    $("ownerFilter").innerHTML = options(owners.map(k => [k, ownerName(k)]), state.filters.owner, "All owners");
    const groups = marketCounts(leads, state.filters, state.map?.locate);
    $("marketFilter").innerHTML = options(markets.map(k => [k, k]), state.filters.market, "All markets");
    $("clearMarket").hidden = !state.filters.market;
    $("marketCounts").innerHTML = groups.map(g => `<button data-market="${esc(g.key)}" aria-pressed="${g.key === state.filters.market}">${esc(g.key)}<b>${g.count}</b></button>`).join("") || '<p class="empty">No leads in these markets</p>';
    state.map?.update(groups, state.selectedId);
    const unlocated = state.map ? groups.reduce((count, group) => count + group.unlocatedIds.length, 0) : 0;
    $("mapLeadMembers").querySelector("summary").textContent = `${shown.length} ${shown.length === 1 ? "lead" : "leads"} · ${unlocated} no location`;
    $("mapLeadMembers").querySelector("div").innerHTML = shown.map(lead => `<button data-lead-id="${esc(lead.id)}" aria-pressed="${lead.id === state.selectedId}">${esc(leadTitle(lead))}<small>${esc(marketKey(lead))} · ${locationLabel(lead)}</small></button>`).join("") || '<p class="empty">No matching leads</p>';
    const hot = hotLeadPanel(leads);
    $("hotTitle").textContent = hot.claimable || !hot.newTotal ? "Top new leads to claim" : "Top new leads";
    $("hotSummary").textContent = !state.board ? "The hottest leads appear once the lead board loads." : hot.claimable ? `Across all markets and filters: ${hot.newTotal - hot.claimed} of ${hot.newTotal} New leads unclaimed`
      : hot.newTotal ? `Across all markets and filters: All ${hot.newTotal} New leads are claimed` : "No New leads yet. The next new-lead search adds them here.";
    $("hotLeads").innerHTML = hot.rows.map((lead, i) => `<article class="hot-row" data-lead-id="${esc(lead.id)}"><span class="hot-rank">${i + 1}</span><div><h3><button class="lead-open" data-open="${esc(lead.id)}" aria-pressed="${lead.id === state.selectedId}">${esc(leadTitle(lead))}</button></h3><small>${esc(marketKey(lead))}</small></div><span class="score">${score(lead)}</span>${hot.claimable ? `<button data-claim="${esc(lead.id)}">Claim</button>` : `<span class="hot-owner">${esc(ownerName(lead.owner))}</span>`}</article>`).join("");
    $("hotLeads").setAttribute("aria-busy", "false");
    const currentStage = state.filters.stage;
    $("stageFilter").innerHTML = `<option value="">All stages · ${visibleLeads(leads, { ...state.filters, stage: "" }).length}</option>` + FILTER_STAGES.map(([key, label]) => `<option value="${key}"${key === currentStage ? " selected" : ""}>${esc(label)} · ${visibleLeads(leads, { ...state.filters, stage: key }).length}</option>`).join("");
    const loading = !state.board && !state.readFailed;
    $("territoryMap").setAttribute("aria-busy", String(loading));
    if (loading) {
      $("leadBoard").innerHTML = '<span class="sr-only" role="status">Loading leads…</span><div class="stage-columns" aria-hidden="true">' + BOARD_STAGES.map(() => `<section class="stage-column"><div class="stage-head"><span class="skeleton-line"></span></div><div class="lead-stack">${skeletonCard.repeat(2)}</div></section>`).join("") + '</div>';
      $("hotLeads").innerHTML = '<div aria-hidden="true">' + Array.from({ length: 5 }, () => '<div class="hot-row hot-skeleton"><span class="skeleton-line"></span><div><span class="skeleton-line"></span><span class="skeleton-line"></span></div><span class="skeleton-line"></span><span class="skeleton-line"></span></div>').join("") + '</div>';
      $("hotLeads").setAttribute("aria-busy", "true");
    } else if (state.board && !shown.length && Object.values(state.filters).some(Boolean)) {
      $("leadBoard").innerHTML = '<div class="filtered-empty"><p>No leads match these filters.</p><button id="resetFilters">Reset filters</button></div>';
      $("resetFilters").addEventListener("click", () => {
        state.filters = { search: "", owner: "", stage: "", market: "" };
        $("leadSearch").value = "";
        render();
        $("leadSearch").focus({ preventScroll: true });
      });
    } else if (state.board && !shown.length) {
      $("leadBoard").innerHTML = '<div class="filtered-empty"><p>No active leads are on the board.</p><button id="refreshEmptyBoard">Refresh leads</button></div>';
      $("refreshEmptyBoard").addEventListener("click", () => refresh());
    } else if (state.filters.stage === "archived") {
      $("leadBoard").innerHTML = `<div class="filtered-list" aria-label="${stageLabel(state.filters.stage)}">${shown.map(card).join("") || '<p class="empty">No matching leads</p>'}</div>`;
    } else {
      $("leadBoard").innerHTML = `<div class="stage-columns">${BOARD_STAGES.map(([key, text]) => {
        const rows = shown.filter(lead => normalizedStage(lead) === key);
        return `<section class="stage-column" data-mobile-current="${!currentStage || key === currentStage}" data-stage="${key}" aria-label="${text}"><h2 class="stage-head">${text}<span>${rows.length}</span></h2><div class="lead-stack">${rows.map(card).join("") || `<p class="stage-empty">No leads in ${text}</p>`}</div></section>`;
      }).join("")}</div>`;
    }

    // The time states the snapshot on screen, as Deals does: a failed refresh
    // that keeps the board keeps its time beside the reconnecting line, and
    // only a failed read with nothing to show is "Unavailable".
    $("boardUpdated").textContent = state.board ? updatedLabel(state.board.generated_at) : state.readFailed ? "Unavailable" : "Updating…";
    $("boardUpdated").dateTime = state.board?.generated_at || "";
    $("searchUpdated").textContent = `New-lead search ${state.board?.last_search_at ? stamp(state.board.last_search_at) : "—"}`;
    paintWriteControls();
    if (focused?.container) restoreFocus(focused);
  }
  function paintWriteControls() {
    const disabled = !state.identityReady || state.writing || Boolean(state.pending);
    for (const control of doc.querySelectorAll("[data-claim], [data-link], [data-undo], #detailStage")) control.disabled = disabled;
  }
  function paintCommandFeedback() {
    paintWriteControls();
    const box = $("leadBoardError");
    const command = state.pending ? 'Confirmation pending <button id="checkPending">Check outcome</button>' : esc(state.commandFeedback);
    const engagements = engagement.values(state.actor).map(pending => `${esc(leadTitle(state.board?.leads.find(lead => lead.prospect_client_id === pending.request.client_id) || { name: "Prospect" }))}: Confirmation pending <button data-check-engagement="${esc(pending.request.client_id)}"${pending.sending ? " disabled" : ""}>Check outcome</button>`);
    box.hidden = !state.pending && !engagements.length && !state.commandFeedback && !state.connectionFeedback;
    box.innerHTML = [command, ...engagements, esc(state.connectionFeedback)].filter(Boolean).join(" · ");
    if (!state.actor && state.connectionFeedback === "Sign-in required") box.insertAdjacentHTML("beforeend", ` · <a href="/auth/login?return_to=${encodeURIComponent(win.location.pathname + win.location.search)}">Sign in</a>`);
    if (state.readFailed && state.connectionFeedback && state.connectionFeedback !== "Sign-in required") {
      box.insertAdjacentHTML("beforeend", ' <button type="button" id="retryLeadRead">Retry</button>');
      $("retryLeadRead").addEventListener("click", () => auto.refresh());
    }
    $("checkPending")?.addEventListener("click", executePending);
    for (const button of box.querySelectorAll("[data-check-engagement]")) button.addEventListener("click", () => executeEngagement(engagement.get(button.dataset.checkEngagement, state.actor)?.request));
    const form = $("activateProspect"), activation = engagement.get(state.detail?.prospect_client_id, state.actor);
    if (form) {
      form.elements.reason.readOnly = Boolean(activation);
      if (activation) form.elements.reason.value = activation.request.reason;
      form.querySelector("button").disabled = Boolean(activation?.sending);
      form.querySelector("button").textContent = activation ? "Check outcome" : "Mark active";
    }
    if (state.pending && $("stageDialog").open) {
      $("saveStage").textContent = "Check outcome"; $("saveStage").disabled = state.writing;
      for (const input of $("stageQuestions").querySelectorAll("textarea")) input.disabled = true;
    }
  }
  function clearPrivateView() {
    pageDocContext?.clear();
    state.commandFeedback = null; state.connectionFeedback = null; state.board = null; state.detailId = null; state.detail = null; state.proposal = null; state.reviewTarget = null; state.resumeReview = null; state.resumeDetail = null; state.pending = null;
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
  // Resolves false when the read failed for a reason other than sign-in, so
  // background refresh retries soon; a superseded read resolves undefined.
  async function refresh() {
    pageDocContext?.clear();
    const epoch = ++state.epoch;
    state.identityReady = false;
    paintWriteControls();
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
      state.readFailed = false; state.board = next;
      for (const lead of next.leads) engagement.confirm({ client_id: lead.prospect_client_id,
        status: lead.prospect_engagement_status, version: lead.prospect_client_version }, state.actor);
      if (state.pending) {
        const current = next.leads.find(l => l.id === state.pending.lead.id);
        const move = current?.last_stage_move;
        if ((state.pending.kind === "link" && current?.client_id === state.pending.clientId) ||
            (state.pending.kind === "stage" && move?.idempotency_key === state.pending.key) ||
            (state.pending.kind === "claim" && current?.owner === state.pending.actor)) {
          state.pending = null; state.commandFeedback = null; $("stageDialog").close();
        }
      }
      render();
      paintCommandFeedback();
      const resumeReview = state.resumeReview;
      state.resumeReview = null;
      if (resumeReview?.actor === state.actor && !state.pending) {
        await openReview(resumeReview.id, resumeReview.target, { undoEventId: resumeReview.undoEventId, draft: resumeReview });
      }
      if (!resumeReview && state.reviewTarget && $("stageDialog").open && !state.writing && !state.pending) {
        const { id, target, undoEventId } = state.reviewTarget, current = leadById(id);
        if (!current || reviewComplete(current, target, undoEventId)) $("stageDialog").close();
        else await openReview(id, target, { updating: true, undoEventId });
      }
      const resumeDetail = state.resumeDetail;
      if (resumeDetail && (resumeDetail.actor !== state.actor || !leadById(resumeDetail.id))) state.resumeDetail = null;
      if (state.resumeDetail) await readDetail(resumeDetail.id, true, resumeDetail);
      else if (state.detailId && $("leadDetail").open) {
        if (leadById(state.detailId)) await readDetail(state.detailId, false);
        else if (next.leads.some(lead => lead.id === state.detailId)) { state.detail = null; $("leadDetail").close(); }
        else { state.detail = null; ++state.detailEpoch; $("detailTitle").textContent = "Lead unavailable"; $("detailBody").innerHTML = '<p class="empty">Unavailable</p>'; }
      }
      return true;
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.readFailed = true;
      if (authorizationFailure(error)) return;
      // A refused verification/read cannot leave the previous private snapshot visible.
      if (!state.identityReady) state.board = null;
      state.identityReady = false; state.detail = null; state.detailId = null;
      ++state.detailEpoch; state.trigger = null;
      $("leadDetail").close(); $("detailTitle").textContent = ""; $("detailBody").replaceChildren();
      render();
      state.connectionFeedback = "Connection interrupted · reconnecting…";
      paintCommandFeedback();
      return false;
    } finally {
      if (epoch === state.epoch) $("leadBoard").setAttribute("aria-busy", "false");
      paintWriteControls();
    }
  }
  function paintDetail(detail, intent = null) {
    const active = doc.activeElement;
    const focusedEntry = active?.matches("summary") ? active.closest("#detailBody details")?.dataset.entryKey : null;
    const focusedId = $("detailBody").contains(active) ? active.id : null;
    const expanded = new Set(intent?.expanded ?? [...$("detailBody").querySelectorAll("details[open]")].map(node => node.dataset.entryKey));
    const scroll = intent?.scroll ?? $("leadDetail").scrollTop;
    $("detailTitle").textContent = leadTitle(detail);
    const contact = (kind, value) => value ? `<a href="${kind === "Email" ? "mailto:" : "tel:"}${esc(value)}">${esc(value)}</a>` : "—";
    $("detailBody").innerHTML = `<section class="detail-summary"><div><h3>Lead score</h3><div class="detail-score">${score(detail)}<span>/ 100</span></div></div><label>Stage<select id="detailStage">${FILTER_STAGES.filter(([key]) => key !== "do_not_contact").map(([key,text]) => `<option value="${key}"${normalizedStage(detail) === key ? " selected" : ""}>${text}</option>`).join("")}</select></label></section>
      <div class="detail-overview"><section class="detail-panel"><h3>Contact</h3><dl><dt>Phone</dt><dd>${contact("Phone", detail.phone)}</dd><dt>Email</dt><dd>${contact("Email", detail.email)}</dd><dt>Market</dt><dd>${esc(marketKey(detail))}</dd><dt>Vertical</dt><dd>${esc(detail.specialty || detail.vertical || "—")}</dd></dl></section>
      <section class="detail-panel"><h3>Plans</h3><p>${esc(summary(detail.plans || detail.notes) || "—")}</p>${detail.notes ? `<details data-entry-key="plans"><summary>Details</summary><div class="original-entry">${esc(detail.notes)}</div></details>` : ""}<dl class="plan-window"><dt>Lease window</dt><dd>${esc(detail.est_lease_event || "—")}</dd></dl></section>
      </div>
      ${detail.prospect_client_id && detail.prospect_engagement_status === "inactive" ? `<form id="activateProspect"><p>Mark active to return this prospect to the deal board.</p><label>Reason<input name="reason" maxlength="1000" required></label><button type="submit">Mark active</button></form>` : ""}
      <div class="detail-columns"><section class="detail-panel"><h3>Correspondence</h3><ol class="correspondence">${(detail.correspondence || []).map(entry => `<li><time>${stamp(entry.occurred_at)}</time><p>${esc(summary(entry.summary))}</p><details data-entry-key="${esc(entry.id)}"><summary>Details</summary><div class="original-entry">${esc(entry.detail || entry.summary)}</div></details></li>`).join("") || '<li class="empty">No correspondence yet</li>'}</ol></section><section class="detail-panel"><h3>Stage history</h3><ol class="history">${(detail.stage_history || []).map(entry => `<li><time>${stamp(entry.occurred_at)}</time>${esc(stageLabel(entry.prior_stage))} → ${esc(stageLabel(entry.stage))}${entry.reason ? `<br><small>${esc(summary(entry.reason))}</small>` : ""}</li>`).join("") || '<li class="empty">No stage changes</li>'}</ol></section></div>`;
    $("detailStage").addEventListener("change", event => openReview(detail.id, event.target.value));
    $("activateProspect")?.addEventListener("submit", event => {
      event.preventDefault();
      const reason = event.currentTarget.elements.reason.value.trim();
      if (reason) command({kind:"engagement",lead:detail,reason});
    });
    for (const node of $("detailBody").querySelectorAll("details")) node.open = expanded.has(node.dataset.entryKey);
    const focused = focusedId ? $(focusedId) : [...$("detailBody").querySelectorAll("details")]
      .find(node => node.dataset.entryKey === focusedEntry)?.querySelector("summary");
    focused?.focus({ preventScroll: true });
    $("leadDetail").scrollTop = scroll;
    paintCommandFeedback();
  }
  async function readDetail(id, open = true, intent = null) {
    const lead = leadById(id), epoch = ++state.detailEpoch, actor = state.actor;
    if (!lead || !state.identityReady) return;
    if (open) { state.resumeDetail = intent; state.selectedId = id; render(); selectDocRecord("lead", id); state.detailId = id; state.detail = null; state.trigger = focusIdentity(doc.activeElement); $("detailTitle").textContent = leadTitle(lead); $("detailBody").innerHTML = '<p class="empty">Updating…</p>'; $("leadDetail").showModal(); }
    try {
      const response = await client.getLeadDetail(lead);
      if (epoch !== state.detailEpoch || actor !== state.actor) return;
      if (!leadById(id) || !response.detail || response.detail.id !== id || !eligibleLead(response.detail)) { state.resumeDetail = null; $("leadDetail").close(); state.detail = null; return; }
      validateLeadDetail(response.detail, id);
      selectDocRecord("lead", id);
      const unchanged = JSON.stringify(state.detail) === JSON.stringify(response.detail);
      state.detail = response.detail; if (!unchanged) paintDetail(response.detail, intent);
      state.resumeDetail = null;
    } catch (error) { if (epoch !== state.detailEpoch || authorizationFailure(error)) return; state.detail = null; $("detailBody").innerHTML = '<p class="empty">Connection interrupted · reconnecting…</p>'; }
  }
  async function openReview(id, target, { updating = false, undoEventId = null, draft = null } = {}) {
    const lead = leadById(id);
    if (!lead || !state.identityReady || state.writing || state.pending || reviewComplete(lead, target, undoEventId) || (!undoEventId && !FILTER_STAGES.some(([key]) => key === target))) return;
    if (updating) draft = captureReviewDraft();
    if (!draft || draft.actor !== state.actor || draft.id !== id || draft.target !== target || draft.undoEventId !== undoEventId) {
      draft = { id, target, undoEventId, actor: state.actor, question: null, answer: "" };
    }
    const priorQuestion = draft.question;
    state.proposal = null;
    if (!updating) { if (!$("leadDetail").open) state.trigger = focusIdentity(doc.activeElement); ++state.detailEpoch; $("leadDetail").close(); }
    selectDocRecord("lead", id);
    state.reviewTarget = draft;
    const epoch = ++state.reviewEpoch, actor = state.actor;
    $("stageTitle").textContent = `Doc · ${leadTitle(lead)}`;
    if (!updating) { $("stageContext").innerHTML = '<p class="empty">Checking correspondence…</p>'; $("stageQuestions").innerHTML = ""; $("stageDialog").showModal(); }
    $("saveStage").disabled = true; $("stageError").hidden = true;
    try {
      const response = await client.getLeadDetail(lead);
      if (epoch !== state.reviewEpoch || actor !== state.actor || state.reviewTarget !== draft || !$("stageDialog").open) return;
      const detail = response.detail;
      if (!leadById(id) || !detail || detail.id !== id || !eligibleLead(detail) || reviewComplete(detail, target, undoEventId)) { state.proposal = null; $("stageDialog").close(); return; }
      validateLeadDetail(detail, id);
      const undo = undoEventId ? undoReview(detail) : null;
      if (undoEventId && (undo?.stage_review.undo_event_id !== undoEventId || undo.stage !== target)) { $("stageDialog").close(); return; }
      const review = undo ? { evidence: [], question: undo.question, reason: undo.stage_review.reason } : stageReview(detail, target);
      if (review.question !== priorQuestion) draft.answer = "";
      draft.question = review.question;
      state.proposal = { lead: detail, target, review, actor, undoEventId };
      $("stageContext").innerHTML = `<div class="stage-proposal">${esc(stageLabel(normalizedStage(detail)))} <span>→</span> ${esc(stageLabel(target))}</div><ul class="stage-evidence">${review.evidence.map(entry => `<li><b>${esc(summary(entry.summary))}</b> · ${shortDate(entry.occurred_at)}</li>`).join("") || '<li>No supporting mail or calendar entry</li>'}</ul>`;
      if (!updating || review.question !== priorQuestion) {
        $("stageQuestions").innerHTML = review.question ? `<label>${esc(review.question)}<textarea name="answer" required maxlength="1000" autofocus></textarea></label>` : "";
        const input = $("stageQuestions").querySelector("textarea");
        if (input) input.value = draft.answer;
      }
      for (const input of $("stageQuestions").querySelectorAll("textarea")) input.disabled = false;
      $("saveStage").disabled = false; $("saveStage").textContent = undo ? "Restore stage" : target === "archived" ? "Archive lead" : `Confirm ${stageLabel(target)}`;
      if (!updating || review.question !== priorQuestion) $("stageQuestions").querySelector("textarea")?.focus();
    } catch (error) {
      if (epoch !== state.reviewEpoch || authorizationFailure(error)) return;
      $("stageError").textContent = "Correspondence unavailable · reconnecting…"; $("stageError").hidden = false;
    }
  }
  async function command(intent) {
    if (intent.kind === "engagement") {
      if (!state.identityReady) return;
      const clientId = intent.lead.prospect_client_id;
      return executeEngagement({ client_id: clientId, base_version: intent.lead.prospect_client_version,
        status: "active", reason: intent.reason, human_quote: intent.reason, expected_actor: state.actor });
    }
    if (!state.identityReady || state.writing || state.pending) return;
    state.commandFeedback = null;
    state.pending = { ...intent, key: win.crypto.randomUUID(), actor: state.actor };
    return executePending();
  }
  async function executeEngagement(args) {
    if (!args || engagement.get(args.client_id, state.actor)?.sending || engagementChecks.has(args.client_id)) return;
    if (!engagement.get(args.client_id, state.actor)) {
      engagementChecks.add(args.client_id);
      try {
        const lead = state.board?.leads.find(lead => lead.prospect_client_id === args.client_id);
        if (!lead) throw new Error("Prospect unavailable");
        const current = (await client.getLeadDetail(lead)).detail;
        validateLeadDetail(current, lead.id);
        if (state.actor !== args.expected_actor) return;
        if (current.prospect_client_id !== args.client_id || current.prospect_client_version !== args.base_version) {
          await refresh();
          const form = $("activateProspect");
          if (form && state.detail?.prospect_client_id === args.client_id) form.elements.reason.value = args.reason;
          state.commandFeedback = "This prospect changed. Review the current record and your kept reason before confirming again.";
          paintCommandFeedback();
          return;
        }
      } catch (error) {
        if (authorizationFailure(error)) return;
        state.commandFeedback = "Change not sent. The current prospect could not be verified.";
        paintCommandFeedback();
        return;
      } finally { engagementChecks.delete(args.client_id); }
    }
    const status = engagement.get(args.client_id, state.actor)?.request.status || args.status;
    state.commandFeedback = null;
    const operation = engagement(args, {
      readBack: async () => {
        if (await refresh() !== true) return null;
        const lead = state.board?.leads.find(lead => lead.prospect_client_id === args.client_id);
        return { client_id: lead?.prospect_client_id, status: lead?.prospect_engagement_status, version: lead?.prospect_client_version };
      },
      beforeSend: async request => {
        const actor = await client.getActor();
        if (actor !== request.expected_actor) {
          clearPrivateView(); state.actor = actor; await refresh();
          throw Object.assign(new Error("Account changed"), { code: "account_changed" });
        }
      },
    });
    paintCommandFeedback();
    try {
      await operation;
      if (state.actor !== args.expected_actor) return;
      $("moveAnnouncement").textContent = status === "active" ? "Prospect returned to the deal board" : "Prospect returned to Leads";
      await refresh();
    } catch (error) {
      if (state.actor !== args.expected_actor || authorizationFailure(error)) return;
      if (!engagement.get(args.client_id, state.actor)) state.commandFeedback = error.code === "version_conflict" ? "Lead updated" : "Change unavailable";
      await refresh();
    } finally { paintCommandFeedback(); }
  }
  async function executePending() {
    if (state.writing || !state.pending) return;
    state.writing = true;
    paintWriteControls();
    $("saveStage").disabled = true;
    const pending = state.pending, epoch = state.epoch;
    let mutationAttempted = false;
    try {
      const actor = await client.getActor();
      if (epoch !== state.epoch) return;
      if (!actor) { authorizationFailure({ code: "unauthorized" }); return; }
      if (actor !== pending.actor) { clearPrivateView(); state.actor = actor; await refresh(); return; }
      // A review can remain open while a partner edits. Check the exact lead
      // once before sending; an unanswered write keeps its reviewed request.
      if (!pending.attempted) {
        const current = (await client.getLeadDetail(pending.lead)).detail;
        if (epoch !== state.epoch || state.pending !== pending) return;
        validateLeadDetail(current, pending.lead.id);
        if (current.base_version !== pending.lead.base_version) {
          state.pending = null; state.writing = false;
          await refresh();
          const message = "This lead changed. Review the current record before confirming again.";
          state.commandFeedback = message;
          $("stageError").textContent = message; $("stageError").hidden = false;
          paintCommandFeedback();
          return;
        }
        pending.attempted = true;
      }
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
  function selectMarket(key) { state.filters.market = state.filters.market === key ? "" : key; $("mapLeadMembers").open = true; render(); }
  for (const [id, key] of [["leadSearch", "search"], ["ownerFilter", "owner"], ["marketFilter", "market"]]) {
    $(id).addEventListener(id === "leadSearch" ? "input" : "change", event => { state.filters[key] = event.target.value; render(); });
  }
  $("stageFilter").addEventListener("change", event => {
    state.filters.stage = event.target.value;
    render();
    $("stageFilter").scrollIntoView?.({ block: "start" });
  });
  $("clearMarket").addEventListener("click", () => { state.filters.market = ""; render(); });
  $("marketCounts").addEventListener("click", event => { const button = event.target.closest("[data-market]"); if (button) selectMarket(button.dataset.market); });
  $("refreshBoard").addEventListener("click", () => refresh());
  $("closeDetail").addEventListener("click", () => $("leadDetail").close());
  $("closeStage").addEventListener("click", () => $("stageDialog").close());
  for (const id of ["leadDetail", "stageDialog"]) onDialogClosed($(id), () => {
    if (id === "stageDialog") { ++state.reviewEpoch; state.reviewTarget = null; state.proposal = null; }
    else { ++state.detailEpoch; state.detailId = null; state.detail = null; if (state.identityReady) state.resumeDetail = null; }
    paintCommandFeedback();
    if (!$("leadDetail").open && !$("stageDialog").open) {
      selectDocRecord("lead", null);
      pageDocContext?.release("getLeadDetail");
      if (doc.activeElement === doc.body || $(id).contains(doc.activeElement)) restoreFocus(state.trigger);
    }
  });
  $("stageForm").addEventListener("submit", event => {
    event.preventDefault(); if (state.pending) { executePending(); return; } const p = state.proposal;
    if (!p || p.actor !== state.actor || $("saveStage").disabled) return;
    const answer = String(new win.FormData(event.target).get("answer") || "").trim();
    if (p.review.question && !answer) return;
    command({ kind: "stage", lead: p.lead, stage: p.target, review: p.undoEventId ? undoReview(p.lead, answer).stage_review : { reason: p.review.reason || answer,
      evidence_ids: p.review.evidence.map(entry => entry.id), ...(answer ? { human_quote: answer } : {}) } });
  });
  function clickLead(event) {
    const undo = event.target.closest("[data-undo]"); if (undo) { const lead = leadById(undo.dataset.undo), review = lead && undoReview(lead); if (review) openReview(lead.id, review.stage, { undoEventId: review.stage_review.undo_event_id }); return; }
    const link = event.target.closest("[data-link]"); if (link) { const lead = leadById(link.dataset.link); if (lead) command({ kind: "link", lead, clientId: link.dataset.clientId }); return; }
    const claim = event.target.closest("[data-claim]"); if (claim) { const lead = leadById(claim.dataset.claim); if (lead) command({ kind: "claim", lead }); return; }
    const card = event.target.closest("[data-lead-id]"); if (card && !event.target.closest("[data-drag-handle]")) readDetail(card.dataset.leadId);
  }
  for (const id of ["leadBoard", "hotLeads", "mapLeadMembers"]) {
    $(id).addEventListener("click", clickLead);
    $(id).addEventListener("keydown", event => {
      if (event.target.closest("button:not([data-open])")) return;
      const card = event.target.closest("[data-lead-id]"); if (!card) return;
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
  board.addEventListener("dragend", () => { state.drag = null; for (const node of board.querySelectorAll(".dragging")) node.classList.remove("dragging"); for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive; render(); });
  let touch = null, scrollFrame = null;
  function highlightDrop(x, y) {
    const column = doc.elementFromPoint?.(x, y)?.closest("[data-stage]");
    for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive;
    if (column) column.dataset.dropActive = "true";
    return column;
  }
  function stopTouch() {
    const prior = touch; touch = null;
    delete board.dataset.touchDragging;
    if (scrollFrame !== null) win.cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
    if (prior?.handle.hasPointerCapture?.(prior.pointer)) prior.handle.releasePointerCapture(prior.pointer);
    for (const node of board.querySelectorAll("[data-drop-active]")) delete node.dataset.dropActive;
    if (prior) render();
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
    board.dataset.touchDragging = "true";
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
  render();
  mapFactory($("territoryMap"), selectMarket, readDetail).then(map => { state.map = map; if (!state.drag && !touch) render(); }).catch(() => { $("territoryMap").innerHTML = '<p class="empty">Map unavailable</p>'; });
  function suspendPrivateView() {
    pageDocContext?.clear();
    if (state.reviewTarget && $("stageDialog").open) state.resumeReview = captureReviewDraft();
    if (state.detailId && $("leadDetail").open && !state.resumeDetail) state.resumeDetail = {
      actor: state.actor, id: state.detailId, scroll: $("leadDetail").scrollTop,
      expanded: [...$("detailBody").querySelectorAll("details[open]")].map(node => node.dataset.entryKey),
    };
    stopTouch(); ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch;
    state.identityReady = false; state.board = null; state.detail = null; state.detailId = null;
    state.proposal = null; state.reviewTarget = null; state.trigger = null; state.drag = null;
    $("leadDetail").close(); $("stageDialog").close();
    for (const id of ["detailTitle", "detailBody", "stageTitle", "stageContext", "stageQuestions", "stageError", "moveAnnouncement"]) $(id).replaceChildren();
    render();
  }
  const auto = mountAutoRefresh({ document: doc, window: win, refresh: async () => { if (await refresh() === false) throw new Error("Lead board read failed"); }, onResume: suspendPrivateView, shouldRefresh: () => !state.writing && !touch && !state.drag });
  const resume = () => { if (doc.visibilityState === "hidden") { pageDocContext?.clear(); stopTouch(); state.identityReady = false; ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch; } };
  doc.addEventListener("visibilitychange", resume);
  auto.refresh();
  return { state, refresh, openReview, readDetail, dispose() { stopTouch(); ++state.epoch; ++state.detailEpoch; ++state.reviewEpoch; auto.dispose(); state.map?.dispose(); doc.removeEventListener("visibilitychange", resume); } };
}
if (typeof document !== "undefined" && document.getElementById("hotLeads")) mountLeadsWorkspace();
