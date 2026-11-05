import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'), 'src/ui/portal/shell-home-sources.tsx');
const { mountMarketStudy } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
const fixture = JSON.parse(await readFile(new URL('./fixtures/portal/example-health.market-study.json', import.meta.url)));
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
async function open(data = fixture, hash = '') {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/example-health/' + hash });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = document.querySelector('#root');
  const panel = mountMarketStudy(root, { package: structuredClone(data) });
  await tick();
  return { root, panel, dom };
}
test('Home describes the market and Sources renders typed source runs', async () => {
  const { root, panel, dom } = await open();
  assert.equal(root.querySelector('h1').textContent, fixture.market.home_title);
  assert.match(root.textContent, /Sample County's Next Chapter/);
  assert.match(root.textContent, /Major development activity/);
  assert.equal(root.querySelectorAll('[data-snapshot] article').length, 2);
  assert.doesNotMatch(root.textContent, /Asking|Candidate sites|\$1,000,000/);
  dom.window.location.hash = '#sources'; await tick();
  assert.equal(root.querySelector('h1').textContent, 'Sources');
  assert.match(root.textContent, /Every figure in this synthetic study is invented/);
  assert.equal(root.querySelector('nav [aria-current="page"]').textContent, 'Sources');
  assert.equal(document.activeElement, root.querySelector('h1'));
  panel.dispose(); assert.equal(root.textContent, ''); dom.window.close();
});
test('unknown fragments have a focused recovery page and expiry clears publication permanently', async () => {
  const { root, panel, dom } = await open(fixture, '#unrecognized');
  assert.equal(root.querySelector('h1').textContent, 'Page unavailable');
  assert.equal(document.activeElement, root.querySelector('h1'));
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  assert.match(root.textContent, /session expired/);
  dom.window.location.hash = '#home'; await tick();
  assert.doesNotMatch(root.textContent, /Sample County/);
  panel.dispose(); dom.window.close();
});
test('optional fields disappear and unsafe rich links cannot execute or leak credentials', async () => {
  const data = structuredClone(fixture);
  delete data.context_anchors; delete data.client.current_practice; delete data.client.logo;
  data.developments = [];
  data.sources.sections[0].body = [{ text: '<img src=x onerror=alert(1)>' },
    ...['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com/', '//example.com/'].map(url => ({ link: { label: 'Unsafe', url } })),
    { link: { label: 'Safe', url: 'https://example.com/source' } }];
  const { root, panel, dom } = await open(data);
  assert.doesNotMatch(root.textContent, /Current practice|Regional context|Major development activity/);
  assert.match(root.textContent, /EXAMPLE/);
  dom.window.location.hash = '#sources'; await tick();
  assert.equal(root.querySelector('img, script'), null);
  assert.equal(root.querySelectorAll('a[href^="javascript:"], a[href^="data:"]').length, 0);
  assert.match(root.textContent, /<img src=x/);
  const link = [...root.querySelectorAll('a')].find(a => a.textContent === 'Safe');
  assert.equal(link.rel, 'noopener noreferrer');
  panel.dispose(); dom.window.close();
});
test('later modules render only when their package group exists and no inactive module executes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/example-health/#ownership' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const data = structuredClone(fixture); delete data.ownership;
  const root = document.querySelector('#root'); let renders = 0;
  const panel = mountMarketStudy(root, { package: data, modules: [{ route: 'ownership', label: '30/70', available: p => !!p.ownership, render: () => { renders++; return 'Ownership'; } }] });
  await tick(); assert.equal(renders, 0); assert.doesNotMatch(root.querySelector('nav').textContent, /30\/70/);
  panel.dispose(); dom.window.close();
});
test('host expiry and retirement reject a late validated package without remounting', async () => {
  const { mountPortal } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
  for (const action of ['doctorcre-session-invalidated', 'pagehide', 'dispose']) {
    const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/example-health/' });
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const root = document.querySelector('#root'); let complete, signal;
    const host = mountPortal(root, { load: options => { signal = options.signal; return new Promise(resolve => { complete = resolve; }); } });
    assert.match(root.textContent, /Opening/);
    if (action === 'dispose') host.dispose(); else dom.window.dispatchEvent(new dom.window.Event(action));
    assert.equal(signal.aborted, true);
    complete(fixture); await tick();
    assert.doesNotMatch(root.textContent, /Sample County/);
    host.dispose(); dom.window.close();
  }
});
test('the pinned synthetic package satisfies the authoritative full schema', async () => {
  const { default: Ajv } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(await readFile(new URL('./fixtures/portal/market-study.v1.schema.json', import.meta.url)));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...fixture, internal_notes: 'not publishable' }), false);
  const malicious = structuredClone(fixture); malicious.sources.sections[0].body = [{ link: { label: 'Bad', url: 'javascript:alert(1)' } }];
  assert.equal(validate(malicious), false);
});
test('host resolves once, disposes visible data and refuses failed loads before expiry', async () => {
  const { mountPortal } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
  for (const fail of [false, true]) {
    const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/example-health/' });
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const root = document.querySelector('#root'); let calls = 0;
    const panel = mountPortal(root, { load: async () => { calls++; if (fail) throw Error('refused'); return fixture; } });
    await tick(); assert.equal(calls, 1);
    if (fail) {
      assert.match(root.textContent, /unavailable/);
      dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
      assert.match(root.textContent, /session expired/);
    } else assert.match(root.textContent, /Next Chapter/);
    panel.dispose(); assert.equal(root.textContent, '');
    panel.dispose(); dom.window.close();
  }
});

test('Home retains current demographic labels while excluding property metrics', async () => {
  const data = structuredClone(fixture);
  data.market.snapshot[0].label = 'Current population';
  const { root, panel, dom } = await open(data);
  assert.match(root.textContent, /Current population/);
  assert.doesNotMatch(root.textContent, /Candidate sites/);
  panel.dispose(); dom.window.close();
});
