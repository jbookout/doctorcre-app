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
export async function mountTerritoryMap(root, selectMarket, selectLead) {
  const [gl, geometry, places] = await Promise.all([
    import("../tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs"),
    fetch("/data/leads-territory.geojson").then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
    fetch("/data/leads-market-locations.json").then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
  ]);
  // The map paints from the page's colour tokens so it follows the theme; with no
  // stylesheet it paints nothing rather than inventing a colour.
  const style = root.ownerDocument.defaultView?.getComputedStyle(root.ownerDocument.documentElement);
  const token = (name) => style?.getPropertyValue(name).trim() || "transparent";
  const map = new gl.Map({ container: root, attributionControl: false, interactive: false,
    center: [-86.5, 31.9], zoom: 5.5, style: { version: 8, sources: { territory: { type: "geojson", data: geometry } },
      layers: [{ id: "ground", type: "background", paint: { "background-color": token("--surface-2") } },
        { id: "land", type: "fill", source: "territory", paint: { "fill-color": token("--surface-3"), "fill-opacity": .9 } },
        { id: "borders", type: "line", source: "territory", paint: { "line-color": token("--hairline-strong"), "line-opacity": .9, "line-width": 1 } }] } });
  const markers = new Map();
  let latest = [], selected = "";
  map.fitBounds([[-89.2, 29.9], [-83.2, 34.95]], { padding: 24, duration: 0 });
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
  await new Promise(resolve => map.once("idle", resolve));
  return { locate(lead) { return marketLocation(lead, places); },
    update(groups, leadId) { latest=groups;selected=leadId;draw(); },
    dispose() {map.off("moveend",draw);for(const item of markers.values())item.marker.remove();map.remove();} };
}
