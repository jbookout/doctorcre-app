import { useEffect, useRef, useState } from 'react';
import type { Property, PurchasePackage } from './purchases-package';
type MapHandle = { on: (event: string, listener: () => void) => void; remove: () => void; fitBounds: (bounds: [number, number][], options: { padding: number; maxZoom: number }) => void };
type MarkerHandle = { setLngLat: (position: [number, number]) => MarkerHandle; addTo: (map: MapHandle) => MarkerHandle; remove: () => void };
type MapLibrary = { Map: new (options: object) => MapHandle; Marker: new (options: { element: HTMLElement; anchor: 'center' }) => MarkerHandle; setWorkerUrl: (url: string) => void };
export function PurchaseMap({ publication, properties, selected, active, select }: {
  publication: PurchasePackage; properties: readonly Property[]; selected: string | null; active: string | null; select: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const choose = useRef(select);
  choose.current = select;
  const [phase, setPhase] = useState<'starting' | 'ready' | 'unavailable'>('starting');
  useEffect(() => {
    let retired = false;
    let failed = false;
    let map: MapHandle | undefined;
    const markers: MarkerHandle[] = [];
    const fail = () => {
      if (retired || failed) return;
      failed = true;
      markers.forEach(marker => marker.remove());
      buttons.current.clear();
      map?.remove(); map = undefined;
      setPhase('unavailable');
    };
    const start = async () => {
      const basemap = publication.map.basemap;
      if (basemap.kind !== 'local-layers') { fail(); return; }
      const assets = [basemap.water, basemap.roads];
      if (assets.some(asset => !/^[a-f0-9]{64}$/.test(asset.sha256))) { fail(); return; }
      const path = '/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs';
      const library: MapLibrary = await import(path);
      if (retired || !container.current) return;
      library.setWorkerUrl('/tours/vendor/maplibre-gl-6.4.1/maplibre-gl-worker.mjs');
      const url = (hash: string) => new URL(`files/${hash}`, window.location.href).href;
      const tokens = getComputedStyle(container.current);
      map = new library.Map({ container: container.current, center: publication.map.center, zoom: publication.map.zoom,
        scrollZoom: false, attributionControl: false,
        style: { version: 8, sources: { water: { type: 'geojson', data: url(basemap.water.sha256) }, roads: { type: 'geojson', data: url(basemap.roads.sha256) } },
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': tokens.getPropertyValue('--surface-1').trim() || '#eef1ef' } },
            { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': '#a7c4ca' } },
            { id: 'roads', type: 'line', source: 'roads', paint: { 'line-color': '#7b8b90', 'line-width': 1.3 } }] } });
      map.on('error', fail);
      map.on('load', () => { if (!retired && !failed) setPhase('ready'); });
      const points: [number, number][] = [];
      for (const property of publication.properties) {
        const locator = property.locator;
        if (!locator || !Number.isFinite(locator.lon) || !Number.isFinite(locator.lat) || Math.abs(locator.lon) > 180 || Math.abs(locator.lat) > 90) continue;
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'purchase-pin locator-pin'; button.textContent = String(property.number);
        button.dataset.propertyId = property.id;
        button.setAttribute('aria-label', `Open ${property.number}. ${property.address}`);
        button.setAttribute('aria-pressed', 'false');
        const preview = document.createElement('span'); preview.className = 'purchase-preview';
        preview.textContent = `${property.address} · ${property.status}${property.role === 'market-context' ? ' · Market context, excluded' : ''}`;
        button.append(preview); button.addEventListener('click', () => choose.current(property.id));
        buttons.current.set(property.id, button);
        points.push([locator.lon, locator.lat]);
        markers.push(new library.Marker({ element: button, anchor: 'center' }).setLngLat([locator.lon, locator.lat]).addTo(map));
      }
      if (points.length > 1) map.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], { padding: 50, maxZoom: 12 });
      refresh.current();
    };
    void start().catch(fail);
    return () => { retired = true; markers.forEach(marker => marker.remove()); buttons.current.clear(); map?.remove(); };
  }, [publication]);
  const refresh = useRef(() => {});
  refresh.current = () => {
    const visible = new Set(properties.map(property => property.id));
    for (const [id, button] of buttons.current) {
      button.hidden = !visible.has(id);
      button.setAttribute('aria-pressed', String(id === selected));
      button.dataset.active = String(id === active);
    }
  };
  useEffect(() => refresh.current(), [properties, selected, active, phase]);
  return <figure className="purchase-map"><div id="purchase-map" ref={container} className="purchase-map-canvas" aria-label="Purchase property map" hidden={phase === 'unavailable'} />
    {phase === 'unavailable' && <p role="status">Map unavailable. Use the property directory below.</p>}
    <figcaption>Approximate study locators. Use these pins to review properties, not for navigation. {publication.map.basemap.kind === 'local-layers' && publication.map.basemap.attribution}</figcaption></figure>;
}
