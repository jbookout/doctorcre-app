import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { routeEntries, routeContract, navigationItems } from '../js/routes.js';

test('routes are unique and navigation reaches existing pages', async () => {
  const paths = [...routeEntries.map(([path]) => path), ...Object.keys(routeContract.redirects)];
  assert.equal(new Set(paths).size, paths.length);
  for (const [, asset] of routeEntries) await access(new URL('../' + asset, import.meta.url));
  for (const item of navigationItems) assert.ok(routeContract.routes[item.href.split('?')[0]], item.href);
});
