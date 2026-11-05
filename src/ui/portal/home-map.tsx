import { useEffect, useRef, useState } from 'react';
import { portalAsset } from './package';
import type { CarrMarketStudyV1 } from './package';
import { layoutMarkers } from './marker-layout';

type MapHandle = {
  on: (event: string, listener: () => void) => void;
  remove: () => void;
  addControl: (control: object) => void;
  fitBounds: (bounds: [number, number][], options: { padding: number; maxZoom: number }) => void;
  project: (position: [number, number]) => { x: number; y: number };
};
type MarkerHandle = { setLngLat: (position: [number, number]) => MarkerHandle; addTo: (map: MapHandle) => MarkerHandle; setOffset: (offset: [number, number]) => void };
type MapLibrary = {
  Map: new (options: object) => MapHandle;
  Marker: new (options: { element: HTMLElement; anchor: 'center' }) => MarkerHandle;
  NavigationControl: new (options: { showCompass: boolean }) => object;
  setWorkerUrl: (url: string) => void;
};
export type ContextMarker = { id: string; label: string; preview: string; lon: number; lat: number; open: () => void };
export function HomeMap({ publication, markers }: { publication: CarrMarketStudyV1; markers: ContextMarker[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let retired = false;
    let map: MapHandle | undefined;
    const fail = () => { if (!retired) { map?.remove(); map = undefined; setFailed(true); } };
    const start = async () => {
      const basemap = publication.map.basemap;
      if (basemap.kind !== 'local-layers' || !('water' in basemap) || !('roads' in basemap)) { fail(); return; }
      const water = basemap.water;
      const roads = basemap.roads;
      const path = '/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs';
      const library: MapLibrary = await import(path);
      if (retired || !container.current) return;
      library.setWorkerUrl('/tours/vendor/maplibre-gl-6.4.1/maplibre-gl-worker.mjs');
      const assetUrl = (asset: typeof water) => new URL(portalAsset(asset) ?? '', window.location.href).href;
      const tokens = getComputedStyle(container.current);
      map = new library.Map({ container: container.current, center: publication.map.center, zoom: publication.map.zoom,
        scrollZoom: false, attributionControl: false,
        style: { version: 8, sources: { water: { type: 'geojson', data: assetUrl(water) }, roads: { type: 'geojson', data: assetUrl(roads) } },
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': tokens.getPropertyValue('--surface-1').trim() } },
            { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': tokens.getPropertyValue('--surface-3').trim() } },
            { id: 'roads', type: 'line', source: 'roads', paint: { 'line-color': tokens.getPropertyValue('--hairline-strong').trim(), 'line-width': 1.4 } }] } });
      map.on('error', fail);
      map.addControl(new library.NavigationControl({ showCompass: false }));
      const stems = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      stems.classList.add('portal-stems'); stems.setAttribute('aria-hidden', 'true');
      container.current.append(stems);
      const handles: { marker: ContextMarker; button: HTMLButtonElement; handle: MarkerHandle; stem: Element }[] = [];
      for (const marker of markers) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'portal-marker'; button.textContent = marker.label;
        button.setAttribute('aria-label', marker.label);
        const preview = document.createElement('span'); preview.className = 'portal-marker-preview'; preview.textContent = marker.preview;
        button.append(preview); button.addEventListener('click', marker.open);
        const handle = new library.Marker({ element: button, anchor: 'center' }).setLngLat([marker.lon, marker.lat]).addTo(map);
        const stem = document.createElementNS(stems.namespaceURI, 'line');
        stem.classList.add('pin-stem'); stems.append(stem);
        handles.push({ marker, button, handle, stem });
      }
      const layout = () => {
        if (retired || !map || !container.current) return;
        const currentMap = map;
        const boxes = handles.map(({ marker, button }) => ({ ...currentMap.project([marker.lon, marker.lat]), width: button.offsetWidth, height: button.offsetHeight }));
        const positions = layoutMarkers(boxes, { width: container.current.clientWidth, height: container.current.clientHeight });
        positions.forEach((point, index) => {
          const item = handles[index];
          if (!item) return;
          item.handle.setOffset([point.x - point.anchor.x, point.y - point.anchor.y]);
          for (const [key, value] of Object.entries({ x1: point.anchor.x, y1: point.anchor.y, x2: point.x, y2: point.y })) item.stem.setAttribute(key, String(value));
        });
      };
      map.on('move', layout); map.on('resize', layout); map.on('load', layout);
      const points: [number, number][] = [...(publication.map.home_extent_points ?? []), ...markers.map((marker): [number, number] => [marker.lon, marker.lat])];
      if (points.length > 1) {
        map.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))],
          [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], { padding: 60, maxZoom: 11 });
      }
      layout();
    };
    void start().catch(fail);
    return () => { retired = true; map?.remove(); };
  }, [publication, markers]);
  return <figure className="portal-map"><div ref={container} aria-label="Market development map" />
    {failed && <p role="status">Map unavailable. Explore the development and regional context cards below.</p>}
    <figcaption>{publication.market.mini_map_caption} · Approximate study locators.
      {publication.map.basemap.kind === 'local-layers' && ` ${publication.map.basemap.attribution}`}</figcaption></figure>;
}
