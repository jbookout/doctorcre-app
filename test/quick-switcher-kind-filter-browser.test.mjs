import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { contractFixture, observeKindFilter } from '../scripts/prove-quick-switcher-kind-filter.mjs';
const server = await startFixtureServer();
test.after(server.stop);
for (const theme of ['light', 'dark']) for (const width of [390, 1440]) test(`kind filtering, query and keyboard at ${width} ${theme}`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.goto(server.url);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await observeKindFilter(page, contractFixture());
    const bounds = await page.locator('[data-quick-switcher]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    const input = page.getByRole('combobox', { name: 'Jump to', exact: true });
    await page.getByRole('group', { name: 'Destination kind' }).getByRole('button', { name: 'Contacts', exact: true }).click();
    await input.fill('Fixture Contact');
    await input.press('ArrowUp');
    await input.press('Enter');
    await page.waitForURL('**/relationships?node=party%3A22222222-2222-4222-8222-222222222222');
  } finally { await browser.close(); }
});
test('partial retry, removal, close, recents and late session disposal', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const fixture = contractFixture();
    await page.evaluate(async fixture => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      window.payload = { ...fixture, network: null };
      window.reads = 0;
      window.openFixture = () => openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [{ label: 'Fixture Page', href: '/calendar' }], read: () => { window.reads++; return window.held ? new Promise(resolve => window.resolveRead = resolve) : Promise.resolve(window.payload); } });
      window.openFixture();
    }, fixture);
    const kind = page.getByRole('group', { name: 'Destination kind' });
    const input = page.getByRole('combobox', { name: 'Jump to', exact: true });
    await kind.getByRole('button', { name: 'Deals', exact: true }).click();
    await page.getByRole('option').first().waitFor();
    await input.fill(' Fixture ');
    await input.press('ArrowDown');
    await page.evaluate(() => window.payload = { board: null, network: null });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    assert.equal(await input.getAttribute('aria-activedescendant'), null);
    assert.equal(await input.inputValue(), ' Fixture ');
    await page.evaluate(fixture => window.payload = fixture, fixture);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('option').first().waitFor();
    assert.equal(await input.getAttribute('aria-activedescendant'), 'quick-option-0');
    await input.press('Escape');
    assert.equal(await page.locator('.quick-switcher-toggle').evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => { window.held = true; window.openFixture(); });
    assert.equal(await kind.getByRole('button', { name: 'All destinations' }).getAttribute('aria-pressed'), 'true');
    await kind.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    await page.evaluate(fixture => window.resolveRead(fixture), fixture);
    assert.equal(await page.locator('[data-quick-switcher]').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')), null);
  } finally { await browser.close(); }
});
for (const mode of ['empty', 'contacts only', 'reject']) test(`${mode} keeps local filtering and reports counts`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const payload = contractFixture();
    if (mode === 'empty') { payload.board.deals = []; payload.network.nodes = []; }
    if (mode === 'contacts only') payload.board = null;
    await page.evaluate(async ({ payload, mode }) => {
      const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
      openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [], read: () => mode === 'reject' ? Promise.reject(Error('Unavailable')) : Promise.resolve(payload) });
    }, { payload, mode });
    const group = page.getByRole('group', { name: 'Destination kind' });
    await group.getByRole('button', { name: 'Contacts', exact: true }).click();
    if (mode === 'contacts only') {
      await page.getByRole('option', { name: 'Fixture Contact Contact' }).waitFor();
      await page.getByText('1 destinations', { exact: true }).waitFor();
    } else await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
    await page.getByRole('combobox').press('Escape');
  } finally { await browser.close(); }
});


for (const theme of ['light', 'dark']) for (const width of [390, 1440]) test(`tasks sharing a deal open their own canonical cards with pointer and Enter at ${width} ${theme}`, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const payload = contractFixture();
    const deal = payload.board.deals[0];
    deal.open_actions.push({ ...deal.open_actions[0], id: '44444444-4444-4444-8444-444444444444', item_id: 'next_action:44444444-4444-4444-8444-444444444444', description: 'Second Fixture Task' });
    const observed = [];
    for (const [index, action] of deal.open_actions.entries()) {
      await page.goto(server.url);
      await page.getByRole('button', { name: 'Quick switcher' }).waitFor();
      await page.evaluate(async payload => {
        const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
        openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [], read: async () => payload });
      }, payload);
      await page.getByRole('group', { name: 'Destination kind' }).getByRole('button', { name: 'Tasks', exact: true }).click();
      const input = page.getByRole('combobox', { name: 'Jump to', exact: true });
      await input.fill(action.description);
      const choice = page.getByRole('option', { name: `${action.description} · ${deal.name} Task`, exact: true });
      await choice.waitFor();
      if (index === 0) await choice.click();
      else await input.press('Enter');
      await page.waitForURL(url => url.pathname !== '/');
      observed.push(new URL(page.url()).pathname + new URL(page.url()).search);
    }
    const recents = await page.evaluate(() => JSON.parse(sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')));
    assert.deepEqual(recents.filter(id => id.startsWith('task:')).slice(0, 2), deal.open_actions.map(action => `task:${action.item_id}`).reverse());
    console.log(JSON.stringify({ task_ids: deal.open_actions.map(action => action.id), observed_destinations: observed }));
    assert.deepEqual(observed, deal.open_actions.map(action => `/inbox/card/${encodeURIComponent(action.item_id)}`));
  } finally { await browser.close(); }
});

for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const present of [true, false]) test(`producer task identities and ${present ? 'exact Home cards' : 'outside-snapshot disclosure'} at ${width} ${theme}`, async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { default: Ajv } = await import('ajv');
  const { createLiveClient } = await import('../js/live-client.js');
  const { build } = await import('esbuild');
  const contractBytes = readFileSync(new URL('../contracts/carr-interface.v1/local-deals-board.v2.json', import.meta.url));
  assert.equal(createHash('sha256').update(contractBytes).digest('hex'), '0a1fa08ab890fa7aaa96b8ee869120d7ad8101a18f9874da9f9d0d2275b3a478');
  const schema = JSON.parse(contractBytes);
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema.$defs.open_action);
  const actions = JSON.parse(readFileSync(new URL('./fixtures/deal-board-actions.v2.json', import.meta.url)));
  for (const action of actions) assert.equal(validate(action), true, JSON.stringify(validate.errors));
  assert.equal(actions[0].id, actions[1].id);
  const payload = contractFixture();
  payload.board.deals[0].open_actions = actions;
  const live = createLiveClient({ fetchImpl: async () => Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(payload.board) }] } }) });
  payload.board = await live.getBoard();
  assert.deepEqual(payload.board.deals[0].open_actions, actions);
  const compiled = await build({ stdin: { contents: "export {fixtureInboxRpc} from './src/ui/home/fixture'; export {parseSnapshot} from './src/ui/home/inbox';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
  const { fixtureInboxRpc, parseSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const snapshot = parseSnapshot(await fixtureInboxRpc()('read-home-inbox-v5', {}));
  snapshot.items = present ? actions.map(action => ({ ...snapshot.items[0], item_id: action.item_id, source_id: action.id, source_type: action.item_id.split(':')[0], title: action.description, action_id: action.id, deal_id: payload.board.deals[0].id })) : [];
  parseSnapshot(snapshot);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
    await page.route('**/mcp', async route => {
      const { name } = route.request().postDataJSON().params;
      await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(name === 'read-home-inbox-v5' ? snapshot : { error: 'unknown_tool' }) }] } } });
    });
    for (const [index, action] of actions.entries()) {
      await page.goto(server.url);
      await page.evaluate(async payload => {
        const { openQuickSwitcher } = await import('/js/ui-quick-switcher.js');
        openQuickSwitcher({ opener: document.querySelector('.quick-switcher-toggle'), pages: [], read: async () => payload });
      }, payload);
      await page.getByRole('combobox', { name: 'Jump to', exact: true }).fill(action.description);
      const choice = page.getByRole('option', { name: `${action.description} · Fixture Deal Task`, exact: true });
      await choice.waitFor();
      if (index === 0) await choice.click();
      else await page.getByRole('combobox').press('Enter');
      await page.waitForURL(`**/inbox/card/${encodeURIComponent(action.item_id)}`);
      const homePage = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      await homePage.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
      await homePage.route('**/mcp', async route => {
        const { name } = route.request().postDataJSON().params;
        await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(name === 'read-home-inbox-v5' ? snapshot : { error: 'unknown_tool' }) }] } } });
      });
      await homePage.goto(`${page.url()}?mode=live`);
      if (present) {
        const row = homePage.locator('[data-inbox-row]').filter({ has: homePage.getByRole('link', { name: action.description, exact: true }) });
        await row.waitFor();
        assert.equal(await row.getAttribute('data-inbox-row'), action.item_id);
      } else await homePage.getByText('This card is not in your current inbox snapshot.', { exact: true }).waitFor();
      await homePage.close();
    }
    const recents = await page.evaluate(() => JSON.parse(sessionStorage.getItem('doctorcre.quick-switcher.recents.v1')));
    assert.deepEqual(recents.filter(id => id.startsWith('task:')).slice(0, 2), actions.map(action => `task:${action.item_id}`).reverse());
  } finally { await browser.close(); }
});
