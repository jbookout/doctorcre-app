import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { syntheticCards, observeSearch } from '../scripts/prove-home-loaded-card-search.mjs';
let outDir;
before(async () => { outDir = temporaryDirectory('loaded-search-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => rm(outDir, { recursive: true, force: true }));
async function setup(t, width = 1440, theme = 'light', review = false, card = null) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const fixture = await syntheticCards();
  let snapshot = fixture.snapshot;
  if (review) snapshot = fixture.parseSnapshot({ ...snapshot, items: snapshot.items.map((item, index) => index ? item : { ...item, review_reference: { kind: 'action', item_id: item.item_id, source_version: item.source_version, operations: ['complete-one-action'] } }) });
  const calls = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    calls.push(name);
    let payload;
    if (name === 'read-home-inbox-v5') payload = fixture.parseSnapshot(snapshot);
    else if (name === 'read-home-review') {
      const item = snapshot.items[0];
      payload = { ok: true, schema_version: 'home-review.v1', reference: item.review_reference, detail: { title: item.title }, operations: [{ verb: 'complete-one-action', args: { action_id: item.action_id, base_version: item.action_version } }] };
    } else if (name === 'complete-one-action' || name === 'reopen-one-action') {
      payload = await fixture.rpc(name, args);
      snapshot = fixture.parseSnapshot(await fixture.rpc('read-home-inbox-v5', {}));
    } else payload = { items: [] };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  page.setDefaultTimeout(5000);
  await page.goto(`${server.origin}/?mode=live${card ? `&card=${encodeURIComponent(card)}` : ''}`);
  await page.getByRole('searchbox').waitFor();
  return { page, fixture, calls, update: value => { snapshot = fixture.parseSnapshot(value); } };
}
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`loaded search subset, clear and no RPC ${width} ${theme}`, async t => {
  const { page, fixture, calls } = await setup(t, width, theme);
  await observeSearch(page, fixture.snapshot, calls);
  const search = page.getByRole('searchbox');
  for (const term of ['Demo practice with a long owning deal name', 'Task']) {
    await search.fill(term);
    await page.getByText('6 matching loaded cards of 6 loaded', { exact: true }).waitFor();
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
test('selection, refresh additions/removals, disclosure, current pin and session disposal', async t => {
  const { page, fixture, update } = await setup(t, 1440, 'light', false, 'demo-call');
  const search = page.getByRole('searchbox');
  await page.getByRole('checkbox', { name: 'Select Review the practice tour follow-up', exact: true }).check();
  await search.fill('pipeline');
  await page.getByText('Selection cleared because the search changed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0);
  update({ ...fixture.snapshot, truncated: true, items: fixture.snapshot.items.filter(item => item.item_id !== 'demo-call') });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await page.getByText('No loaded cards match your search.', { exact: true }).waitFor();
  assert.equal(await search.inputValue(), 'pipeline');
  await page.getByText('Showing the first 1,000 cards. More work is available.', { exact: true }).waitFor();
  update(fixture.snapshot);
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await page.locator('[data-inbox-row="demo-call"]').waitFor();
  await search.fill('not found');
  await page.getByText('Pinned outside search', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-inbox-row]').count(), 1);
  await page.getByRole('search').getByRole('button', { name: 'Clear', exact: true }).click();
  const region = page.getByRole('region', { name: 'Needs your attention', exact: true });
  const disclosure = region.getByRole('button', { name: /See all/ });
  await disclosure.click();
  assert.equal(await region.locator('[data-inbox-row]').count(), 2);
  await region.getByRole('button', { name: 'Show less' }).click();
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
  assert.equal(await search.count(), 0);
});
test('pending request locks search and completion Undo preserves query', async t => {
  const { page } = await setup(t);
  const search = page.getByRole('searchbox');
  await search.fill('pipeline');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/mcp', async route => {
    if (route.request().postDataJSON().params.name !== 'complete-one-action') return route.fallback();
    await held; await route.fallback();
  });
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  assert.equal(await search.isDisabled(), true);
  release();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  assert.equal(await search.isDisabled(), false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Mark done', exact: true }).waitFor();
  assert.equal(await search.inputValue(), 'pipeline');
});

test('inline review locks search and preserves opener focus through close and unmount', async t => {
  const { page } = await setup(t, 1440, 'light', true);
  const search = page.getByRole('searchbox');
  const opener = page.getByRole('button', { name: 'Review card', exact: true });
  await opener.click();
  await page.getByRole('button', { name: 'Close review', exact: true }).waitFor();
  assert.equal(await search.isDisabled(), true);
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  assert.equal(await search.isDisabled(), false);
  assert.equal(await opener.evaluate(node => node === document.activeElement), true);
  assert.equal(await search.inputValue(), '');
  await search.fill('practice tour');
  await opener.click();
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await search.count(), 0);
});
test('literal field matching preserves canonical slices and excludes source payload fields', async t => {
  const { page } = await setup(t);
  const search = page.getByRole('searchbox');
  for (const region of await page.locator('.home-slice').all()) {
    const more = region.getByRole('button', { name: /^See all/ });
    if (await more.count()) await more.click();
  }
  const placements = () => page.locator('[data-inbox-row]').evaluateAll(rows => rows.map(row => [row.dataset.inboxRow, row.closest('.home-slice').getAttribute('aria-label')]));
  const before = await placements();
  await search.fill('Task');
  assert.deepEqual(await placements(), before);
  await search.fill('Demo practice with a long owning deal name');
  assert.deepEqual(await placements(), before);
  await search.fill('next_action');
  await page.getByText('No loaded cards match your search.', { exact: true }).waitFor();
  await search.fill('.*');
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
});
test('uncertain server refusal locks query until dismissal and refresh', async t => {
  const { page } = await setup(t);
  const search = page.getByRole('searchbox');
  await search.fill('pipeline');
  await page.route('**/mcp', route => route.request().postDataJSON().params.name === 'complete-one-action'
    ? route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'partner_required' }) }] } } }) : route.fallback());
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss and refresh', exact: true }).waitFor();
  assert.equal(await search.isDisabled(), true);
  await page.getByRole('button', { name: 'Dismiss and refresh', exact: true }).click();
  assert.equal(await search.isDisabled(), false);
  assert.equal(await search.inputValue(), 'pipeline');
});

test('Home card navigation opens the full Inbox and Back restores the search', async t => {
  const { page } = await setup(t);
  await page.getByRole('searchbox').fill('pipeline');
  await page.locator('[data-inbox-row="demo-call"] h3 a').click();
  await page.getByRole('heading', { name: 'Inbox', level: 1, exact: true }).waitFor();
  assert.equal(await page.getByRole('searchbox').count(), 0);
  assert.equal(await page.locator('[data-inbox-row="demo-call"][data-current="true"]').count(), 1);
  await page.goBack();
  assert.equal(await page.getByRole('searchbox').inputValue(), 'pipeline');
});
