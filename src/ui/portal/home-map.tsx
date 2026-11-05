import { useEffect, useRef, useState } from 'react';
import { portalAsset } from './package';
import type { CarrMarketStudyV1 } from './package';

type MapHandle = {
  on: (event: string, listener: () => void) => void;
  remove: () => void;
  addControl: (control: object) => void;
  fitBounds: (bounds: [number, number][], options: { padding: number; maxZoom: number }) => void;
};
type MapLibrary = {
  Map: new (options: object) => MapHandle;
  Marker: new (options: { element: HTMLElement; offset: [number, number] }) => { setLngLat: (position: [number, number]) => { addTo: (map: MapHandle) => void } };
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
      const groups = new Map<string, number>();
      for (const marker of markers) {
        const key = `${marker.lon.toFixed(2)},${marker.lat.toFixed(2)}`;
        const count = groups.get(key) ?? 0; groups.set(key, count + 1);
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'portal-marker'; button.textContent = marker.label;
        button.setAttribute('aria-label', marker.label);
        const preview = document.createElement('span'); preview.className = 'portal-marker-preview'; preview.textContent = marker.preview;
        button.append(preview); button.addEventListener('click', marker.open);
        new library.Marker({ element: button, offset: [count * 34, count * -24] }).setLngLat([marker.lon, marker.lat]).addTo(map);
      }
      const points: [number, number][] = [...(publication.map.home_extent_points ?? []), ...markers.map((marker): [number, number] => [marker.lon, marker.lat])];
      if (points.length > 1) {
        map.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))],
          [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], { padding: 60, maxZoom: 11 });
      }
    };
    void start().catch(fail);
    return () => { retired = true; map?.remove(); };
  }, [publication, markers]);
  return <figure className="portal-map"><div ref={container} aria-label="Market development map" />
    {failed && <p role="status">Map unavailable. Explore the development and regional context cards below.</p>}
    <figcaption>{publication.market.mini_map_caption} · Approximate study locators.
      {publication.map.basemap.kind === 'local-layers' && ` ${publication.map.basemap.attribution}`}</figcaption></figure>;
}
