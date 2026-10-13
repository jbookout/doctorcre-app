// Workspace slice S1: the React node host moves a page's original node into a
// React-managed container. Nothing is cloned or re-rendered, so identity,
// listeners, drafts and ids survive the move ("nothing reloads when it moves").
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { chromium, fixtureServer } from './browser-harness.mjs';

const UI_BUNDLE = '/js/ui.generated.js';

async function hostInDom() {
  const dom = new JSDOM('<main id="slot"><p id="before"></p><section id="panel"><input id="draft"><button id="act">Act</button></section><p id="after"></p></main>');
  // React DOM reads the browser globals when its module evaluates.
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { hostNode } = await import(`../js/ui.generated.js?jsdom=${Math.random()}`);
  return { document: dom.window.document, hostNode, close: () => dom.window.close() };
}

test('the host moves the original node: same object, listener, draft and id', async t => {
  const { document, hostNode, close } = await hostInDom();
  t.after(() => { close(); delete globalThis.window; delete globalThis.document; });
  const panel = document.getElementById('panel');
  let clicks = 0;
  panel.querySelector('#act').addEventListener('click', () => clicks++);
  panel.querySelector('#draft').value = 'unsaved draft';

  const root = hostNode(panel);

  const host = document.querySelector('[data-node-host]');
  assert.ok(host, 'the React container is mounted');
  assert.equal(host.firstElementChild, panel, 'the hosted node is the original object, not a copy');
  assert.equal(document.getElementById('panel'), panel);
  assert.equal(document.querySelectorAll('#panel, #draft, #act').length, 3, 'no duplicate ids');
  assert.equal(panel.querySelector('#draft').value, 'unsaved draft', 'the draft survives the move');
  panel.querySelector('#act').click();
  assert.equal(clicks, 1, 'the listener bound before the move still fires');
  assert.equal(host.closest('#slot'), document.getElementById('slot'), 'the host stands where the node stood');

  root.unmount();
  assert.equal(document.querySelector('[data-node-host]'), null);
  assert.equal(document.getElementById('before').nextElementSibling?.nextElementSibling, panel, 'unmount puts the node back in place');
  assert.equal(panel.nextElementSibling, document.getElementById('after'));
  panel.querySelector('#act').click();
  assert.equal(clicks, 2);
});

async function openIdeas(t, search) {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const bundleRequests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === UI_BUNDLE) bundleRequests.push(request.url()); });
  await page.goto(`${server.origin}/ideas-events${search}`);
  // The idea read has settled once the state block leaves loading.
  await page.locator('#ideaState:not([data-state="loading"])').waitFor({ state: 'attached' });
  return { page, bundleRequests };
}

test('with ?ui=react the Ideas page hosts its original panel in React and its listeners still answer', async t => {
  const { page, bundleRequests } = await openIdeas(t, '?ui=react');
  await page.locator('#appMainSlot [data-node-host] > #ideasPanel').waitFor();
  assert.equal(bundleRequests.length, 1);
  assert.equal(await page.locator('#ideasPanel').count(), 1);
  // ideas.js wired #ideaSearch before the move; its listener writes the address.
  await page.fill('#ideaSearch', 'zz-no-such-idea');
  await page.waitForURL(/q=zz-no-such-idea/);
});

test('without the flag the Ideas page never loads React and keeps its panel in place', async t => {
  const { page, bundleRequests } = await openIdeas(t, '');
  assert.equal(await page.locator('[data-node-host]').count(), 0);
  assert.equal(await page.locator('#main > #ideasPanel').count(), 1);
  assert.deepEqual(bundleRequests, []);
});
