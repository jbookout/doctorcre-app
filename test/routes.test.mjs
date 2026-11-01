import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { routeEntries, routeContract, navigationItems, routeKey } from '../js/routes.js';

test('the opt-in inbox and its card URLs resolve to the inbox page, and card IDs stay encoded', async () => {
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: ['src/ui/home/routes.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { recordRoutes } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
  const card = recordRoutes.card('task:a/b?x=y');
  assert.equal(card, '/inbox/card/task%3Aa%2Fb%3Fx%3Dy');
  assert.equal(routeContract.routes[routeKey(card)], 'inbox.html');
  assert.equal(routeContract.routes[routeKey(recordRoutes.inbox())], 'inbox.html');
  assert.equal(routeKey('/inbox/card/a/b'), '/inbox/card/a/b');
  assert.equal(routeContract.routes['/'], 'workspace.html', 'Home stays the classic dashboard');
});

test('routes are unique and navigation reaches existing pages', async () => {
  const paths = [...routeEntries.map(([path]) => path), ...Object.keys(routeContract.redirects)];
  assert.equal(new Set(paths).size, paths.length);
  for (const [, asset] of routeEntries) await access(new URL('../' + asset, import.meta.url));
  for (const item of navigationItems) assert.ok(routeContract.routes[item.href.split('?')[0]], item.href);
});
