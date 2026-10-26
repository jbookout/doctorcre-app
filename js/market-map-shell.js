const distribution = new URL('../tours/vendor/maplibre-gl-6.4.1/', import.meta.url);

export function mountMarketMap(root, { loadMapLibre = () => import('../tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs'), events = {}, signal, ...options } = {}) {
  let map = null, destroyed = signal?.aborted || false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    signal?.removeEventListener('abort', destroy);
    if (!map) return;
    for (const [name, listener] of Object.entries(events)) map.off(name, listener);
    map.remove();
  }
  if (!destroyed) signal?.addEventListener('abort', destroy, { once: true });
  const ready = (async () => {
    if (destroyed) return null;
    const doc = root.ownerDocument, stylesheet = new URL('maplibre-gl.css', distribution).pathname;
    if (![...doc.querySelectorAll('link[rel="stylesheet"]')].some(link => new URL(link.href).pathname === stylesheet)) {
      const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = stylesheet; doc.head.append(link);
    }
    const gl = await loadMapLibre();
    if (destroyed) return null;
    gl.setWorkerUrl(new URL('maplibre-gl-worker.mjs', distribution).href);
    map = new gl.Map({ center: [-87.3, 30.5], zoom: 8, attributionControl: false, ...options, container: root });
    for (const [name, listener] of Object.entries(events)) map.on(name, listener);
    return { map, gl };
  })().catch(error => { destroy(); throw error; });
  return { ready, destroy };
}
