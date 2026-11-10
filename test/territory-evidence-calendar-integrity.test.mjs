import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const { outputFiles } = await build({ entryPoints: ['src/ui/territory-evidence.tsx'], bundle: true, write: false, format: 'iife', globalName: 'Territory', jsx: 'automatic', footer: { js: 'globalThis.Territory = Territory;' } });
const script = outputFiles[0].text;
const evidence = (patch = {}) => ({ flag_id: 'synthetic', condition: 'tight', source: 'Synthetic source', observed_at: '2028-02-29T12:00:00Z', expires_on: '2028-03-01', expired: false, current: true, ...patch });
const board = entry => ({ schema_version: 'territory-state-board.v1', coverage: 'recorded_geographies_only', submarkets: [{ city: 'Austin', state: 'TX', condition: 'tight', evidence: [entry] }] });
async function render(t, entry) {
  const dom = new JSDOM('<div id="host"></div>', { runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.eval(script);
  const host = dom.window.document.querySelector('#host');
  const view = dom.window.Territory.mountTerritoryEvidence(host, { getTerritoryStateBoard: async () => board(entry) }, () => {});
  t.after(() => { view.dispose(); dom.window.close(); });
  const details = host.querySelector('details'); details.open = true;
  details.dispatchEvent(new dom.window.Event('toggle'));
  await new Promise(resolve => setTimeout(resolve, 0));
  return host;
}
for (const patch of [
  { observed_at: '2026-02-31' }, { observed_at: '2026-02-31T12:00:00Z' },
  { observed_at: '2027-02-29T12:00:00Z' }, { expires_on: 'nonsense' },
  { expires_on: '2026-04-31' }, { expires_on: '1900-02-29' },
  { observed_at: '2028-02-29T12:00:00' }, { observed_at: '2028-02-29T24:00:00Z' },
  { observed_at: '2028-02-29T12:60:00Z' }, { observed_at: '2028-02-29T12:00:00+24:00' },
  { observed_at: '2028-02-29T12:00:00+01:60' }, { current: true, expired: true },
]) test(`refuses invalid evidence ${JSON.stringify(patch)}`, async t => {
  const host = await render(t, evidence(patch));
  assert.match(host.querySelector('[role="alert"]')?.textContent || '', /Territory evidence unavailable/);
  assert.equal(host.querySelector('table'), null);
  assert.equal(host.querySelectorAll('input').length, 3);
  assert.match(host.textContent, /Refresh evidence/);
});
for (const patch of [
  {}, { observed_at: '0096-02-29T00:00:00Z', expires_on: '0096-03-01' },
  { observed_at: '2000-02-29T00:00:00.123456+05:30', expires_on: null },
  { observed_at: '2028-02-29T07:00:00-05:00' },
  { current: false, expired: true, observed_at: '1900-02-28T00:00:00Z', expires_on: '1900-03-01' },
  { expires_on: '2000-02-29' }, { current: false, expired: false },
]) test(`preserves server evidence ${JSON.stringify(patch)}`, async t => {
  const host = await render(t, evidence(patch));
  assert.ok(host.querySelector('table'));
  assert.equal(host.querySelector('[role="alert"]'), null);
  assert.match(host.textContent, /Tight/);
  assert.ok(host.textContent.includes(evidence(patch).observed_at));
});
