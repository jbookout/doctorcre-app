import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(readFileSync('contracts/people-directory.v1.json'));
const ajv = new Ajv({ formats: { uuid: /^[0-9a-f-]{36}$/i } });
const validators = Object.fromEntries(Object.entries(contract.verbs).map(([verb, spec]) => [verb, ajv.compile(spec.response)]));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cursor = n => ({ query: 'ann', name: `Ann ${n}`, id: id(n) });
const page = (n, next = null) => ({ ok: true, schema_version: 'party-search.v1', parties: [{ id: id(n), display_name: `Ann ${n}`, kind: 'person' }], next_cursor: next });
const bundle = await build({ stdin: { contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client'; import {WaitingPeople} from './src/ui/home/waiting-people'; import {createInboxClient} from './src/ui/home/inbox'; const root=createRoot(document.getElementById('root')); function App(){const [selected,select]=useState(null);return <WaitingPeople client={window.client} id="person" selected={selected} select={select}/>;} window.client=createInboxClient((name,args)=>window.rpc(name,args));window.stop=()=>root.unmount();root.render(<App/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife' });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mount(t, search) {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'dangerously', url: 'http://localhost' });
  t.after(() => { dom.window.stop(); dom.window.close(); });
  const calls = [];
  dom.window.rpc = async (name, args) => {
    if (name === 'search-parties-v1') calls.push(structuredClone(args));
    const value = name === 'read-actor-roster-v1' ? { ok: true, schema_version: 'actor-roster.v1', actors: [{ id: id(90), slug: 'ann', display_name: 'Ann team', kind: 'human' }] } : await search(args, calls.length);
    if (value.error !== 'unknown_tool' && validators[name]) assert.equal(validators[name](value), true, JSON.stringify(validators[name].errors));
    return value;
  };
  dom.window.eval(bundle.outputFiles[0].text);
  await tick(30);
  const doc = dom.window.document;
  const input = value => { const node = doc.querySelector('input'); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const click = text => { const button = [...doc.querySelectorAll('button')].find(node => node.textContent === text); assert.ok(button, text); button.click(); };
  const options = () => [...doc.querySelector('select').options].map(option => option.value);
  return { dom, doc, calls, input, click, options };
}
for (const failedPage of [1, 2, 3]) test(`exact retry preserves pages and selection on page ${failedPage}`, async t => {
  let fail = true;
  const ui = await mount(t, async args => {
    const n = args.cursor ? Number(args.cursor.id.slice(-12)) + 1 : 1;
    if (n === failedPage && fail) { fail = false; throw Error('synthetic read failure'); }
    return page(n, n < 3 ? cursor(n) : null);
  });
  ui.input('  Ann  '); await tick(350);
  for (let n = 1; n < failedPage; n++) { ui.click('More results'); await tick(20); }
  const before = ui.options();
  const select = ui.doc.querySelector('select'); select.value = id(90); select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true })); await tick(10);
  const failed = ui.calls.at(-1);
  ui.click('Retry search'); ui.click('Retry search'); await tick(40);
  assert.deepEqual(ui.calls.at(-1), failed);
  assert.equal(ui.calls.length, failedPage + 1);
  assert.equal(select.value, id(90));
  assert.deepEqual(ui.options(), [...before, id(failedPage)]);
  assert.equal(ui.calls[0].query, 'Ann'); assert.equal(ui.calls[0].limit, 25);
});
test('query change retires failed and in-flight pages and unmount discards queued reads', async t => {
  let release; let active = 0; let maxActive = 0;
  const ui = await mount(t, async args => {
    active++; maxActive = Math.max(active, maxActive);
    if (args.query === 'Ann') await new Promise(resolve => { release = resolve; });
    active--; return page(args.query === 'Ann' ? 1 : 2);
  });
  ui.input('A'); await tick(100); ui.input('Ann'); await tick(200); assert.equal(ui.calls.length, 0); await tick(150);
  ui.input('Bea'); await tick(350); assert.equal(ui.calls.length, 1);
  release(); await tick(40); assert.equal(maxActive, 1); assert.deepEqual(ui.options(), ['', id(90), id(2)]);
  ui.input('Ann'); await tick(350); ui.input('Later'); await tick(350); ui.dom.window.stop(); release(); await tick(30); assert.equal(ui.calls.length, 3);
});
