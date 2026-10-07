import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// The tour page is the root. Follow only literal local code dependencies;
// fetches, session reads, provider tiles and captured audio never enter this set.
export async function offlineTourShell(readSource) {
  const sources = new Map();
  async function visit(path) {
    if (sources.has(path)) return;
    const bytes = await readSource(path.slice(1));
    assert.ok(bytes != null, `missing offline shell dependency: ${path}`);
    const source = String(bytes);
    sources.set(path, source);
    const references = path.endsWith('.html')
      ? [...source.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/g)].map(match => match[1])
      : /\.m?js$/.test(path)
        ? [...source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g)].map(match => match[1] || match[2])
        : [];
    for (const reference of references) {
      if (!reference.startsWith('.') && !reference.startsWith('/')) continue;
      const url = new URL(reference, `https://offline.invalid${path}`);
      if (url.origin !== 'https://offline.invalid') continue;
      if (!/\.(?:html|css|m?js)$/.test(url.pathname)) continue;
      assert.ok(/^\/(?:js|css|tours)\/.+\.(?:html|css|m?js)$/.test(url.pathname), `unsupported offline code dependency: ${reference}`);
      await visit(url.pathname);
    }
  }
  await visit('/tours/day.html');
  const files = [...sources.keys()].sort();
  const hash = createHash('sha256');
  for (const path of files) hash.update(path).update('\0').update(sources.get(path)).update('\0');
  return { cache: `doctorcre-tour-day-shell-${hash.digest('hex')}`, files };
}
