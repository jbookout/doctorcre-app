import { mountMarketMap } from "./market-map-shell.js";
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
export async function mountTerritoryMap(root, selectMarket, selectLead, { signal, markets = [], areas = [], padding = 24, loadMapLibre, fetchImpl = fetch } = {}) {
  const [geometry, places] = await Promise.all([
    fetchImpl("/data/leads-territory.geojson", { signal }).then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
    fetchImpl("/data/leads-market-locations.json", { signal }).then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
  ]);
  // The map paints from the page's colour tokens so it follows the theme; with no
  // stylesheet it paints nothing rather than inventing a colour.
  const doc = root.ownerDocument, view = doc.defaultView;
  const token = (name) => view?.getComputedStyle(doc.documentElement).getPropertyValue(name).trim() || "transparent";
  const paint = [["ground", "background-color", "--map-water"], ["land", "fill-color", "--map-land"], ["borders", "line-color", "--hairline-strong"]];
  const shell = mountMarketMap(root, { interactive: false, signal, loadMapLibre,
    center: [-86.5, 31.9], zoom: 5.5, style: { version: 8, sources: { territory: { type: "geojson", data: geometry } },
      layers: [{ id: "ground", type: "background", paint: { "background-color": token("--map-water") } },
        { id: "land", type: "fill", source: "territory", paint: { "fill-color": token("--map-land") } },
        { id: "borders", type: "line", source: "territory", paint: { "line-color": token("--hairline-strong"), "line-opacity": .9, "line-width": 1 } }] } });
  const mounted = await shell.ready;
  if (!mounted) return null;
  const { map, gl } = mounted;
  const markers = new Map();
  let latest = [], selected = "";
  const locations = markets.map(market => marketLocation(market, places));
  const areaPlaces = areas.map(area => marketLocation(area, places));
  if ([...locations, ...areaPlaces].some(place => !place)) { shell.destroy(); throw new Error("Market location unavailable"); }
  const bounds = locations.length ? locations.reduce((bounds, place) => bounds.extend(place.position), new gl.LngLatBounds()) : [[-89.2, 29.9], [-83.2, 34.95]];
  map.fitBounds(bounds, { padding, duration: 0 });
  // The paint reads theme tokens once; a theme switch repaints in place.
  const themes = view && new view.MutationObserver(() => { for (const [layer, property, name] of paint) map.setPaintProperty(layer, property, token(name)); });
  themes?.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-assist"] });
  const areaMarkers = areas.map((area, index) => {
    const button = doc.createElement("button"), label = doc.createElement("span");
    button.type = "button"; button.className = "area-marker"; button.dataset.market = area.key; button.dataset.placement = area.placement || "top";
    button.setAttribute("aria-pressed", "false"); button.setAttribute("aria-label", `Choose ${area.label} on the map`);
    label.textContent = area.label; button.append(label);
    button.addEventListener("click", () => selectMarket(area.key));
    return { button, marker: new gl.Marker({ element: button }).setLngLat(areaPlaces[index].position).addTo(map) };
  });
  function draw() {
    const clusters = [];
    for (const feature of marketFeatures(latest).features.sort((a,b) => b.properties.count-a.properties.count)) {
      const position = map.project(feature.geometry.coordinates);
      const cluster = clusters.find(c => Math.hypot(c.position.x-position.x,c.position.y-position.y)<34);
      if (cluster) cluster.features.push(feature);
      else clusters.push({ position, features: [feature] });
    }
    const keys = new Set(clusters.map(c => c.features.map(f=>f.id).sort().join("/")));
    for (const [key,item] of markers) if (!keys.has(key)) { item.marker.remove(); markers.delete(key); }
    for (const cluster of clusters) {
      const key=cluster.features.map(f=>f.id).sort().join("/");
      let item=markers.get(key);
      if (!item) {
        const button=root.ownerDocument.createElement("button");button.type="button";button.className="market-marker";
        item={button,features:cluster.features,marker:new gl.Marker({element:button}).setLngLat(cluster.features[0].geometry.coordinates).addTo(map)};
        button.addEventListener("click",()=>{
          if(item.features.length===1) {
            const { key, leadIds } = item.features[0].properties;
            selectMarket(key);
            if (leadIds.length === 1) selectLead(leadIds[0]);
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
      item.button.setAttribute("aria-label",cluster.features.length>1?`Zoom to markets · ${title}`:`${title} leads`);
      const leadIds = cluster.features.flatMap(f => f.properties.leadIds);
      item.button.dataset.leadIds = JSON.stringify(leadIds);
      item.button.setAttribute("aria-pressed",String(leadIds.includes(selected)));
    }
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
  } catch (error) { map.off("moveend", draw); themes?.disconnect(); for (const { marker } of areaMarkers) marker.remove(); shell.destroy(); throw error; }
  return { resize() { map.resize(); }, locate(lead) { return marketLocation(lead, places); },
    update(groups, leadId) { latest=groups;selected=leadId;draw(); },
    select(key) { for (const { button } of areaMarkers) button.setAttribute("aria-pressed", String(button.dataset.market === key)); },
    dispose() {map.off("moveend",draw);themes?.disconnect();for(const item of [...markers.values(), ...areaMarkers])item.marker.remove();shell.destroy();} };
}
