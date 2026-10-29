import { mountMarketMap } from "./market-map-shell.js";

const operatingTerritory = [{ city: "Mobile", state: "AL" }, { city: "Tallahassee", state: "FL" }, { city: "Dothan", state: "AL" }];
// One persistent MapLibre Search Mode component; counts come from the same
// eligible lead projection as the board. Census points represent places only.
export function marketLocation(lead, places) {
  const matches = places.filter(item => item.name.toLowerCase() === String(lead.city || "").toLowerCase() && item.state === lead.state);
  const place = matches.length === 1 ? matches[0] : null;
  const position = place?.position;
  return Array.isArray(position) && position.length === 2 && position.every(Number.isFinite) &&
    Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90 && position.some(value => value !== 0) ? place : null;
}
export function marketFeatures(groups) {
  return { type: "FeatureCollection", features: groups.flatMap(group => group.locations.map(({ place, leadIds }) =>
    ({ type: "Feature", id: place.id, properties: { key: group.key, count: leadIds.length, leadIds },
      geometry: { type: "Point", coordinates: place.position } }))) };
}
// `areas` adds labelled, selectable market-area points (Census place points, never
// a property); clicking one reports its key through selectMarket.
export async function mountTerritoryMap(root, selectMarket, selectLead, { signal, markets = operatingTerritory, areas = [], padding = 24, describeLead = id => id, loadMapLibre, fetchImpl = fetch } = {}) {
  const [geometry, places] = await Promise.all([
    fetchImpl("/data/leads-territory.geojson", { signal }).then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
    fetchImpl("/data/leads-market-locations.json", { signal }).then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
  ]);
  // The map paints from the page's colour tokens so it follows the theme; with no
  // stylesheet it paints nothing rather than inventing a colour.
  const doc = root.ownerDocument, view = doc.defaultView;
  const token = (name) => view?.getComputedStyle(root).getPropertyValue(name).trim() || (name === "--map-border" ? token("--hairline-strong") : "transparent");
  // Only the background is water. Territory states are land; neighbouring states
  // are muted context land, so nothing outside the Gulf and Atlantic reads as sea.
  const paint = [["ground", "background-color", "--map-water"], ["context", "fill-color", "--map-context"], ["land", "fill-color", "--map-land"], ["borders", "line-color", "--map-border"]];
  const shell = mountMarketMap(root, { interactive: false, signal, loadMapLibre,
    center: [-86.5, 31.9], zoom: 5.5, style: { version: 8, sources: { territory: { type: "geojson", data: geometry } },
      layers: [{ id: "ground", type: "background", paint: { "background-color": token("--map-water") } },
        { id: "context", type: "fill", source: "territory", filter: ["==", ["get", "role"], "context"], paint: { "fill-color": token("--map-context") } },
        { id: "land", type: "fill", source: "territory", filter: ["==", ["get", "role"], "territory"], paint: { "fill-color": token("--map-land") } },
        { id: "borders", type: "line", source: "territory", paint: { "line-color": token("--map-border"), "line-opacity": .9, "line-width": 1 } }] } });
  const mounted = await shell.ready;
  if (!mounted) return null;
  const { map, gl } = mounted;
  const markers = new Map();
  let latest = [], selected = "";
  let picker = null;
  const locations = markets.map(market => marketLocation(market, places));
  const areaPlaces = areas.map(area => marketLocation(area, places));
  if ([...locations, ...areaPlaces].some(place => !place)) { shell.destroy(); throw new Error("Market location unavailable"); }
  const bounds = locations.length ? locations.reduce((bounds, place) => bounds.extend(place.position), new gl.LngLatBounds()) : null;
  if (bounds) map.fitBounds(bounds, { padding, duration: 0 });
  // The paint reads theme tokens once; a theme switch repaints in place.
  const themes = view && new view.MutationObserver(() => { for (const [layer, property, name] of paint) map.setPaintProperty(layer, property, token(name)); });
  themes?.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-assist"] });
  const areaMarkers = areas.map((area, index) => {
    const button = doc.createElement("button"), label = doc.createElement("span");
    button.type = "button"; button.className = "area-marker"; button.dataset.market = area.key;
    button.setAttribute("aria-pressed", "false"); button.setAttribute("aria-label", `Choose ${area.label} on the map`);
    label.textContent = area.label; button.append(label);
    button.addEventListener("click", () => selectMarket(area.key));
    return { button, label, marker: new gl.Marker({ element: button }).setLngLat(areaPlaces[index].position).addTo(map) };
  });
  // Labels go beside their own dot. Every combination of sides is scored (a few
  // markets, eight sides each, pruned) and the one that keeps every label inside the map,
  // clear of other labels and away from other dots, wins; ties prefer the earlier side.
  const SIDES = ["right", "left", "top", "bottom", "top-right", "bottom-right", "top-left", "bottom-left"];
  function placeLabels() {
    const frame = root.getBoundingClientRect(), gap = 2;
    const dots = areaMarkers.map(({ button }) => button.getBoundingClientRect());
    const rects = areaMarkers.map(({ button, label }) => SIDES.map(side => { button.dataset.placement = side; return label.getBoundingClientRect(); }));
    const inside = r => r.left >= frame.left + gap && r.right <= frame.right - gap && r.top >= frame.top + gap && r.bottom <= frame.bottom - gap;
    const hits = (a, b, room = gap) => a.left < b.right + room && b.left < a.right + room && a.top < b.bottom + room && b.top < a.bottom + room;
    // A label that brushes another market's dot reads as that market's name.
    const near = (a, b) => hits(a, b, 14);
    const own = rects.map((sides, index) => sides.map((rect, side) => (inside(rect) ? 0 : 100) + side / 10
      + dots.filter((dot, other) => other !== index && hits(rect, dot)).length * 10
      + dots.filter((dot, other) => other !== index && near(rect, dot)).length * 3));
    let best = { cost: Infinity, choice: [] };
    (function search(index, choice, cost) {
      if (cost >= best.cost) return;
      if (index === rects.length) { best = { cost, choice: [...choice] }; return; }
      for (let side = 0; side < SIDES.length; side++) {
        const rect = rects[index][side];
        const clash = choice.filter((other, previous) => hits(rect, rects[previous][other])).length * 10;
        choice.push(side); search(index + 1, choice, cost + own[index][side] + clash); choice.pop();
      }
    })(0, [], 0);
    areaMarkers.forEach(({ button }, index) => { button.dataset.placement = SIDES[best.choice[index]]; });
  }
  if (areaMarkers.length) { placeLabels(); map.on("resize", placeLabels); }
  function closePicker(restore = true) {
    if (!picker) return;
    const trigger = picker.trigger;
    picker.element.remove(); picker = null;
    if (restore) (trigger.isConnected ? trigger : root.querySelector(".market-marker"))?.focus({ preventScroll: true });
  }
  function updatePicker() {
    if (!picker) return;
    const members = [...new Set(marketFeatures(latest).features.filter(feature => picker.places.has(feature.id)).flatMap(feature => feature.properties.leadIds))];
    if (!members.length) { closePicker(picker.element.contains(doc.activeElement)); return; }
    for (const [id, button] of picker.buttons) if (!members.includes(id)) { button.remove(); picker.buttons.delete(id); }
    members.forEach((id, index) => {
      let button = picker.buttons.get(id);
      if (!button) {
        button = doc.createElement("button"); button.type = "button"; button.dataset.mapLead = id;
        button.addEventListener("click", () => selectLead(id));
        picker.buttons.set(id, button);
      }
      button.textContent = describeLead(id);
      button.setAttribute("aria-pressed", String(id === selected));
      if (picker.list.children[index] !== button) picker.list.insertBefore(button, picker.list.children[index] || null);
    });
  }
  function openPicker(item) {
    closePicker(false);
    const element = doc.createElement("section"), heading = doc.createElement("div"), title = doc.createElement("strong"), precision = doc.createElement("small"), close = doc.createElement("button"), list = doc.createElement("div");
    element.className = "map-place-members"; element.setAttribute("role", "region"); element.setAttribute("aria-label", "Leads in this place");
    heading.className = "map-place-heading"; title.textContent = "Leads in this place";
    const names = places.filter(place => item.features.some(feature => feature.id === place.id)).map(place => `${place.name}, ${place.state}`);
    precision.textContent = `Market area only · ${names.join(" · ")}`;
    close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close place leads");
    close.addEventListener("click", () => closePicker());
    element.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePicker(); } });
    heading.append(title, close); element.append(heading, precision, list); root.append(element);
    picker = { element, list, buttons: new Map(), places: new Set(item.features.map(feature => feature.id)), trigger: item.button };
    updatePicker();
    picker?.list.querySelector("button")?.focus({ preventScroll: true });
  }
  function draw() {
    const clusters = [];
    for (const feature of marketFeatures(latest).features.sort((a,b) => b.properties.count-a.properties.count)) {
      const position = map.project(feature.geometry.coordinates);
      const cluster = clusters.find(c => Math.abs(c.position.x-position.x)<48 && Math.abs(c.position.y-position.y)<48);
      if (cluster) cluster.features.push(feature);
      else clusters.push({ position, features: [feature] });
    }
    const keys = new Set(clusters.map(c => c.features.map(f=>f.id).sort().join("/")));
    for (const [key,item] of markers) if (!keys.has(key)) { item.marker.remove(); markers.delete(key); }
    for (const cluster of clusters) {
      const key=cluster.features.map(f=>f.id).sort().join("/");
      let item=markers.get(key);
      if (!item) {
        const button=root.ownerDocument.createElement("button");button.type="button";button.className="market-marker";button.dataset.mapMarker=key;
        item={button,features:cluster.features,marker:new gl.Marker({element:button}).setLngLat(cluster.features[0].geometry.coordinates).addTo(map)};
        button.addEventListener("click",()=>{
          if(new Set(item.features.map(feature => feature.id)).size===1 || map.getZoom() >= 11) {
            const leadIds = [...new Set(item.features.flatMap(feature => feature.properties.leadIds))];
            if (leadIds.length === 1) selectLead(leadIds[0]);
            else openPicker(item);
            return;
          }
          const bounds=new gl.LngLatBounds();item.features.forEach(f=>bounds.extend(f.geometry.coordinates));
          map.fitBounds(bounds,{padding:65,maxZoom:11,duration:root.ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches?0:200});
        });
        markers.set(key,item);
      }
      item.features=cluster.features;
      const count=cluster.features.reduce((n,f)=>n+f.properties.count,0);
      const title=cluster.features.map(f=>`${f.properties.key}: ${f.properties.count}`).join(" · ");
      item.button.textContent=count;item.button.title=title;
      item.button.setAttribute("aria-label",new Set(cluster.features.map(feature => feature.id)).size>1 && map.getZoom()<11?`Zoom to markets · ${title}`:`${title} leads`);
      const leadIds = cluster.features.flatMap(f => f.properties.leadIds);
      item.button.dataset.leadIds = JSON.stringify(leadIds);
      item.button.setAttribute("aria-pressed",String(leadIds.includes(selected)));
    }
    updatePicker();
  }
  map.on("moveend",draw);
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { map.off("idle", ready); map.off("error", failed); signal?.removeEventListener("abort", aborted); };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Map unavailable")); };
      const aborted = () => { cleanup(); reject(new DOMException("Map cancelled", "AbortError")); };
      map.on("idle", ready); map.on("error", failed); signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  } catch (error) { map.off("moveend", draw); map.off("resize", placeLabels); themes?.disconnect(); for (const { marker } of areaMarkers) marker.remove(); shell.destroy(); throw error; }
  return { resize() { map.resize(); }, locate(lead) { return marketLocation(lead, places); },
    update(groups, leadId) { latest=groups;selected=leadId;draw(); },
    select(key) { for (const { button } of areaMarkers) button.setAttribute("aria-pressed", String(button.dataset.market === key)); placeLabels(); },
    dispose() {closePicker(false);map.off("moveend",draw);map.off("resize",placeLabels);themes?.disconnect();for(const item of [...markers.values(), ...areaMarkers])item.marker.remove();shell.destroy();} };
}
