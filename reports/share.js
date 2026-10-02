(() => {
  "use strict";

  const status = document.querySelector("#status");
  const summary = document.querySelector("#report-summary");
  const list = document.querySelector("#report-list");
  const openButton = document.querySelector("#open-tour");
  const feedbackStatus = document.querySelector("#feedback-status");
  let shareToken = typeof globalThis.__CARR_TOUR_TAKE_SHARE_TOKEN__ === "function"
    ? globalThis.__CARR_TOUR_TAKE_SHARE_TOKEN__() : "";
  let reportProperties = new globalThis.Map();
  let mapInstance = null;
  let feedback = null;
  const pending = new globalThis.Map();
  let contentStatus = "";
  const retryFeedbackButton = document.createElement("button");
  retryFeedbackButton.type = "button"; retryFeedbackButton.textContent = "Retry feedback";
  retryFeedbackButton.hidden = true;
  feedbackStatus.after(retryFeedbackButton);

  function setStatus(message) { status.textContent = message; }

  async function request(path, options = {}) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(path, { credentials: "same-origin", ...options, signal: controller.signal });
          let data = null;
          try { data = await response.json(); } catch { /* errors remain generic */ }
          if (!response.ok) throw new Error(data?.error || "request_failed");
          return data;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          reject(new Error("request_timeout")); controller.abort();
        }, 15000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function text(value, fallback) {
    return typeof value === "string" && value ? value : fallback;
  }

  function validPropertyRef(value) {
    return typeof value === "string" && /^property:public:[A-Za-z0-9_-]{16,128}$/.test(value);
  }

  function routeOrder(item, index) {
    return Number.isFinite(item?.route_sequence) ? item.route_sequence : index + 1;
  }

  function propertyAddress(item, fallback) {
    const parts = [item?.address, item?.suite].filter(value => typeof value === "string" && value.trim());
    return parts.length ? parts.join(" · ") : fallback;
  }

  function feedbackFor(propertyRef) {
    return feedback?.items?.find(item => item.property_ref === propertyRef) || null;
  }

  async function sendFeedback(kind, item, value) {
    const payload = { projection_ref: feedback.projection_ref, property_ref: item.property_ref,
      ...(kind === "shortlist" ? { shortlisted: value } : { comment: value }) };
    const slot = `${kind}:${item.property_ref}`;
    const serialized = JSON.stringify(payload);
    const prior = pending.get(slot);
    payload.idempotency_key = prior?.serialized === serialized ? prior.key : crypto.randomUUID();
    pending.set(slot, { serialized, key: payload.idempotency_key });
    feedbackStatus.textContent = kind === "shortlist" ? "Saving your shortlist…" : "Saving your comment…";
    try {
      await request(`/api/share/${kind}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      pending.delete(slot);
      let itemFeedback = feedbackFor(item.property_ref);
      if (!itemFeedback) {
        itemFeedback = { property_ref: item.property_ref, comments: [] };
        feedback.items ||= [];
        feedback.items.push(itemFeedback);
      }
      if (kind === "shortlist") itemFeedback.shortlisted = value;
      else { itemFeedback.comments ||= []; itemFeedback.comments.push({ comment: value }); }
      feedbackStatus.textContent = kind === "shortlist" ? "Shortlist saved." : "Comment saved.";
      return true;
    } catch {
      feedbackStatus.textContent = "Your change could not be saved. Try again or reopen this Tour.";
      return false;
    }
  }

  function renderFeedbackControls(row, item) {
    const scopes = Array.isArray(feedback?.permission_scopes) ? feedback.permission_scopes : [];
    if (!scopes.includes("shortlist") && !scopes.includes("comment")) return;
    const panel = document.createElement("div"); panel.className = "feedback-controls";
    const itemFeedback = feedbackFor(item.property_ref);
    if (scopes.includes("shortlist")) {
      const choice = document.createElement("p"); choice.className = "shortlist-state";
      choice.setAttribute("role", "status");
      choice.textContent = "Previous shortlist choices are not shown.";
      const actions = document.createElement("div"); actions.setAttribute("role", "group");
      actions.className = "actions";
      actions.setAttribute("aria-label", "Shortlist");
      const buttons = [true, false].map(selected => {
        const button = document.createElement("button"); button.type = "button";
        button.textContent = selected ? "Add to shortlist" : "Remove from shortlist";
        button.addEventListener("click", () => {
          for (const control of buttons) control.disabled = true;
          void sendFeedback("shortlist", item, selected).then(saved => {
            if (saved) choice.textContent = selected ? "Added to shortlist." : "Removed from shortlist.";
            for (const control of buttons) control.disabled = false;
          });
        });
        return button;
      });
      actions.append(...buttons); panel.append(choice, actions);
    }
    if (scopes.includes("comment")) {
      const label = document.createElement("label"); label.textContent = "Your comment";
      const input = document.createElement("textarea"); input.maxLength = 1000; input.rows = 3;
      const button = document.createElement("button"); button.type = "button"; button.textContent = "Save comment";
      button.addEventListener("click", () => {
        if (!input.value.trim()) { feedbackStatus.textContent = "Write a comment before saving."; return; }
        const draft = input.value;
        const comment = draft.trim();
        button.disabled = true;
        void sendFeedback("comment", item, comment).then(saved => {
          if (saved) {
            if (input.value === draft) input.value = "";
            appendComment(panel, comment);
          }
          button.disabled = false;
        });
      });
      label.append(input); panel.append(label, button);
    }
    if (itemFeedback?.comments?.length) {
      for (const entry of itemFeedback.comments) {
        appendComment(panel, entry.comment);
      }
    }
    row.append(panel);
  }

  function appendComment(panel, comment) {
    let comments = panel.querySelector(".comment-list");
    if (!comments) { comments = document.createElement("ul"); comments.className = "comment-list"; panel.append(comments); }
    const line = document.createElement("li"); line.textContent = comment; comments.append(line);
  }

  function render(report) {
    const items = Array.isArray(report?.stops) ? report.stops :
      (Array.isArray(report?.items) ? report.items : (Array.isArray(report?.properties) ? report.properties : []));
    const properties = items.map((item, index) => ({ item, index }))
      .filter(({ item }) => validPropertyRef(item?.property_ref))
      .sort((left, right) => routeOrder(left.item, left.index) - routeOrder(right.item, right.index));
    reportProperties = new globalThis.Map(properties.map(({ item }) => [item.property_ref, item]));
    document.querySelector("#report-title").textContent = "Tour report";
    summary.textContent = `${properties.length} ${properties.length === 1 ? "property" : "properties"} in this report.`;
    list.replaceChildren();
    for (const { item, index } of properties) {
      const row = document.createElement("li");
      row.className = "report-item";
      row.dataset.propertyRef = item.property_ref;
      const route = document.createElement("p");
      route.className = "route-label";
      route.textContent = text(item.route_label, `Stop ${routeOrder(item, index)}`);
      const heading = document.createElement("h3");
      heading.textContent = text(item.name, text(item.title, "Tour property"));
      const detail = document.createElement("p");
      detail.textContent = text(item.summary, text(item.status, propertyAddress(item, "Details available in the packet.")));
      row.append(route, heading, detail);
      renderFeedbackControls(row, item);
      list.append(row);
    }
    if (!properties.length) list.textContent = "No properties are available in this report.";
    list.setAttribute("aria-busy", "false");
  }

  function validMapPoint(point) {
    return validPropertyRef(point?.property_ref) && Number.isInteger(point?.route_sequence) && point.route_sequence > 0 &&
      Number.isFinite(point?.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
      Number.isFinite(point?.longitude) && point.longitude >= -180 && point.longitude <= 180;
  }

  async function renderMap(payload) {
    const points = (Array.isArray(payload?.points) ? payload.points : []).filter(validMapPoint)
      .sort((left, right) => left.route_sequence - right.route_sequence);
    if (!points.length) return;
    const { LngLatBounds, Map: MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl } =
      await import("/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs");
    setWorkerUrl("/vendor/maplibre-gl-6.4.1/maplibre-gl-worker.mjs");
    const mapSection = document.querySelector("#map-section");
    mapSection.hidden = false;
    if (mapInstance) mapInstance.remove();
    mapInstance = new MapLibreMap({
      container: "tour-map",
      style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#eef4f8" } }] },
      center: [points[0].longitude, points[0].latitude], zoom: 11, attributionControl: false,
    });
    mapInstance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    const bounds = new LngLatBounds();
    for (const point of points) {
      const coordinate = [point.longitude, point.latitude];
      bounds.extend(coordinate);
      const property = reportProperties.get(point.property_ref) || {};
      const marker = document.createElement("button");
      marker.type = "button";
      marker.textContent = typeof point.route_label === "string" ? point.route_label : String(point.route_sequence);
      marker.setAttribute("aria-label", `Stop ${point.route_sequence}: ${text(property.name, "Tour property")}`);
      const popupBody = document.createElement("div");
      const popupTitle = document.createElement("strong");
      popupTitle.textContent = text(property.name, `Stop ${point.route_sequence}`);
      const popupAddress = document.createElement("div");
      popupAddress.textContent = propertyAddress(property, "Verified access point");
      popupBody.append(popupTitle, popupAddress);
      new Marker({ element: marker }).setLngLat([point.longitude, point.latitude])
        .setPopup(new Popup({ offset: 18 }).setDOMContent(popupBody)).addTo(mapInstance);
    }
    mapInstance.on("load", () => {
      if (points.length > 1) mapInstance.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 0 });
    });
  }

  async function fetchReport() {
    const payload = await request("/api/share/report");
    return payload.data || {};
  }

  async function fetchMap() {
    const payload = await request("/api/share/map");
    return payload.data || {};
  }

  async function fetchFeedback() {
    const payload = await request("/api/share/feedback");
    if (!payload?.data || !Array.isArray(payload.data.permission_scopes)) throw new Error("feedback_unavailable");
    return payload.data;
  }

  function showFeedbackUnavailable() {
    feedbackStatus.textContent = "Feedback is unavailable. Retry to load shortlist and comment controls.";
    retryFeedbackButton.hidden = false;
    setStatus(`${contentStatus} Feedback unavailable.`);
  }

  async function retryFeedback() {
    retryFeedbackButton.disabled = true;
    feedbackStatus.textContent = "Loading feedback…";
    try {
      feedback = await fetchFeedback();
      for (const row of list.querySelectorAll(".report-item")) {
        const item = reportProperties.get(row.dataset.propertyRef);
        if (item && !row.querySelector(".feedback-controls")) renderFeedbackControls(row, item);
      }
      feedbackStatus.textContent = "";
      retryFeedbackButton.hidden = true;
      setStatus(contentStatus);
    } catch {
      showFeedbackUnavailable();
    } finally {
      retryFeedbackButton.disabled = false;
    }
  }

  async function loadTour() {
    try {
      // Packet and map are independently scoped. Fetch both, then render in a
      // stable order so a valid map-only or packet-only grant still opens.
      const [reportResult, mapResult, feedbackResult] = await Promise.allSettled([fetchReport(), fetchMap(), fetchFeedback()]);
      const reportLoaded = reportResult.status === "fulfilled";
      const mapLoaded = mapResult.status === "fulfilled";
      feedback = feedbackResult.status === "fulfilled" ? feedbackResult.value : null;
      if (!reportLoaded && !mapLoaded) throw new Error("share_scope_unavailable");
      if (reportLoaded) render(reportResult.value);
      else {
        document.querySelector("#report-title").textContent = "Shared tour map";
        summary.textContent = "Verified access points included in this share.";
        list.textContent = "This link includes the interactive map only.";
        list.setAttribute("aria-busy", "false");
      }
      if (mapLoaded) await renderMap(mapResult.value);
      else document.querySelector("#map-section").hidden = true;
      contentStatus = reportLoaded && mapLoaded ? "Report and map loaded." : reportLoaded ? "Report loaded." : "Map loaded.";
      if (feedbackResult.status === "rejected") showFeedbackUnavailable();
      else setStatus(contentStatus);
    } catch {
      setStatus("This shared report is unavailable.");
      summary.textContent = "Access may have expired or been removed. Please ask your broker for an updated Tour.";
      list.setAttribute("aria-busy", "false");
    }
  }

  async function openTour() {
    const token = shareToken;
    shareToken = "";
    openButton.disabled = true;
    if (!token) return;
    try {
      await request("/api/share/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      await loadTour();
    } catch {
      setStatus("This shared report is unavailable.");
      list.setAttribute("aria-busy", "false");
    }
  }

  function bootstrap() {
    if (!shareToken) {
      openButton.hidden = true;
      setStatus("Opening your shared report…");
      void loadTour();
      return;
    }
    openButton.disabled = false;
    setStatus("Select Open tour to view this shared report.");
  }

  openButton.addEventListener("click", () => { void openTour(); });
  retryFeedbackButton.addEventListener("click", () => { void retryFeedback(); });
  bootstrap();
})();
