import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { readFileSync } from 'node:fs';
import { relationshipNetworkFixture } from '../js/relationship-network-fixture.js';
import { createLiveClient } from '../js/live-client.js';
import { validNetwork } from '../js/relationship-network-model.js';
const boardContract = JSON.parse(readFileSync(new URL('../contracts/carr-interface.v1/mcp_read_contracts/deal-room-board.json', import.meta.url)));
const transportBoard = {
  schema_version: boardContract.response.schema_version,
  actor: 'joe',
  deals: [{ id: 'switcher-deal', name: 'Transport Deal', phase: 'research', type: 'relocation',
    open_actions: [{ id: 'switcher-task', item_id: 'next_action:33333333-3333-4333-8333-333333333333', owner: 'joe', description: 'Transport Task', due_on: null }] }],
  closed_deals: [], lost_deals: [],
};
assert.deepEqual(Object.keys(transportBoard.deals[0].open_actions[0]).sort(), [...boardContract.response.open_actions.item_keys].sort());
const transportNetwork = relationshipNetworkFixture();
assert.equal(validNetwork(transportNetwork), true);
const contact = transportNetwork.nodes.find(node => node.kind === 'client');

const server = await startFixtureServer();
test.after(() => server.stop());
const board = { deals: [{ id: 'd1', name: 'Valid Deal', open_actions: [{ id: 't1', item_id: 'next_action:33333333-3333-4333-8333-333333333333', description: 'Valid Task' }] }] };
const network = { nodes: [{ id: 'party:c1', name: 'Valid Contact', kind: 'contact' }] };
async function open(page, payload, mode = 'resolved') {
  await page.evaluate(async ({ payload, mode }) => {
    const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
    window.readCount = 0;
    openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Calendar', href: '/calendar' }, { label: 'Deals', href: '/deals' }], read: () => {
      window.readCount++;
      if (mode === 'held') return new Promise(resolve => { window.finishRead = resolve; });
      if (mode === 'rejected') return Promise.reject(Error('Unavailable'));
      return Promise.resolve(window.nextPayload ?? payload);
    } });
  }, { payload, mode });
  await page.getByRole('combobox').waitFor();
}
for (const [name, payload, message, labels] of [
  ['partial-board', { board, network: { nodes: null } }, 'Contacts unavailable. Deals, tasks and pages are still available.', ['Valid DealDeal', 'Valid Task · Valid DealTask']],
  ['partial-contacts', { board: null, network }, 'Deals and tasks unavailable. Contacts and pages are still available.', ['Valid ContactContact']],
  ['pages-only', { board: null, network: null }, 'Deals and contacts unavailable. Pages are still available.', []],
  ['full', { board, network }, null, ['Valid DealDeal', 'Valid Task · Valid DealTask', 'Valid ContactContact']],
  ['malformed contact rejects whole section', { board, network: { nodes: [...network.nodes, { name: 'No identity', kind: 'contact' }] } }, 'Contacts unavailable. Deals, tasks and pages are still available.', ['Valid DealDeal', 'Valid Task · Valid DealTask']],
  ['malformed board rejects whole section', { board: { deals: [...board.deals, { name: 'No identity' }] }, network }, 'Deals and tasks unavailable. Contacts and pages are still available.', ['Valid ContactContact']],
  ['task without producer item_id never guesses a card', { board: { deals: [{ ...board.deals[0], open_actions: [{ id: '33333333-3333-4333-8333-333333333333', description: 'No canonical identity' }] }] }, network }, 'Deals and tasks unavailable. Contacts and pages are still available.', ['Valid ContactContact']],
  ['malformed task rejects whole board', { board: { deals: [{ ...board.deals[0], open_actions: [{ description: 'No identity' }] }] }, network }, 'Deals and tasks unavailable. Contacts and pages are still available.', ['Valid ContactContact']],
]) test(name, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await open(page, payload);
    if (message) await page.getByRole('status').filter({ hasText: message }).waitFor({ timeout: 2500 });
    else await page.getByRole('status').filter({ hasText: '2 destinations' }).waitFor();
    await page.getByRole('combobox').fill('Valid');
    assert.deepEqual(await page.getByRole('option').allTextContents(), labels);
    await page.getByRole('combobox').press('Escape');
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
  } finally { await browser.close(); }
});

for (const [name, payload] of [
  ['partial-board', { board, network: null }],
  ['partial-contacts', { board: null, network }],
  ['pages-only', { board: null, network: null }],
]) test(`Retry from ${name} intersects recents and session invalidation clears records`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(() => sessionStorage.setItem('doctorcre.quick-switcher.recents.v1', JSON.stringify(['deal:d1', 'party:c1', 'deal:forbidden'])));
    await open(page, payload);
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const labels = await page.getByRole('option').allTextContents();
    assert.equal(labels.includes('Valid DealDeal'), payload.board !== null);
    assert.equal(labels.includes('Valid ContactContact'), payload.network !== null);
    assert.equal(labels.some(label => label.includes('forbidden')), false);
    await page.evaluate(payload => { window.nextPayload = payload; }, { board, network });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    assert.equal(await page.evaluate(() => window.readCount), 2);
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('combobox').fill('Valid');
    assert.equal(await page.getByRole('option').count(), 3);
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
  } finally { await browser.close(); }
});
for (const close of ['Escape', 'invalidate']) test(`late completion after ${close} cannot publish or write history`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/deals?deal=d1', route => route.fulfill({ contentType: 'text/html', body: '<button class="quick-switcher-toggle">Quick switcher</button>' }));
    await page.goto(`${server.url}/deals?deal=d1`);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(() => sessionStorage.clear());
    await open(page, null, 'held');
    if (close === 'Escape') await page.getByRole('combobox').press('Escape');
    else await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    await page.evaluate(payload => window.finishRead(payload), { board, network: null });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
  } finally { await browser.close(); }
});
test('read rejection retries into full results and selection follows current results', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(async () => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      let count = 0;
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Valid Page', href: '/calendar' }], read: () => ++count === 1 ? Promise.reject(Error('Unavailable')) : new Promise(resolve => { window.finishRead = resolve; }) });
    });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Loading accessible items' }).waitFor();
    await page.getByRole('combobox').fill('Valid');
    await page.evaluate(payload => window.finishRead(payload), { board, network });
    await page.getByRole('option', { name: 'Valid Deal Deal', exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox').getAttribute('aria-activedescendant'), 'quick-option-0');
    await page.getByRole('combobox').press('ArrowDown');
    await page.getByRole('combobox').fill('Valid Contact');
    await page.getByRole('combobox').press('Enter');
    await page.waitForURL('**/relationships?node=party%3Ac1');
  } finally { await browser.close(); }
});

for (const theme of ['light', 'dark']) for (const width of [390, 1440]) test(`partial results visible in ${theme} at ${width}px`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await open(page, { board, network: null });
    await page.getByRole('combobox').fill('Valid');
    await page.getByRole('option', { name: 'Valid Deal Deal', exact: true }).waitFor();
    const bounds = await page.locator('[data-quick-switcher]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    mkdirSync('out/test-artifacts/quick-switcher-partial-read', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/quick-switcher-partial-read/${theme}-${width}.png` });
  } finally { await browser.close(); }
});

test('shell fixtures match pinned contracts through the production adapter', async () => {
  const client = createLiveClient({ fetchImpl: async path => new Response(JSON.stringify(path === '/mcp'
    ? { result: { content: [{ type: 'text', text: JSON.stringify(transportBoard) }] } }
    : transportNetwork)) });
  const admittedBoard = await client.getBoard();
  assert.equal(admittedBoard.schema_version, boardContract.response.schema_version);
  assert.equal(admittedBoard.deals[0].id, transportBoard.deals[0].id);
  assert.equal(admittedBoard.deals[0].name, transportBoard.deals[0].name);
  assert.deepEqual(admittedBoard.deals[0].open_actions, transportBoard.deals[0].open_actions);
  assert.equal(validNetwork(await client.getRelationshipNetwork()), true);
});

async function shell(page, modes = {}) {
  const reads = { board: 0, contacts: 0 };
  const held = {};
  let active = false;
  let started;
  const bothStarted = new Promise(resolve => { started = resolve; });
  let initialBoard;
  const initialBoardRead = new Promise(resolve => { initialBoard = resolve; });
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-switcher-session' } }));
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'synthetic_unavailable' } }));
  const respond = async (route, source, payload) => {
    if (!active) {
      await route.fulfill({ json: payload });
      if (source === 'board') initialBoard();
      return;
    }
    reads[source]++;
    if (reads.board && reads.contacts) started();
    const mode = modes[source];
    if (mode === 'held' || mode === 'timeout') { held[source] = () => route.fulfill({ json: payload }); return; }
    if (mode === 'network') return route.abort('failed');
    if (mode === 'http' || mode === 'denied') return route.fulfill({ status: mode === 'denied' ? 401 : 503, json: { error: 'synthetic_unavailable' } });
    return route.fulfill({ json: payload });
  };
  await page.route('**/api/v1/business/relationships?contract=relationship-network.v1', route => respond(route, 'contacts', modes.contacts === 'malformed' ? { nodes: null } : transportNetwork));
  await page.route('**/mcp', route => {
    const request = route.request().postDataJSON();
    if (request.params?.name !== 'deal-room-board') return route.fulfill({ status: 503, json: { error: 'synthetic_unavailable' } });
    const payload = modes.board === 'malformed' ? { deals: null } : modes.board === 'empty' ? { ...transportBoard, deals: [] } : transportBoard;
    return respond(route, 'board', { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  });
  await page.goto(`${server.url}/search?mode=live`);
  await initialBoardRead;
  active = true;
  await page.getByRole('button', { name: 'Quick switcher' }).click();
  await page.getByRole('combobox').waitFor();
  await bothStarted;
  return { reads, held };
}
const messages = {
  board: 'Contacts unavailable. Deals, tasks and pages are still available.',
  contacts: 'Deals and tasks unavailable. Contacts and pages are still available.',
  none: 'Deals and contacts unavailable. Pages are still available.',
};
async function status(page, message) {
  await page.locator('[data-quick-switcher] [role="status"]').filter({ hasText: message }).waitFor({ timeout: 15000 });
}
for (const failed of ['contacts', 'board']) for (const failure of ['http', 'network', 'timeout', 'malformed']) test(`shell preserves ${failed === 'contacts' ? 'deal and task' : 'contact'} results when ${failed} ${failure}`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const { reads } = await shell(page, { [failed]: failure });
    await status(page, messages[failed === 'contacts' ? 'board' : 'contacts']);
    const input = page.getByRole('combobox');
    await input.fill(failed === 'contacts' ? 'Transport' : contact.name);
    assert.equal(await page.getByRole('option').count(), failed === 'contacts' ? 2 : 1);
    await page.getByRole('button', { name: failed === 'contacts' ? 'Tasks' : 'Contacts', exact: true }).click();
    assert.equal(await page.getByRole('option').count(), 1);
    assert.deepEqual(reads, { board: 1, contacts: 1 });
    await input.fill('Calendar');
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    await page.getByRole('option', { name: 'Calendar Page', exact: true }).waitFor();
  } finally { await browser.close(); }
});

for (const first of ['board', 'contacts']) test(`shell full source reads run in parallel, ${first} finishes first`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const { reads, held } = await shell(page, { board: 'held', contacts: 'held' });
    assert.deepEqual(reads, { board: 1, contacts: 1 });
    await held[first]();
    await status(page, 'Loading accessible items');
    await held[first === 'board' ? 'contacts' : 'board']();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('combobox').fill('Transport');
    await page.getByRole('option', { name: 'Transport Deal Deal', exact: true }).waitFor();
    await page.getByRole('combobox').fill(contact.name);
    await page.getByRole('option', { name: `${contact.name} Contact`, exact: true }).waitFor();
  } finally { await browser.close(); }
});

test('shell keeps pages and Retry when both sources fail, empty is successful', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const modes = { board: 'http', contacts: 'network' };
    const { reads } = await shell(page, modes);
    await status(page, messages.none);
    await page.getByRole('option', { name: 'Calendar Page', exact: true }).waitFor();
    modes.board = 'empty';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await status(page, messages.board);
    assert.deepEqual(reads, { board: 2, contacts: 2 });
  } finally { await browser.close(); }
});

test('shell Retry replaces partial results with current results and removes inaccessible recents', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const modes = { contacts: 'http' };
    const { reads, held } = await shell(page, modes);
    await status(page, messages.board);
    await page.evaluate(() => sessionStorage.setItem('doctorcre.quick-switcher.recents.v1', JSON.stringify(['deal:switcher-deal'])));
    await page.getByRole('combobox').fill('Transport');
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    mkdirSync('out/test-artifacts/quick-switcher-partial-transport', { recursive: true });
    await page.screenshot({ path: 'out/test-artifacts/quick-switcher-partial-transport/before-retry.png' });
    modes.contacts = 'held';
    const requested = page.waitForRequest('**/api/v1/business/relationships?contract=relationship-network.v1');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await requested;
    await status(page, 'Loading accessible items');
    assert.equal(await page.getByRole('option').count(), 0);
    assert.equal(await page.getByRole('combobox').inputValue(), 'Transport');
    assert.equal(await page.getByRole('button', { name: 'Tasks', exact: true }).getAttribute('aria-pressed'), 'true');
    await held.contacts();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('option', { name: 'Transport Task · Transport Deal Task', exact: true }).waitFor();
    assert.deepEqual(reads, { board: 2, contacts: 2 });
    await page.screenshot({ path: 'out/test-artifacts/quick-switcher-partial-transport/after-retry.png' });
    await page.getByRole('combobox').press('Escape');
    modes.board = 'http';
    modes.contacts = undefined;
    await page.getByRole('button', { name: 'Quick switcher' }).click();
    await status(page, messages.contacts);
    assert.equal(await page.getByRole('option', { name: 'Transport Deal Deal', exact: true }).count(), 0);
    await page.getByRole('combobox').fill('Transport');
    assert.equal(await page.getByRole('option').count(), 0);
    await page.getByRole('combobox').fill(contact.name);
    await page.getByRole('option', { name: `${contact.name} Contact`, exact: true }).waitFor();
    modes.contacts = 'http';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await status(page, messages.none);
    assert.equal(await page.getByRole('option').count(), 0);
    assert.deepEqual(reads, { board: 4, contacts: 4 });
  } finally { await browser.close(); }
});

for (const close of ['Escape', 'outside', 'invalidate', 'denied']) test(`shell close fences late partial reads after ${close}`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const modes = { contacts: 'held', board: 'held' };
    const { held } = await shell(page, modes);
    await status(page, 'Loading accessible items');
    if (close === 'Escape') await page.getByRole('combobox').press('Escape');
    else if (close === 'outside') await page.mouse.click(5, 5);
    else if (close === 'invalidate') await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    else {
      await page.route('**/api/v1/business/relationships?contract=relationship-network.v1', route => route.fulfill({ status: 401, json: { error: 'authentication_required' } }));
      await page.evaluate(() => { void import('/js/private-session.js').then(({ sessionFetch }) => sessionFetch('/api/v1/business/relationships?contract=relationship-network.v1')).catch(() => {}); });
      await page.waitForURL('**/public-shell/session-ended.html');
      await page.getByRole('heading', { name: 'Session ended' }).waitFor();
      assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
      return;
    }
    await page.getByRole('combobox').waitFor({ state: 'detached' });
    const before = page.url();
    const historyBefore = await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1'));
    await held.board().catch(() => {});
    await held.contacts().catch(() => {});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(page.url(), before);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), historyBefore);
    if (['invalidate', 'denied'].includes(close)) assert.equal(await page.getByRole('button', { name: 'Quick switcher' }).isDisabled(), true);
  } finally { await browser.close(); }
});

for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const kind of ['Deal', 'Task', 'Contact']) test(`partial source ${kind} opens its destination in ${theme} at ${width}px`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const failed = kind === 'Contact' ? 'board' : 'contacts';
    await shell(page, { [failed]: 'http' });
    await status(page, messages[failed === 'board' ? 'contacts' : 'board']);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const name = kind === 'Contact' ? contact.name : kind === 'Deal' ? 'Transport Deal' : 'Transport Task · Transport Deal';
    await page.getByRole('combobox').fill(name);
    const option = page.getByRole('option', { name: `${name} ${kind}`, exact: true });
    await option.waitFor();
    const bounds = await page.locator('[data-quick-switcher]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    if (kind === 'Task') await page.getByRole('combobox').press('Enter'); else await option.click();
    await page.waitForURL(kind === 'Contact' ? `**/relationships?node=${encodeURIComponent(contact.id)}` : kind === 'Task' ? '**/inbox/card/next_action%3A33333333-3333-4333-8333-333333333333' : '**/deals?deal=switcher-deal');
  } finally { await browser.close(); }
});

for (const failure of ['board', 'contacts']) test(`shell session invalidation clears settled ${failure} partial results`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await shell(page, { [failure]: 'http' });
    await status(page, messages[failure === 'board' ? 'contacts' : 'board']);
    await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
    assert.equal(await page.getByRole('button', { name: 'Quick switcher' }).isDisabled(), true);
  } finally { await browser.close(); }
});

test('shell old completion cannot replace a reopened dialog', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const modes = { contacts: 'held' };
    const { held } = await shell(page, modes);
    const oldContacts = held.contacts;
    await page.getByRole('combobox').press('Escape');
    modes.contacts = 'http';
    await page.getByRole('button', { name: 'Quick switcher' }).click();
    await status(page, messages.board);
    await oldContacts();
    await page.getByRole('combobox').fill(contact.name);
    assert.equal(await page.getByRole('option').count(), 0);
    await status(page, messages.board);
  } finally { await browser.close(); }
});
