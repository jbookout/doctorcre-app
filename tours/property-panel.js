const FIELD_LABELS = Object.freeze([
  ["county", "County"], ["municipality", "Municipality"], ["special_authority", "Special authority"],
  ["parcel", "Parcel"], ["site_address", "Site address"], ["building", "Building"],
]);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const panelStates = new WeakMap();

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function shortDate(value) {
  const date = Date.parse(value);
  return Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10) : "Unknown";
}
function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function sourceLink(locator) {
  if (typeof locator !== "string") return "Unknown";
  try {
    const url = new URL(locator);
    if (url.protocol !== "https:") return escape(locator);
    return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">Details</a>`;
  } catch { return escape(locator); }
}
function stateLabel(status) {
  if (status === "reviewed") return "Reviewed";
  if (status === "conflicted") return "Conflicting evidence";
  if (status === "unavailable") return "Coverage unavailable";
  return "Unknown";
}
function diagramValue(value) {
  return value.length > 25 ? `${value.slice(0, 24)}…` : value;
}
function humanToken(value) {
  return typeof value === "string" ? value.replaceAll("_", " ") : "Unknown";
}
export function propertyPanelView(evidence) {
  const facts = evidence?.schema === "tour-property-evidence.v1" && evidence.facts && typeof evidence.facts === "object" ? evidence.facts : {};
  return FIELD_LABELS.map(([field, label]) => {
    const raw = facts[field] && typeof facts[field] === "object" ? facts[field] : {};
    const status = ["reviewed", "conflicted", "unavailable", "unknown"].includes(raw.status) ? raw.status : "unknown";
    return { field, label, status, state_label: stateLabel(status),
      value: status === "reviewed" && typeof raw.value === "string" && raw.value.trim() ? raw.value : "Unknown",
      as_of: raw.as_of || null, effective_from: raw.effective_from || null, effective_to: raw.effective_to || null,
      geometry_precision: raw.geometry_precision || "unknown", geometry_method: raw.geometry_method || null,
      source_crs: raw.source_crs || null, review_state: raw.review_state || "unknown",
      source: raw.source || null, determination_status: "context_only",
      conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [] };
  });
}
function provenance(item) {
  return `<dl class="property-provenance">
    <div><dt>Reference</dt><dd>${sourceLink(item.source?.locator)}</dd></div>
    <div><dt>Evidence class</dt><dd>${escape(humanToken(item.source?.evidence_class))}</dd></div>
    <div><dt>Retrieved</dt><dd>${escape(shortDate(item.source?.retrieved_at))}</dd></div>
    <div><dt>As of</dt><dd>${escape(shortDate(item.as_of))}</dd></div>
    <div><dt>Effective</dt><dd>${escape(shortDate(item.effective_from))}${item.effective_to ? ` to ${escape(shortDate(item.effective_to))}` : " onward"}</dd></div>
    <div><dt>Geometry precision</dt><dd>${escape(humanToken(item.geometry_precision))}</dd></div>
    <div><dt>Geometry method</dt><dd>${escape(humanToken(item.geometry_method))}</dd></div>
    <div><dt>Coordinate system</dt><dd>${escape(item.source_crs || "Unknown")}</dd></div>
    <div><dt>Review</dt><dd>${escape(item.review_state)}</dd></div>
    <div><dt>Determination</dt><dd>Context only</dd></div>
  </dl>`;
}
export function propertyFactDetail(item) {
  const conflict = item.conflicts.length ? `<div class="property-conflicts"><b>Conflicting details</b>${item.conflicts.map(candidate =>
    `<section><h4>${escape(candidate.value || "Unknown")}</h4>${provenance(candidate)}</section>`).join("")}</div>` : "";
  return `${provenance(item)}${conflict}`;
}
function diagram(items) {
  const x = [20, 275, 530, 20, 275, 530];
  const y = [20, 20, 20, 126, 126, 126];
  const lines = [[0, 1], [1, 2], [0, 3], [1, 4], [2, 5], [3, 4], [4, 5]];
  return `<svg class="property-layer-diagram" viewBox="0 0 790 235" role="img" aria-label="Jurisdiction and site evidence layers">
    <title>Jurisdiction and site evidence layers</title>
    ${lines.map(([a, b]) => `<path class="property-flow" d="M ${x[a] + 220} ${y[a] + 36} L ${x[b] + 20} ${y[b] + 36}"/>`).join("")}
    ${items.map((item, index) => `<g class="property-layer-node ${escape(item.status)}" data-layer="${escape(item.field)}" transform="translate(${x[index]} ${y[index]})">
      <rect width="230" height="74" rx="14"/><circle cx="22" cy="22" r="6"/>
      <text x="37" y="27" class="node-label">${escape(item.label)}</text>
      <text x="18" y="56" class="node-value">${escape(diagramValue(item.value))}</text>
    </g>`).join("")}
  </svg>`;
}
export function renderPropertyPanel(evidence) {
  const items = propertyPanelView(evidence);
  return `<div class="property-panel-body">
    ${diagram(items)}
    <div class="property-fact-grid">${items.map(item => `<button type="button" class="property-fact ${escape(item.status)}" data-evidence-field="${escape(item.field)}" aria-haspopup="dialog">
      <span class="property-fact-title">${escape(item.label)} <span>${escape(item.state_label)}</span></span>
      <strong>${escape(item.value)}</strong>
      <small>${escape(shortDate(item.as_of))} · ${escape(humanToken(item.geometry_precision))}</small>
      ${item.source?.locator ? `<small>${escape(item.source.locator)}</small>` : ""}
      ${item.conflicts.length ? `<small>${item.conflicts.map(candidate => escape(candidate.value || "Unknown")).join(" · ")}</small>` : ""}
    </button>`).join("")}</div>
    <p class="property-context-note"><b>Context only.</b> Jurisdiction and parcel evidence is analytical context. Verify the governing authority before a legal or regulatory decision.</p>
  </div>`;
}

export function mountPropertyPanel({ tour, request }) {
  const root = document.getElementById("property-evidence");
  if (!root) return;
  const state = panelStates.get(root) || { key: null, current: null, loading: false };
  panelStates.set(root, state);
  const tourStops = Array.isArray(tour?.stops) ? tour.stops : [];
  const properties = [...new Map(tourStops.filter(stop => ID.test(stop?.property_id || ""))
    .map(stop => [stop.property_id, stop])).values()];
  const prior = root.querySelector("#property-evidence-select")?.value;
  const priorDate = root.querySelector("#property-evidence-date")?.value;
  const selected = properties.find(stop => stop.property_id === prior) || properties[0];
  root.innerHTML = `<div class="property-panel-head"><div><p class="eyebrow">Site intelligence</p><h3>Property evidence</h3></div>
    <label for="property-evidence-select">Property <select id="property-evidence-select">${properties.map(stop =>
      `<option value="${escape(stop.property_id)}">${escape(stop.name || stop.address || stop.property_id)}</option>`).join("")}</select></label>
    <label for="property-evidence-date">As of <input id="property-evidence-date" type="date" value="${escape(priorDate ?? localDate(new Date()))}"></label></div>
    <div id="property-evidence-content" aria-live="polite">${properties.length ? "Loading evidence…" : "No property is selected."}</div>
    <dialog id="property-evidence-dialog" class="property-evidence-dialog"><button type="button" class="property-dialog-close" aria-label="Close">×</button><div class="property-dialog-content"></div></dialog>`;
  if (!selected) { state.key = null; state.current = null; state.loading = false; return; }
  const select = root.querySelector("#property-evidence-select");
  select.value = selected.property_id;
  function renderCurrent() {
    const content = root.querySelector("#property-evidence-content");
    if (state.current) content.innerHTML = renderPropertyPanel(state.current);
    else content.textContent = state.loading ? "Loading evidence…" : "Property evidence is unavailable. Try again.";
  }
  async function load() {
    const propertyId = select.value;
    const selectedDate = root.querySelector("#property-evidence-date").value;
    if (!selectedDate) {
      state.token = null;
      state.key = null;
      state.current = null;
      state.loading = false;
      root.querySelector("#property-evidence-content").textContent = "Choose an as-of date to view property evidence.";
      return;
    }
    const key = `${propertyId}:${selectedDate}`;
    if (state.key === key && (state.current || state.loading)) { renderCurrent(); return; }
    const token = {};
    state.token = token;
    state.key = key;
    state.current = null;
    state.loading = true;
    const now = new Date();
    const asOf = selectedDate === localDate(now)
      ? now.toISOString() : new Date(`${selectedDate}T23:59:59.999Z`).toISOString();
    renderCurrent();
    try {
      const data = await request(`/api/tours/property-evidence/v1?property_id=${encodeURIComponent(propertyId)}&as_of=${encodeURIComponent(asOf)}`);
      if (state.token !== token || state.key !== key) return;
      state.current = data;
      state.loading = false;
      renderCurrent();
    } catch {
      if (state.token === token && state.key === key) { state.current = null; state.loading = false; renderCurrent(); }
    }
  }
  select.addEventListener("change", () => void load());
  root.querySelector("#property-evidence-date").addEventListener("change", () => void load());
  root.onclick = event => {
    if (event.target.closest(".property-dialog-close")) { root.querySelector("dialog").close(); return; }
    const button = event.target.closest("[data-evidence-field]");
    if (!button || !state.current) return;
    const item = propertyPanelView(state.current).find(fact => fact.field === button.dataset.evidenceField);
    if (!item) return;
    const dialog = root.querySelector("dialog");
    dialog.querySelector(".property-dialog-content").innerHTML = `<p class="eyebrow">${escape(item.state_label)}</p><h3>${escape(item.label)}</h3><strong>${escape(item.value)}</strong>${propertyFactDetail(item)}`;
    dialog.showModal();
  };
  void load();
}
