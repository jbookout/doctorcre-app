import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { createFixtureClient } from '../js/fixture-client.js';

const methods = { 'unfinished-work': 'unfinishedWork', 'incident-board': 'incidentBoard',
  'governance-queue': 'governanceQueue', 'schedule-board': 'scheduleBoard',
  'current-work-item': 'currentWorkItem', 'current-work-requests': 'currentWorkRequests',
  'notification-feed': 'notificationFeed', 'deal-room-board': 'getBoard',
  'list-feature-switches': 'listFeatureSwitches', 'list-doc-suggestions': 'listDocSuggestions',
  'list-notifications': 'listNotifications', 'read-progress-board': 'readProgressBoard',
  'list-progress-boards': 'listProgressBoards' };

async function open(t, { width = 1440, theme = 'dark', touch = false } = {}) {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: touch, isMobile: touch });
  const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    calls.push(name);
    let payload = methods[name] ? await fixture[methods[name]](args) : {};
    if (name === 'unfinished-work') payload = { ...payload, items: [
      { kind: 'work_request', id: 'WR-000910', identity: { human_ref: 'WR-000910' }, state: 'in_progress', title: 'Synthetic first request', owner: 'joe' },
      { kind: 'work_request', id: 'WR-000911', identity: { human_ref: 'WR-000911' }, state: 'in_progress', title: 'Synthetic second request', owner: 'joe' },
    ] };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/{api/system-work/session,auth/session}', route => route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}}));
  await page.goto(`${server.origin}/control-room?mode=live&tab=queue`);
  await page.waitForFunction(() => document.querySelectorAll('#crQueueList [role="option"]').length === 2);
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  return { page, calls, errors };
}

for (const modifier of ['Meta', 'Control']) test(`${modifier}-K opens, filters, jumps and closes the command menu`, async t => {
  const { page, errors } = await open(t);
  await page.locator('#crQueueList').focus();
  await page.keyboard.press(`${modifier}+k`);
  const dialog = page.getByRole('dialog', { name: 'Control Room commands', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(node => node.matches(':modal')), true);
  const input = dialog.getByRole('combobox', { name: 'Find a command' });
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  assert.equal(await dialog.getByRole('option').count(), 17);
  assert.equal(await dialog.getByRole('option', { name: 'Go to Automations', exact: true }).count(), 1);
  await input.fill('waiting');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.search.includes('tab=waiting'));
  assert.equal(await dialog.isVisible(), false);
  await page.keyboard.press(`${modifier}+k`);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.locator('#tabWaiting').evaluate(node => node === document.activeElement), true);
  assert.deepEqual(errors, []);
});

for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
  test(`Escape dismisses searched commands in one press at ${width} ${theme}`, async t => {
    const { page } = await open(t, { width, theme, touch: width === 390 });
    const trigger = page.getByRole('button', { name: 'Open Control Room commands' });
    const dialog = page.getByRole('dialog', { name: 'Control Room commands', exact: true });
    for (const query of ['waiting', 'zzzz-no-command']) {
      await trigger.click();
      await dialog.getByRole('combobox').fill(query);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), false, `Escape must close after ${query}`);
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    }
  });

  test(`shortcut sheet separates tab jumps and omits list instructions at ${width} ${theme}`, async t => {
    const { page } = await open(t, { width, theme, touch: width === 390 });
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('footer').getByText('Select', { exact: false }).isVisible(), false);
    const tabs = dialog.getByRole('definition').filter({ hasText: /^g/ });
    assert.equal(await tabs.count(), 12);
    const heading = dialog.getByRole('heading', { name: 'Go to a tab', exact: true });
    assert.equal(await heading.isVisible(), true);
    assert.equal(await dialog.getByLabel('Go to a tab', { exact: true }).getByRole('definition').count(), 12);
    const spacing = await dialog.evaluate(node => {
      const header = node.querySelector('header').getBoundingClientRect();
      const intro = node.querySelector('[data-command-sheet] p').getBoundingClientRect();
      return intro.top - header.bottom;
    });
    assert.ok(spacing >= 16, `intro gap was ${spacing}px`);
    await dialog.getByRole('button', { name: 'Back to commands', exact: true }).click();
    assert.equal(await page.locator('#crCommands footer').getByText('Select', { exact: false }).isVisible(), width === 1440);
  });
}

test('j/k select Queue rows, Enter opens, and Escape restores list focus', async t => {
  const { page } = await open(t);
  await page.locator('#main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('j');
  assert.match(await page.locator('#crQueueList [aria-selected="true"]').textContent(), /first request/);
  await page.keyboard.press('j');
  assert.match(await page.locator('#crQueueList [aria-selected="true"]').textContent(), /second request/);
  await page.keyboard.press('k');
  assert.match(await page.locator('#crQueueList [aria-selected="true"]').textContent(), /first request/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#crWorkbench').dataset.detail === 'open');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#crWorkbench').getAttribute('data-detail'), 'closed');
  assert.match(await page.locator('#crQueueList [aria-selected="true"]').textContent(), /first request/);
  assert.equal(await page.locator('#crQueueList').evaluate(node => node === document.activeElement), true);
});

test('g sequences jump to tabs, ? explains shortcuts, and typing stays untouched', async t => {
  const { page } = await open(t);
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await page.waitForFunction(() => location.search.includes('tab=inbox'));
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await page.waitForFunction(() => location.search.includes('tab=approvals'));
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await sheet.waitFor();
  assert.match(await sheet.textContent(), /Move selection/);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await sheet.evaluate(node => node.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open Control Room commands' }).click();
  const input = page.getByRole('combobox', { name: 'Find a command' });
  await input.fill('gij?k');
  assert.equal(await input.inputValue(), 'gij?k');
  assert.match(page.url(), /tab=approvals/);
  await page.keyboard.press('Escape');
});

test('every tab is reachable, modal focus stays contained, and navigation introduces no writes', async t => {
  const { page, calls, errors } = await open(t);
  const tabs = await page.locator('#controlRoomTabs [role="tab"]').evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.tabKey, label: node.querySelector('.cr-nav-label').textContent })));
  for (const tab of tabs) {
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Find a command' }).fill(tab.label);
    await page.getByRole('option', { name: `Go to ${tab.label}`, exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('tab'), tab.key);
  }
  await page.keyboard.press('g'); await page.keyboard.press('q');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Control Room commands', exact: true });
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, await page.evaluate(() => document.activeElement.tagName));
  }
  await page.getByRole('button', { name: 'Close commands', exact: true }).focus();
  await page.keyboard.press('Control+i');
  assert.equal(await page.locator('#crWorkbench').getAttribute('data-detail'), 'closed');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+d');
  await page.locator('dialog[open]').waitFor();
  assert.equal(await page.locator('#crCommands').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.deepEqual(calls.filter(name => /^(?:add|set|change|delete|close|send|approve|reject|accept|start|run)-/.test(name)), []);
  assert.deepEqual(errors, []);
});

test('touch phone exposes Commands and hides keyboard hints', async t => {
  const { page } = await open(t, { width: 390, touch: true });
  const button = page.getByRole('button', { name: 'Open Control Room commands' });
  assert.equal(await button.isVisible(), true);
  assert.equal(await button.locator('kbd').isVisible(), false);
  await button.click();
  await page.getByRole('dialog', { name: 'Control Room commands', exact: true }).waitFor();
  await page.getByRole('option', { name: 'Go to Inbox', exact: true }).click();
  await page.waitForFunction(() => location.search.includes('tab=inbox'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

if (process.env.C4_CAPTURE) for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
  test(`capture ${width} ${theme}`, async t => {
    const { page } = await open(t, { width, theme, touch: width === 390 });
    const directory = `/tmp/c4-review-artifacts/${process.env.C4_CAPTURE}`;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/queue-${width}-${theme}.png` });
    if (process.env.C4_CAPTURE === 'before') return;
    await page.getByRole('button', { name: 'Open Control Room commands' }).click();
    await page.screenshot({ path: `${directory}/commands-${width}-${theme}.png` });
    await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await page.screenshot({ path: `${directory}/shortcuts-${width}-${theme}.png` });
  });
}
