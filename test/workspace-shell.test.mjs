import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { mkdir } from 'node:fs/promises';
import { handleDoctorcreRequest } from '../src/worker.js';

const tabs = (id, panels, active = panels[0]) => ({ kind: 'tabs', id, panels, active });
const initial = () => ({ version: 1, stage: tabs('main', ['deals', 'leads']) });

async function fixture(t) {
  const dom = new JSDOM('<main id="original"><section id="deals"><input id="draft"><button id="act">Act</button></section><section id="leads">Leads content</section></main><div id="workspace"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const ui = await import(`../js/ui.generated.js?workspace=${Math.random()}`);
  let shell;
  t.after(() => { shell?.unmount(); dom.window.close(); delete globalThis.window; delete globalThis.document; });
  const document = dom.window.document;
  const container = document.getElementById('workspace');
  const panels = ['deals', 'leads'].map(id => ({ id, title: id === 'deals' ? 'Deals' : 'Leads', node: document.getElementById(id) }));
  return { document, panels, mount: (layout, supplied = panels) => shell = ui.mountWorkspace({ container, panels: supplied, layout }) };
}

test('workspace tabs show the original selected panel and retain drafts and listeners', async t => {
  const { document, panels, mount } = await fixture(t);
  const deals = panels[0].node;
  const input = deals.querySelector('input');
  input.value = 'Keep this unsaved draft';
  let actions = 0;
  deals.querySelector('button').addEventListener('click', () => actions++);
  const shell = mount(initial());
  assert.equal(document.getElementById('deals'), deals);
  assert.equal(deals.hidden, false);
  assert.equal(panels[1].node.hidden, true);
  const buttons = [...document.querySelectorAll('#workspace [aria-pressed]')];
  assert.equal(buttons[0].textContent, 'Deals');
  buttons[1].click();
  assert.equal(deals.hidden, true);
  assert.equal(panels[1].node.hidden, false);
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');
  buttons[0].click();
  assert.equal(input.value, 'Keep this unsaved draft');
  deals.querySelector('button').click();
  assert.equal(actions, 1);
});

test('moves and split collapse keep the focused draft, then disposal restores original placement and visibility', async t => {
  const { document, panels, mount } = await fixture(t);
  panels[1].node.hidden = true;
  const shell = mount(initial());
  const draft = document.getElementById('draft');
  draft.value = 'Still typing';
  draft.focus();
  draft.setSelectionRange(2, 7);
  shell.update({ version: 1, stage: { kind: 'split', id: 'columns', axis: 'horizontal', ratio: 0.7,
    first: tabs('main', ['leads']), second: tabs('aside', ['deals']) } });
  assert.equal(document.activeElement, draft);
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [2, 7]);
  assert.equal(document.getElementById('deals'), panels[0].node);
  shell.update({ version: 1, stage: tabs('aside', ['deals', 'leads']) });
  assert.equal(document.activeElement, draft);
  assert.equal(draft.value, 'Still typing');
  shell.update({ version: 1, stage: null });
  assert.equal(panels[0].node.isConnected, true);
  assert.equal(panels[0].node.hidden, true);
  assert.match(document.getElementById('workspace').textContent, /No panels open/);
  shell.update(initial());
  assert.equal(document.getElementById('deals'), panels[0].node);
  draft.focus();
  shell.unmount();
  assert.deepEqual([...document.getElementById('original').children], panels.map(panel => panel.node));
  assert.equal(panels[0].node.hidden, false);
  assert.equal(panels[1].node.hidden, true);
  assert.equal(document.getElementById('workspace').childNodes.length, 0);
  assert.equal(document.activeElement, draft);
  assert.equal(document.querySelector('link[href="/css/workspace-shell.css"]'), null);
  shell.unmount();
  assert.throws(() => shell.update(initial()), /unmounted/);
});

test('invalid registry, unknown panels and malformed layouts fail before changing the page', async t => {
  const { document, panels, mount } = await fixture(t);
  const original = document.getElementById('original');
  const source = original.innerHTML;
  for (const registry of [
    [panels[0], panels[0]],
    [panels[0], { ...panels[1], node: panels[0].node }],
    [panels[0], { id: 'draft', title: 'Draft', node: document.getElementById('draft') }],
    [{ id: 'outer', title: 'Outer', node: document.body }],
  ]) {
    assert.throws(() => mount(initial(), registry));
    assert.equal(original.innerHTML, source);
  }
  assert.throws(() => mount({ version: 1, stage: tabs('main', ['unknown']) }));
  assert.equal(original.innerHTML, source);
  const container = document.getElementById('workspace');
  container.remove();
  assert.throws(() => mount(initial()));
  document.body.append(container);
  assert.equal(original.innerHTML, source);
  const shell = mount(initial());
  const before = document.getElementById('workspace').innerHTML;
  for (const layout of [{ version: 2, stage: null }, { version: 1, stage: tabs('main', ['unknown']) },
    { version: 1, stage: tabs('main', ['deals', 'deals']) }]) {
    assert.throws(() => shell.update(layout));
    assert.equal(document.getElementById('workspace').innerHTML, before);
  }
});

test('selecting a tab preserves the untouched group scroll and fires no input blur', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/ideas-events`);
  await page.evaluate(async () => {
    const { mountWorkspace } = await import('/js/ui.generated.js');
    document.body.innerHTML = '<main><section id="deals">Deals</section><section id="leads">Leads</section><section id="today"><input aria-label="Untouched draft"><div style="height:1800px">Today</div></section><div id="workspace" style="display:flex;height:400px"></div></main>';
    const panels = ['deals', 'leads', 'today'].map(id => ({ id, title: id, node: document.getElementById(id) }));
    const tabs = (id, panels) => ({ kind: 'tabs', id, panels, active: panels[0] });
    window.workspaceFixture = { shell: mountWorkspace({ container: document.getElementById('workspace'), panels,
      layout: { version: 1, stage: { kind: 'split', id: 'columns', axis: 'horizontal', ratio: 0.5,
        first: tabs('main', ['deals', 'leads']), second: tabs('aside', ['today']) } } }) };
  });
  await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.endsWith('/css/workspace-shell.css')));
  assert.equal(await page.getByRole('region', { name: 'Workspace panel group main', exact: true }).count(), 1);
  assert.equal(await page.getByRole('region', { name: 'Workspace panel group aside', exact: true }).count(), 1);
  await page.getByRole('textbox', { name: 'Untouched draft' }).fill('Keep typing');
  await page.getByRole('textbox', { name: 'Untouched draft' }).evaluate(input => {
    window.workspaceBlurs = 0;
    input.addEventListener('blur', () => window.workspaceBlurs++);
    input.parentElement.parentElement.scrollTop = 120;
  });
  const state = () => page.getByRole('textbox', { name: 'Untouched draft' }).evaluate(input => ({
    scrollTop: input.parentElement.parentElement.scrollTop, blurs: window.workspaceBlurs,
    focused: document.activeElement === input, draft: input.value,
  }));
  const before = await state();
  assert.deepEqual(before, { scrollTop: 120, blurs: 0, focused: true, draft: 'Keep typing' });
  // DOM activation isolates render-induced blur from a pointer's normal focus transfer.
  await page.getByRole('button', { name: 'leads', exact: true }).evaluate(button => button.click());
  assert.equal(await page.locator('#leads').isVisible(), true);
  assert.deepEqual(await state(), before);
  await page.evaluate(() => window.workspaceFixture.shell.unmount());
});

for (const width of [390, 1280]) test(`stage layout keeps live panels through selection, movement and resize under CSP at ${width}px`, async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));
  });
  await page.route('**/ideas-events', async route => {
    const response = await route.fetch();
    const secured = await handleDoctorcreRequest(new Request(`${server.origin}/css/workspace-shell.css`), { ASSETS: { fetch: async () => new Response('') } });
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': secured.headers.get('content-security-policy') }, body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><title>Workspace fixture</title><main id="original"><section id="deals"><label>Draft<input id="draft"></label><button id="act">Act</button></section><section id="leads">Leads content</section><section id="today">Today content</section></main><div id="workspace"></div>' });
  });
  const response = await page.goto(`${server.origin}/ideas-events`);
  assert.match(response.headers()['content-security-policy'], /style-src 'self' https:\/\/fonts.googleapis.com/);
  await page.evaluate(async () => {
    const { mountWorkspace } = await import('/js/ui.generated.js');
    const container = document.getElementById('workspace');
    container.style.display = 'flex'; container.style.height = '600px';
    const panels = ['deals', 'leads', 'today'].map(id => ({ id, title: id === 'deals' ? 'Deals' : id === 'leads' ? 'Leads' : 'Today', node: document.getElementById(id) }));
    const deals = panels[0].node;
    let actions = 0;
    deals.querySelector('button').addEventListener('click', () => actions++);
    const tabs = (id, ids, active = ids[0]) => ({ kind: 'tabs', id, panels: ids, active });
    const layout = axis => ({ version: 1, stage: { kind: 'split', id: 'columns', axis, ratio: axis === 'horizontal' ? 0.7 : 0.25,
      first: tabs('main', ['deals', 'leads']), second: tabs('aside', ['today']) } });
    const shell = mountWorkspace({ container, panels, layout: layout('horizontal') });
    window.workspaceFixture = { shell, deals, get actions() { return actions; }, layout, tabs };
  });
  await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.endsWith('/css/workspace-shell.css')));
  const ratio = async axis => page.locator('.workspace-shell > .workspace-split > .workspace-branch').evaluateAll((branches, axis) => {
    const [first, second] = branches.map(node => node.getBoundingClientRect());
    return axis === 'horizontal' ? first.width / (first.width + second.width) : first.height / (first.height + second.height);
  }, axis);
  assert.ok(Math.abs(await ratio('horizontal') - 0.7) < 0.01);
  await page.getByRole('button', { name: 'Leads', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#deals').isVisible(), false);
  assert.equal(await page.locator('#leads').isVisible(), true);
  await page.getByRole('button', { name: 'Deals', exact: true }).click();
  await page.locator('#draft').fill('A synthetic unsaved draft');
  await page.locator('#draft').focus();
  await page.evaluate(() => {
    const { shell, tabs } = window.workspaceFixture;
    shell.update({ version: 1, stage: { kind: 'split', id: 'rows', axis: 'vertical', ratio: 0.25,
      first: tabs('main', ['leads']), second: tabs('aside', ['today', 'deals'], 'deals') } });
  });
  assert.ok(Math.abs(await ratio('vertical') - 0.25) < 0.01);
  assert.equal(await page.locator('#draft').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#draft').inputValue(), 'A synthetic unsaved draft');
  assert.equal(await page.locator('#deals').evaluate(node => node === window.workspaceFixture.deals), true);
  await page.getByRole('button', { name: 'Act', exact: true }).click();
  assert.equal(await page.evaluate(() => window.workspaceFixture.actions), 1);
  assert.equal(await page.locator('#deals, #leads, #today').count(), 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/workspace-shell', { recursive: true });
  await page.screenshot({ path: `out/test-artifacts/workspace-shell/stage-${width}.png` });
  await page.evaluate(() => window.workspaceFixture.shell.unmount());
  assert.deepEqual(await page.locator('#original > section').evaluateAll(nodes => nodes.map(node => node.id)), ['deals', 'leads', 'today']);
  assert.equal(await page.locator('#workspace > *').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
});
