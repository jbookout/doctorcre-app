import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';

async function fixture(t) {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));
  });
  await page.route('**/ideas-events', async route => {
    const response = await route.fetch();
    const secured = await handleDoctorcreRequest(new Request(`${server.origin}/ideas-events`), { ASSETS: { fetch: async () => new Response('') } });
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': secured.headers.get('content-security-policy') } });
  });
  await page.goto(`${server.origin}/ideas-events`);
  await page.evaluate(async () => {
    const { mountZoomableWorkspace } = await import('/js/ui.generated.js');
    document.body.innerHTML = '<main id="original"><section id="deals"><label>Draft<input id="draft"></label><button id="act">Act</button></section><section id="today">Today content<button id="today-action">Today action</button></section></main><div id="workspace"></div>';
    document.getElementById('workspace').style.height = '600px';
    const tabs = (id, panels) => ({ kind: 'tabs', id, panels, active: panels[0] });
    const layout = { version: 1, stage: { kind: 'split', id: 'columns', axis: 'horizontal', ratio: 0.7,
      first: tabs('main', ['deals']), second: tabs('aside', ['today']) } };
    const panels = ['deals', 'today'].map(id => ({ id, title: id === 'deals' ? 'Deals' : 'Today', node: document.getElementById(id) }));
    window.zoomFixture = { layout, deals: panels[0].node, actions: 0,
      shell: mountZoomableWorkspace({ container: document.getElementById('workspace'), panels, layout }) };
    document.getElementById('act').addEventListener('click', () => window.zoomFixture.actions++);
  });
  await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.endsWith('/css/workspace-zoom.css')));
  return page;
}

const group = (page, id) => page.getByRole('region', { name: `Workspace panel group ${id}`, exact: true });

test('group zoom fills the stage and Escape restores proportions without replacing drafts or focus', async t => {
  const page = await fixture(t);
  const original = await group(page, 'main').boundingBox();
  await page.locator('#draft').fill('Keep this unsaved draft');
  await page.locator('#draft').evaluate(input => {
    input.focus(); input.setSelectionRange(2, 7);
    window.zoomBlurs = 0;
    input.addEventListener('blur', () => window.zoomBlurs++);
  });
  await group(page, 'main').locator('.workspace-tabs').evaluate(tabs => tabs.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  const zoomed = await group(page, 'main').boundingBox();
  assert.ok(zoomed.width > original.width + 100);
  assert.equal(await group(page, 'aside').isVisible(), false);
  assert.deepEqual(await page.locator('#draft').evaluate(input => ({ focused: input === document.activeElement, start: input.selectionStart, end: input.selectionEnd, blurs: window.zoomBlurs })), { focused: true, start: 2, end: 7, blurs: 0 });
  await page.keyboard.press('Escape');
  assert.deepEqual(await group(page, 'main').boundingBox(), original);
  assert.equal(await group(page, 'aside').isVisible(), true);
  assert.equal(await page.locator('#draft').inputValue(), 'Keep this unsaved draft');
  assert.equal(await page.locator('#deals').evaluate(node => node === window.zoomFixture.deals), true);
  await page.getByRole('button', { name: 'Act', exact: true }).click();
  assert.equal(await page.evaluate(() => window.zoomFixture.actions), 1);
  await page.getByRole('button', { name: 'Zoom Deals group', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await group(page, 'aside').isVisible(), false);
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#today-action').evaluate(node => node === document.activeElement), false);
  }
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click();
  assert.deepEqual(await group(page, 'main').boundingBox(), original);
  await mkdir('out/test-artifacts/workspace-zoom', { recursive: true });
  await page.getByRole('button', { name: 'Zoom Deals group', exact: true }).click();
  await page.screenshot({ path: 'out/test-artifacts/workspace-zoom/group.png' });
  assert.deepEqual(await page.evaluate(() => window.cspViolations), []);
});
test('layout updates and disposal retain the live panels and clear a removed zoom target', async t => {
  const page = await fixture(t);
  await page.getByRole('button', { name: 'Zoom Deals group', exact: true }).click();
  await page.evaluate(() => {
    const { shell, layout } = window.zoomFixture;
    shell.update({ ...layout, stage: { ...layout.stage, ratio: 0.4 } });
  });
  assert.equal(await group(page, 'aside').isVisible(), false);
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click();
  const [first, second] = await page.locator('.workspace-group').evaluateAll(groups => groups.map(group => group.getBoundingClientRect().width));
  assert.ok(Math.abs(first / (first + second) - 0.4) < 0.01);
  await page.getByRole('button', { name: 'Zoom Deals group', exact: true }).click();
  await page.evaluate(() => window.zoomFixture.shell.update({ version: 1, stage: window.zoomFixture.layout.stage.second }));
  assert.equal(await page.getByRole('button', { name: 'Return to workspace', exact: true }).count(), 0);
  assert.equal(await group(page, 'aside').isVisible(), true);
  await page.evaluate(() => window.zoomFixture.shell.unmount());
  assert.deepEqual(await page.locator('#original > section').evaluateAll(nodes => nodes.map(node => node.id)), ['deals', 'today']);
  assert.equal(await page.locator('#workspace > *').count(), 0);
  assert.equal(await page.locator('link[href="/css/workspace-zoom.css"]').count(), 0);
});

for (const actor of ['joe', 'dell']) test(`${actor} can double click a visible tab bar and use keyboard zoom in the flagged desktop app`, async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const theme = actor === 'joe' ? 'light' : 'dark';
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  await page.goto(`${server.origin}/ideas-events?actor=${actor}&ui=react`);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  await page.locator('#ideaState:not([data-state="loading"])').waitFor({ state: 'attached' });
  const main = group(page, 'main-group');
  await main.waitFor();
  const initial = await main.boundingBox();
  await main.locator('.workspace-tabs').dblclick();
  assert.ok((await main.boundingBox()).width > initial.width + 100);
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.deepEqual(await main.boundingBox(), initial);
  await page.getByRole('button', { name: 'Zoom Today group', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await main.isVisible(), false);
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click();
  assert.equal(await main.isVisible(), true);
  await page.getByRole('button', { name: 'Zoom Page group', exact: true }).click();
  await page.screenshot({ path: `out/test-artifacts/workspace-zoom/app-${actor}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#appLayout .workspace-shell').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('group', { name: 'Zoom workspace groups' }).count(), 0);
  assert.equal(await page.locator('#appLayout .app-layout-center #ideasPanel').count(), 1);
});
test('Escape closes an active panel dialog before returning from group zoom', async t => {
  const page = await fixture(t);
  await page.getByRole('button', { name: 'Zoom Deals group', exact: true }).click();
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<label>Dialog draft<input></label>';
    document.getElementById('deals').append(dialog);
    dialog.showModal();
  });
  await page.getByRole('textbox', { name: 'Dialog draft' }).fill('Dialog unsaved draft');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').isVisible(), false);
  assert.equal(await group(page, 'aside').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Return to workspace', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await group(page, 'aside').isVisible(), true);
});
