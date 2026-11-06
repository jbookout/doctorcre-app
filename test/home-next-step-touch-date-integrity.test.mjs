import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { syntheticBoard } from '../scripts/prove-home-next-step-touch-date-integrity.mjs';
const { outputFiles } = await build({ entryPoints: ['src/ui/home/missing-next-step.tsx'], bundle: true, write: false, format: 'iife', globalName: 'Home', jsx: 'automatic', footer: { js: 'globalThis.Home = Home;' } });
for (const [value, expected] of [
  ['0000-01-01', 'Last touch unavailable'], ['10000-01-01', 'Last touch unavailable'],
  ['2026-02-31', 'Last touch unavailable'], ['2025-02-29', 'Last touch unavailable'],
  ['1900-02-29', 'Last touch unavailable'], ['2026-00-01', 'Last touch unavailable'],
  ['2026-01-00', 'Last touch unavailable'], ['2026-13-01', 'Last touch unavailable'],
  ['2026-04-31', 'Last touch unavailable'], ['', 'Last touch unavailable'],
  ['garbage', 'Last touch unavailable'], [false, 'Last touch unavailable'], [0, 'Last touch unavailable'],
  [undefined, 'Last touch unavailable'], [{}, 'Last touch unavailable'],
  ['2026-02-28garbage', 'Last touch unavailable'], ['2026-02-28T23:00:00-06:00', 'Last touch unavailable'],
  ['2026-02-28T00:00:00Z', 'Last touch unavailable'],
  [null, 'No last touch'], ['2028-02-29', 'Last touch Feb 29'], ['2000-02-29', 'Last touch Feb 29'],
  ['2026-03-01', 'Last touch Mar 1'], ['0096-02-29', 'Last touch Feb 29'],
]) test(`mount renders ${JSON.stringify(value)} as ${expected}`, async t => {
  const dom = new JSDOM('<main></main>', { runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.eval(outputFiles[0].text);
  const host = dom.window.document.querySelector('main');
  const view = dom.window.Home.mountMissingNextStep(host, { joe: 'Joe' });
  t.after(() => { view.dispose(); dom.window.close(); });
  view.update(await syntheticBoard({ last_touch: value }), 'mine');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(host.querySelector('a div span')?.textContent, expected);
  assert.equal(host.querySelector('a').getAttribute('href'), '/deals?deal=synthetic%2F0%3F&focus=next-step');
  assert.match(host.textContent, /Synthetic deal 0.*Negotiation/);
});
