import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fixtureKey } from './fixture-http.mjs';

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

export async function loadFixtureAssets({ root, manifest, limits = {} }) {
  if (!(manifest instanceof Map)) throw new TypeError('An explicit manifest map is required');
  const maxBytes = limits.bytes ?? 64 * 1024 * 1024, maxEntries = limits.entries ?? 10000;
  for (const value of [maxBytes, maxEntries]) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid preload budget');
  if (manifest.size > maxEntries) throw new RangeError('Fixture entry budget exceeded');
  const base = await realpath(root), assets = new Map();
  let bytes = 0;
  for (const [key, file] of manifest) {
    fixtureKey(key);
    if (typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new TypeError('Manifest paths must be relative files');
    const path = resolve(base, file), rel = relative(base, path);
    if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new TypeError('Manifest escapes root');
    let current = base;
    for (const part of rel.split(sep)) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new TypeError('Fixture symlinks are forbidden');
    }
    const info = await lstat(path);
    if (!info.isFile()) throw new TypeError('Manifest entries must be files');
    if (bytes + info.size > maxBytes) throw new RangeError('Fixture byte budget exceeded');
    const body = await readFile(path);
    bytes += body.length;
    if (bytes > maxBytes) throw new RangeError('Fixture byte budget exceeded');
    assets.set(key, { body, contentType: types[extname(file)] || 'application/octet-stream' });
  }
  return assets;
}
