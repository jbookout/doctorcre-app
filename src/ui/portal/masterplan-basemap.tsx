import { useEffect, useRef, useState } from 'react';
import { currentRights, providerSession } from './masterplan-provider';
import type { ProviderRights } from './masterplan-provider';

export type DevelopmentOverlay = {
  id: string; title: string;
  overlay?: { type: 'FeatureCollection'; features: unknown[] };
  overlay_note?: string;
};
type MapIssue = { sourceId?: string };
export interface MasterplanMap {
  addSource(id: string, source: object): unknown;
  getSource(id: string): unknown;
  removeSource(id: string): unknown;
  addLayer(layer: object, before?: string): unknown;
  getLayer(id: string): unknown;
  removeLayer(id: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
  on(event: string, listener: (event: MapIssue) => void): unknown;
  on(event: 'click', layer: string, listener: () => void): unknown;
  off(event: string, listener: (event: MapIssue) => void): unknown;
  off(event: 'click', layer: string, listener: () => void): unknown;
}
export interface ProtocolRegistry {
  addProtocol(name: string, handler: (request: { url: string }, abort: AbortController) => Promise<{ data: ArrayBuffer }>): unknown;
  removeProtocol(name: string): unknown;
}
export type BasemapState = { kind: 'local' | 'loading' | 'vector' | 'fallback' | 'disposed'; notice: string };
type Options = {
  map: MasterplanMap;
  registry: ProtocolRegistry;
  localLayerIds: string[];
  receipt?: ProviderRights;
  now?: () => number;
  fetch?: typeof fetch;
  openProject: (id: string) => void;
  onState: (state: BasemapState) => void;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
let sessionId = 0;
export function masterplanController(options: Options) {
  const { map, registry, localLayerIds } = options;
  const localAvailable = localLayerIds.length > 0 && localLayerIds.every(id => Boolean(map.getLayer(id)));
  const protocol = `s16tiles${++sessionId}`;
  const network = providerSession({ receipt: options.receipt, ...(options.now ? { now: options.now } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const vectors = { sources: new Set<string>(), layers: new Set<string>() };
  const overlays = { sources: new Set<string>(), layers: new Set<string>() };
  const clicks = new Map<string, () => void>();
  let state: BasemapState['kind'] = 'local';
  let generation = 0;
  let visible = true;
  let loading: AbortController | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const publish = (kind: BasemapState['kind'], notice: string) => { state = kind; options.onState({ kind, notice }); };
  const clean = (resources: typeof vectors) => {
    for (const id of [...resources.layers].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of resources.sources) if (map.getSource(id)) map.removeSource(id);
    resources.layers.clear(); resources.sources.clear();
  };
  const local = () => {
    generation++;
    loading?.abort();
    clearTimeout(expiry);
    clean(vectors);
    for (const id of localLayerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
  };
  const fallback = () => {
    if (state === 'disposed') return;
    local();
    publish('fallback', localAvailable ? 'Vector basemap unavailable. Showing the permitted local map layers.' : 'Map unavailable. The property list remains available.');
  };
  const issue = ({ sourceId }: MapIssue) => {
    if ((state === 'loading' && !sourceId) || (sourceId && vectors.sources.has(sourceId))) fallback();
    else if (sourceId && overlays.sources.has(sourceId)) {
      removeOverlays();
      options.onState({ kind: state, notice: 'Master plan unavailable. Property cards remain available.' });
    }
  };
  const removeOverlays = () => {
    for (const [id, listener] of clicks) map.off('click', id, listener);
    clicks.clear(); clean(overlays);
  };
  registry.addProtocol(protocol, async (request, abort) => {
    try {
      if (state !== 'vector') throw new Error('Vector basemap retired.');
      return { data: await network.read(request.url.slice(protocol.length + 3), abort.signal) };
    } catch (error) { if (!abort.signal.aborted) fallback(); throw error; }
  });
  map.on('error', issue);
  return {
    overlays(developments: DevelopmentOverlay[]) {
      if (state === 'disposed') return;
      removeOverlays();
      if (developments.filter(item => item.overlay).length > 32) {
        options.onState({ kind: state, notice: 'Master plan exceeds the map capacity. Property cards remain available.' });
        return;
      }
      try {
        for (const item of developments) {
          if (!item.overlay) continue;
          if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.id)) throw new Error('Invalid development ID.');
          const id = `s16-plan-${item.id}`;
          overlays.sources.add(id);
          map.addSource(id, { type: 'geojson', data: item.overlay });
          const definitions = [
            { suffix: 'fill', type: 'fill', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#b99b62', 'fill-opacity': 0.24 } },
            { suffix: 'roads', type: 'line', filter: ['all', ['==', '$type', 'LineString'], ['!=', 'role', 'closure']], paint: { 'line-color': '#958064', 'line-width': 2 } },
            { suffix: 'closure', type: 'line', filter: ['all', ['==', '$type', 'LineString'], ['==', 'role', 'closure']], paint: { 'line-color': '#958064', 'line-width': 2, 'line-dasharray': [3, 2] } },
            { suffix: 'point', type: 'circle', filter: ['==', '$type', 'Point'], paint: { 'circle-color': '#b99b62', 'circle-radius': 5 } },
          ];
          for (const definition of definitions) {
            const layer = `${id}-${definition.suffix}`;
            overlays.layers.add(layer);
            map.addLayer({ id: layer, type: definition.type, source: id, filter: definition.filter, paint: definition.paint, layout: { visibility: visible ? 'visible' : 'none' } });
            const click = () => options.openProject(item.id);
            clicks.set(layer, click); map.on('click', layer, click);
          }
        }
      } catch { removeOverlays(); options.onState({ kind: state, notice: 'Master plan unavailable. Property cards remain available.' }); }
    },
    visible(value: boolean) {
      if (state === 'disposed') return;
      visible = value;
      for (const id of overlays.layers) map.setLayoutProperty(id, 'visibility', value ? 'visible' : 'none');
    },
    local() { if (state !== 'disposed') { local(); publish('local', 'Showing the permitted local map layers.'); } },
    async vector(url: string) {
      if (state === 'disposed') return;
      local();
      if (!localAvailable || !currentRights(options.receipt, (options.now ?? Date.now)())) { fallback(); return; }
      publish('loading', 'Loading vector basemap. Local map layers remain available.');
      loading = new AbortController();
      const revision = generation;
      try {
        const bytes = await network.read(url, loading.signal);
        if (revision !== generation) return;
        const style: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!record(style) || style.version !== 8 || style.glyphs || style.sprite || !record(style.sources)
          || !Array.isArray(style.layers) || Object.keys(style.sources).length > 8 || style.layers.length > 64) throw new Error('Unsupported provider style.');
        for (const [id, source] of Object.entries(style.sources)) {
          if (!/^[a-zA-Z0-9_-]+$/.test(id) || !record(source) || source.type !== 'vector' || source.url
            || !Array.isArray(source.tiles) || source.tiles.length !== 1 || typeof source.tiles[0] !== 'string') throw new Error('Unsupported vector source.');
          const name = `s16-vector-${id}`;
          vectors.sources.add(name);
          map.addSource(name, { ...source, tiles: [`${protocol}://${source.tiles[0]}`] });
          if (revision !== generation) { clean(vectors); return; }
        }
        for (const layer of style.layers) {
          if (!record(layer) || typeof layer.id !== 'string' || !['fill', 'line', 'background', 'circle'].includes(String(layer.type))
            || (layer.type !== 'background' && (typeof layer.source !== 'string' || !vectors.sources.has(`s16-vector-${layer.source}`)))) throw new Error('Unsupported vector layer.');
          const id = `s16-vector-${layer.id}`;
          vectors.layers.add(id);
          const color = layer.type === 'background' ? '#f3f0ea' : layer.type === 'fill' ? '#e3ded3' : '#958064';
          map.addLayer({ ...layer, id, ...(typeof layer.source === 'string' ? { source: `s16-vector-${layer.source}` } : {}), paint: { ...(record(layer.paint) ? layer.paint : {}), [`${layer.type}-color`]: color } }, localLayerIds.find(id => Boolean(map.getLayer(id))));
          if (revision !== generation) { clean(vectors); return; }
        }
        for (const id of localLayerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        publish('vector', options.receipt.attribution);
        const remaining = Math.min(Date.parse(options.receipt.expiresAt), Date.parse(options.receipt.reviewedAt) + 90 * 86400000) - (options.now ?? Date.now)();
        // eslint-disable-next-line no-restricted-syntax -- One rights-expiry deadline, capped at the timer maximum and cleared on local switch or disposal; no reads.
        expiry = setTimeout(fallback, Math.min(remaining, 2147483647));
      } catch { if (revision === generation) fallback(); }
    },
    dispose() {
      if (state === 'disposed') return;
      local(); removeOverlays(); network.dispose();
      map.off('error', issue); registry.removeProtocol(protocol);
      publish('disposed', '');
    },
  };
}

export function MasterplanBasemap(props: Omit<Options, 'onState'> & { developments: DevelopmentOverlay[]; styleUrl?: string }) {
  const [state, setState] = useState<BasemapState>({ kind: 'local', notice: 'Showing the permitted local map layers.' });
  const [visible, setVisible] = useState(true);
  const controller = useRef<ReturnType<typeof masterplanController> | null>(null);
  const callback = useRef(props.openProject);
  callback.current = props.openProject;
  useEffect(() => {
    const instance = masterplanController({ ...props, openProject: id => callback.current(id), onState: setState });
    controller.current = instance;
    return () => { instance.dispose(); controller.current = null; };
  }, [props.map, props.registry, props.receipt, props.localLayerIds]);
  useEffect(() => { controller.current?.overlays(props.developments); }, [props.developments, props.map, props.registry, props.receipt, props.localLayerIds]);
  useEffect(() => { controller.current?.visible(visible); }, [visible, props.developments, props.map, props.registry, props.receipt, props.localLayerIds]);
  const plans = props.developments.filter(item => item.overlay);
  return <section aria-label="Map layers" style={{ display: 'grid', gap: 8, padding: 12, maxWidth: '100%', color: 'var(--ink, inherit)', background: 'var(--surface-1, transparent)' }}>
    {plans.length > 0 && <><label><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} /> Show master plan</label>
      {visible && plans.map(item => <button type="button" className="overlay-map-label" key={item.id} onClick={() => callback.current(item.id)}>{item.title}</button>)}
      {visible && plans.map(item => item.overlay_note && <small key={item.id}>{item.overlay_note}</small>)}</>}
    {props.styleUrl && <label>Basemap <select value={state.kind === 'vector' || state.kind === 'loading' ? 'vector' : 'local'} onChange={event => {
      if (event.target.value === 'vector' && props.styleUrl) void controller.current?.vector(props.styleUrl);
      else controller.current?.local();
    }}><option value="local">Local map layers</option><option value="vector">Vector basemap</option></select></label>}
    <p role="status">{state.notice}</p>
  </section>;
}
