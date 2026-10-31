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

test('typed record route contract agrees with the guarded release routes and encodes IDs', async () => {
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: ['src/ui/home/routes.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { recordRoutePatterns, recordRoutes } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  for (const pattern of Object.values(recordRoutePatterns)) { assert.ok(routeContract.routes[pattern]); assert.ok(routeContract.gatePaths[pattern]); }
  assert.equal(recordRoutes.card('task:a/b?x=y'), '/home/card/task%3Aa%2Fb%3Fx%3Dy');
  assert.equal(recordRoutes.deal('synthetic-deal'), '/deals/synthetic-deal');
  assert.equal(recordRoutes.contact('synthetic-contact'), '/contacts/synthetic-contact');
  assert.equal(recordRoutes.task('synthetic-task'), '/tasks/synthetic-task');
});
