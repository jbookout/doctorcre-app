import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import axe from 'axe-core';
import { chromium, webkit } from './browser-harness.mjs';

const properties = JSON.parse(readFileSync('test/fixtures/portal-tour-list.market-study.json')).properties;
const css = readFileSync('css/tokens.css', 'utf8') + readFileSync('portal/tour-list.css', 'utf8');
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {TourList} from './src/ui/portal/tour-list-signout'; import {createTourList} from './src/ui/portal/tour-list-state';
let snapshot = window.syntheticSnapshot ?? {version:4, selected:[], notes:{}};
window.requests=[]; window.gates=0; window.cleared=0; window.opened=[];
window.model=createTourList(window.syntheticProperties ?? ${JSON.stringify(properties)}, {
read:async()=>snapshot,
save:async request=> {window.requests.push(request); if(window.failure==='conflict') throw {status:409}; if(window.failure==='lost') throw Error(); snapshot={...request,version:request.version+1}; return snapshot;},
signOut:async()=>{window.logoutCalls=(window.logoutCalls||0)+1; if(window.logoutFailure) throw Error();},
clearPrivateState:()=>window.cleared++, returnToGate:()=>window.gates++
});
createRoot(document.getElementById('root')).render(<TourList model={window.model} openProperty={id=>window.opened.push(id)}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
async function open(t, engine, width = 390, theme = 'light', fixture = {}) {
  const browser = await engine.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en" data-theme="${theme}"><head><title>Synthetic Tour List</title><style>body{margin:0}${css}</style></head><body><main id="root"></main></body></html>` }));
  await page.goto('http://localhost/tour-list-fixture');
  await page.evaluate(fixture => Object.assign(window, fixture), fixture);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-state="ready"]').waitFor();
  return page;
}
const candidate = properties.find(p => p.role === 'candidate');
for (const engine of [chromium, webkit]) for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Tour List DOM ${engine === webkit ? 'webkit' : 'chromium'} ${width} ${theme}`, { skip: engine.skip }, async t => {
  const page = await open(t, engine, width, theme);
  await page.getByRole('button', { name: `Add ${candidate.address}`, exact: true }).click();
  const selected = page.getByRole('region', { name: 'Selected properties', exact: true });
  await selected.getByRole('textbox').fill('Please review accessibility.');
  await selected.getByRole('button', { name: candidate.address, exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.opened), [candidate.id]);
  await page.getByRole('button', { name: 'Save Selections', exact: true }).click();
  await page.locator('[data-state="ready"]').waitFor();
  assert.equal(await page.evaluate(() => window.requests[0].selected[0]), candidate.id);
  assert.equal(await page.evaluate(() => window.requests[0].version), 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await axe.run(document)).violations.map(v => v.id)), []);
  mkdirSync('out/test-artifacts/portal-tour-list', { recursive: true });
  await page.screenshot({ path: `out/test-artifacts/portal-tour-list/${engine === webkit ? 'webkit' : 'chromium'}-${width}-${theme}.png`, fullPage: true });
});
test('DOM conflict, discard confirmation, uncertain retry, drag, expiry and logout', async t => {
  const page = await open(t, chromium);
  await page.evaluate(() => window.failure = 'conflict');
  await page.getByRole('button', { name: `Add ${candidate.address}`, exact: true }).click();
  await page.getByRole('button', { name: 'Save Selections', exact: true }).click();
  await page.locator('[data-state="conflict"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save Selections', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Reload Shared List', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.getByRole('button', { name: 'Reload Shared List', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and reload', exact: true }).click();
  await page.locator('[data-state="ready"]').waitFor();
  await page.evaluate(() => window.failure = 'lost');
  const transfer = await page.evaluateHandle(id => { const data = new DataTransfer(); data.setData('text/plain', id); return data; }, candidate.id);
  await page.getByRole('region', { name: 'Selected properties', exact: true }).dispatchEvent('drop', { dataTransfer: transfer });
  await page.getByRole('button', { name: 'Save Selections', exact: true }).click();
  await page.locator('[data-state="uncertain"]').waitFor();
  assert.equal(await page.getByRole('textbox').isDisabled(), true);
  await page.evaluate(() => window.failure = null);
  await page.getByRole('button', { name: 'Retry same save', exact: true }).click();
  await page.locator('[data-state="ready"]').waitFor();
  assert.equal(await page.evaluate(() => window.requests[1].idempotency_key === window.requests[2].idempotency_key), true);
  await page.getByRole('textbox').fill('Unsaved note');
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
  await page.evaluate(() => window.logoutFailure = true);
  await page.getByRole('button', { name: 'Discard and sign out', exact: true }).click();
  await page.locator('[data-state="signout-uncertain"]').waitFor();
  assert.equal(await page.getByRole('textbox').count(), 0);
  assert.equal(await page.evaluate(() => window.cleared), 1);
  await page.evaluate(() => window.logoutFailure = false);
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
  await page.waitForFunction(() => window.gates === 1);
  assert.equal(await page.getByRole('region', { name: 'Tour List', exact: true }).count(), 0);
});

for (const width of [390, 1280]) test(`prototype-name Tour List DOM ${width}`, async t => {
  const ids = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
  const page = await open(t, chromium, width, 'light', {
    syntheticProperties: ids.map((id, i) => ({ id, number: i + 1, address: `Synthetic ${id}`, role: 'candidate', summary: 'Synthetic' })),
    syntheticSnapshot: { version: 1, selected: ids, notes: {} },
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const id of ids) {
    const note = page.getByRole('textbox', { name: `Notes for Synthetic ${id}` });
    assert.equal(await note.inputValue(), '');
    await note.fill(`Synthetic ${id} note`);
  }
  await page.getByRole('button', { name: 'Save Selections', exact: true }).click();
  await page.locator('[data-state="ready"]').waitFor();
  for (const id of ids) {
    assert.equal(await page.getByRole('textbox', { name: `Notes for Synthetic ${id}` }).inputValue(), `Synthetic ${id} note`);
    assert.equal(await page.evaluate(id => window.requests[0].notes[id], id), `Synthetic ${id} note`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  mkdirSync('out/test-artifacts/portal-tour-list', { recursive: true });
  await page.screenshot({ path: `out/test-artifacts/portal-tour-list/prototype-${width}.png`, fullPage: true });
});
