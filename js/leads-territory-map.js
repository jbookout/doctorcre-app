// One persistent MapLibre Search Mode component; counts come from the same
// eligible lead projection as the board. Census points represent places only.
export function marketFeatures(groups, places) {
  return { type: "FeatureCollection", features: groups.flatMap(group => {
    const place = places.find(item => item.name.toLowerCase() === String(group.city || "").toLowerCase() && item.state === group.state);
    return place ? [{ type: "Feature", id: place.id, properties: { key: group.key, count: group.count },
      geometry: { type: "Point", coordinates: place.position } }] : [];
  }) };
}
export async function mountTerritoryMap(root, selectMarket) {
  const [gl, geometry, places] = await Promise.all([
    import("../reports/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs"),
    fetch("/data/leads-territory.geojson").then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
    fetch("/data/leads-market-locations.json").then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
  ]);
  const map = new gl.Map({ container: root, attributionControl: false, interactive: false,
    center: [-86.5, 31.9], zoom: 5.5, style: { version: 8, sources: { territory: { type: "geojson", data: geometry } },
      layers: [{ id: "ground", type: "background", paint: { "background-color": "#070f1b" } },
        { id: "land", type: "fill", source: "territory", paint: { "fill-color": "#19365a", "fill-opacity": .65 } },
        { id: "borders", type: "line", source: "territory", paint: { "line-color": "#637f9e", "line-opacity": .5, "line-width": 1 } }] } });
  const markers = new Map();
  let latest = [], selected = "";
  map.fitBounds([[-89.2, 29.9], [-83.2, 34.95]], { padding: 24, duration: 0 });
  function draw() {
    const clusters = [];
    for (const feature of marketFeatures(latest, places).features.sort((a,b) => b.properties.count-a.properties.count)) {
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
          if(item.features.length===1) {selectMarket(item.features[0].properties.key);return;}
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
      item.button.setAttribute("aria-pressed",String(cluster.features.some(f=>f.properties.key===selected)));
    }
  }
  map.on("moveend",draw);
  return { update(groups, market) { latest=groups;selected=market;draw(); },
    dispose() {map.off("moveend",draw);for(const item of markers.values())item.marker.remove();map.remove();} };
}
