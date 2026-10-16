import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { TOUCH_LAYOUT } from '../js/touch-layout.js';

test('every stylesheet switches to the touch layout with the shared query', async () => {
  const css = new URL('../css/', import.meta.url);
  let uses = 0;
  for (const name of await readdir(css)) {
    const source = await readFile(new URL(name, css), 'utf8');
    for (const [, query] of source.matchAll(/@media ?([^{]*\b76[01]px[^{]*)\{/g)) {
      uses++;
      assert.ok(query.trim() === TOUCH_LAYOUT || query.includes(`(not (${TOUCH_LAYOUT.split(',')[1]}))`), `${name}: ${query}`);
    }
  }
  assert.ok(uses >= 17);
});
