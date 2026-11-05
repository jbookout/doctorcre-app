function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function resource(value: unknown, base: string): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing style resource.');
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Unsupported resource URL.');
  return url.href.replaceAll('%7B', '{').replaceAll('%7D', '}');
}
function zoom(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 24) throw new Error('Invalid tile zoom.');
  return value;
}
export async function prepareVectorStyle(options: {
  bytes: ArrayBuffer;
  url: string;
  read: (url: string) => Promise<ArrayBuffer>;
  wrap: (url: string) => string;
}) {
  const style: unknown = JSON.parse(new TextDecoder().decode(options.bytes));
  if (!record(style) || style.version !== 8 || !record(style.sources) || !Array.isArray(style.layers)
    || Object.keys(style.sources).length > 8 || style.layers.length > 64) throw new Error('Unsupported provider style.');
  const sources = new Map<string, object>();
  // eslint-disable-next-line no-restricted-syntax -- A cap of eight sequential TileJSON reads shares the session's 60/minute, two-concurrent and five-second bounds.
  for (const [id, source] of Object.entries(style.sources)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !record(source) || source.type !== 'vector') throw new Error('Unsupported vector source.');
    let metadata = source;
    let base = options.url;
    if (source.url !== undefined) {
      base = resource(source.url, options.url);
      const data: unknown = JSON.parse(new TextDecoder().decode(await options.read(base)));
      if (!record(data)) throw new Error('Invalid TileJSON.');
      metadata = data;
    }
    if (!Array.isArray(metadata.tiles) || metadata.tiles.length < 1 || metadata.tiles.length > 4) throw new Error('Invalid tile templates.');
    const tiles = metadata.tiles.map(value => options.wrap(resource(value, base)));
    const minzoom = zoom(metadata.minzoom, 0);
    const maxzoom = zoom(metadata.maxzoom, 22);
    if (minzoom > maxzoom || (metadata.scheme !== undefined && !['xyz', 'tms'].includes(String(metadata.scheme)))) throw new Error('Invalid tile scheme.');
    sources.set(id, { type: 'vector', tiles, minzoom, maxzoom, ...(metadata.scheme === 'tms' ? { scheme: 'tms' } : {}) });
  }
  const layers = style.layers.map((layer: unknown) => {
    if (!record(layer) || typeof layer.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(layer.id)
      || !['fill', 'line', 'background', 'circle', 'symbol'].includes(String(layer.type))
      || (layer.type !== 'background' && (typeof layer.source !== 'string' || !sources.has(layer.source)))) throw new Error('Unsupported vector layer.');
    return layer;
  });
  if (new Set(layers.map(layer => layer.id)).size !== layers.length) throw new Error('Duplicate layer.');
  const sprites: { id: string; url: string }[] = [];
  if (style.sprite !== undefined) {
    const definitions = typeof style.sprite === 'string' ? [{ id: 'default', url: style.sprite }] : style.sprite;
    if (!Array.isArray(definitions) || definitions.length > 4) throw new Error('Invalid sprites.');
    for (const value of definitions) {
      if (!record(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.id)
        || sprites.some(item => item.id === value.id)) throw new Error('Invalid sprite ID.');
      sprites.push({ id: value.id, url: options.wrap(resource(value.url, options.url)) });
    }
  }
  return { sources, layers, sprites, glyphs: style.glyphs === undefined ? undefined : options.wrap(resource(style.glyphs, options.url)) };
}
