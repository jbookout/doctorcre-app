import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import axe from 'axe-core';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, webkit } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
let outDir;
before(async () => { outDir = await temporaryDirectory('home-bulk-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });
async function open(t, { width = 390, theme = 'light', mixed = true, stale = false, lost = false, missing = false, hold = false, undoLost = false, engine = chromium, height = 900, longTitles = false } = {}) {
  const { createBatchFake, makeItem } = await import('./fixtures/home-bulk-fake.mjs');
  const items = ['a', 'b', 'c', 'd'].map(makeItem);
  if (longTitles) for (const item of items) item.title += ' follow up on the practice office relocation proposal and confirm the next conversation';
  const fake = createBatchFake(items, { mixed, stale, lost, missing, hold, undoLost });
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await engine.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 700, hasTouch: width < 700, timezoneId: 'Asia/Tokyo' });
  page.setDefaultTimeout(5000);
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    try { const payload = await fake.rpc(name, args); await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } }); }
    catch { await route.abort(); }
  });
  await page.goto(`${server.origin}/?mode=live`);
  await page.getByRole('checkbox', { name: `Select ${items[0].title}`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'See all 4', exact: true }).click();
  for (const item of items) await page.getByRole('checkbox', { name: `Select ${item.title}`, exact: true }).check();
  return { page, fake };
}
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`mixed_batch_shows_each_receipt_and_undo_restores_only_applied ${width} ${theme}`, async t => {
  const { page, fake } = await open(t, { width, theme });
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
  const results = page.getByRole('region', { name: 'Batch results' });
  await results.getByText('Synthetic a · Applied', { exact: true }).waitFor();
  for (const [id, status] of [['b', 'Already'], ['c', 'Not found'], ['d', 'Not allowed']]) {
    await results.getByText(`Synthetic ${id} · ${status}`, { exact: false }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: `Select Synthetic ${id}`, exact: true }).isChecked(), true);
  }
  await page.getByRole('button', { name: 'Undo whole batch', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Batch undo confirmed' }).waitFor();
  assert.equal(fake.items[0].disposition, 'inbox');
  assert.equal(fake.calls.filter(x => x.args.undo_of).length, 1);
  assert.equal('items' in fake.calls.find(x => x.args.undo_of).args, false);
});
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`snooze default and subset undo fit ${width} ${theme}`, async t => {
  const { page, fake } = await open(t, { width, theme, mixed: false });
  await page.getByRole('button', { name: 'Snooze selected', exact: true }).click();
  await page.getByRole('button', { name: 'Not now · Tomorrow 9:00 AM Central', exact: true }).click();
  await page.locator('[data-batch-state="results"]').waitFor();
  const write = fake.calls[0];
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(write.args.until)), '9:00 AM');
  assert.equal(write.name, 'snooze-home-inbox');
  await page.getByRole('checkbox', { name: 'Undo Synthetic a', exact: true }).check();
  await page.getByRole('button', { name: 'Undo selected results', exact: true }).click();
  await page.locator('[data-batch-state="undone"]').waitFor();
  assert.deepEqual(fake.calls[1].args.items, [{ item_id: 'a' }]);
  assert.deepEqual(fake.items.map(item => item.disposition), ['inbox', 'snoozed', 'snoozed', 'snoozed']);
  assert.equal(await page.getByRole('checkbox', { name: 'Undo Synthetic b', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('region', { name: 'Batch results' }).screenshot({ path: `/tmp/wr617-s12-j4-${width}-${theme}.png` });
});
test('stale undo refuses plainly and retains remaining undo choices', async t => {
  const { page, fake } = await open(t, { mixed: false, stale: true });
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
  await page.getByRole('button', { name: 'Undo whole batch', exact: true }).click();
  await page.locator('[data-batch-state="undo_refused"]').waitFor();
  assert.equal(await page.getByText(/This card changed.*Nothing was overwritten/).count(), 4);
  assert.equal(fake.items.every(item => item.disposition === 'settled'), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Undo Synthetic a', exact: true }).isChecked(), true);
});
test('lost response retries identical request and never claims early success', async t => {
  const { page, fake } = await open(t, { mixed: false, lost: true });
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
  await page.locator('[data-batch-state="uncertain"]').waitFor();
  assert.equal(await page.getByText('Synthetic a · Applied', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Retry same batch', exact: true }).click();
  await page.locator('[data-batch-state="results"]').waitFor();
  assert.deepEqual(fake.calls[0], fake.calls[1]);
});
test('picker cancel restores keyboard focus and chosen Central time is sent', async t => {
  const { page, fake } = await open(t, { mixed: false });
  const snooze = page.getByRole('button', { name: 'Snooze selected', exact: true });
  await snooze.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await snooze.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByLabel('Return time · Central', { exact: true }).fill('2099-07-01T14:15');
  await page.getByRole('button', { name: 'Snooze until chosen time', exact: true }).click();
  await page.locator('[data-batch-state="results"]').waitFor();
  assert.equal(fake.calls[0].args.until, '2099-07-01T19:15:00.000Z');
});
test('not found card remains selected for review after canonical read removes it', async t => {
  const { page } = await open(t, { missing: true });
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
  await page.locator('[data-batch-state="results"]').waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Select missing card Synthetic c', exact: true }).isChecked(), true);
});
test('in flight batch makes no success claim and announces its receipt once', async t => {
  const { page, fake } = await open(t, { mixed: false, hold: true });
  await page.evaluate(() => {
    window.batchAnnouncements = [];
    new MutationObserver(() => { const text = document.querySelector('.inbox-batch-announcement').textContent; if (text) window.batchAnnouncements.push(text); }).observe(document.querySelector('.inbox-batch-announcement'), { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
  await page.locator('[data-batch-state="applying"]').waitFor();
  assert.equal(await page.getByText('Synthetic a · Applied', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Settle selected', exact: true }).isDisabled(), true);
  fake.release();
  await page.locator('[data-batch-state="results"]').waitFor();
  assert.equal(await page.evaluate(() => window.batchAnnouncements.length), 1);
});
test('selection checkboxes support Space and uncertain undo retries exact batch authority', async t => {
  const { page, fake } = await open(t, { mixed: false, undoLost: true });
  const checkbox = page.getByRole('checkbox', { name: 'Select Synthetic a', exact: true });
  await checkbox.focus(); await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), false);
  await page.keyboard.press('Space'); assert.equal(await checkbox.isChecked(), true);
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
  await page.locator('[data-batch-state="results"]').waitFor();
  await page.getByRole('button', { name: 'Undo whole batch', exact: true }).click();
  await page.locator('[data-batch-state="uncertain"]').waitFor();
  assert.equal(fake.calls.length, 2);
  await page.getByRole('button', { name: 'Retry same batch', exact: true }).click();
  await page.locator('[data-batch-state="undone"]').waitFor();
  assert.equal(fake.calls[1].args.undo_of, fake.calls[0].args.idempotency_key);
  assert.deepEqual(fake.calls[1], fake.calls[2]);
  await page.getByText('Synthetic a · Restored', { exact: true }).waitFor();
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) for (const outcome of ['restored', 'next', 'empty']) test(`finish batch returns keyboard focus ${outcome} ${width} ${theme}`, async t => {
  const { page, fake } = await open(t, { width, theme, mixed: false });
  if (outcome !== 'empty') for (const id of ['c', 'd']) await page.getByRole('checkbox', { name: `Select Synthetic ${id}`, exact: true }).uncheck();
  await page.getByRole('button', { name: 'Settle selected', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-batch-state="results"]').waitFor();
  assert.deepEqual(fake.items.map(item => item.disposition), outcome === 'empty' ? ['settled', 'settled', 'settled', 'settled'] : ['settled', 'settled', 'inbox', 'inbox']);
  if (outcome === 'restored') {
    await page.getByRole('button', { name: 'Undo whole batch', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-batch-state="undone"]').waitFor();
    assert.equal(fake.items.every(item => item.disposition === 'inbox'), true);
  }
  const finish = page.getByRole('button', { name: 'Finish reviewing batch', exact: true });
  await finish.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('region', { name: 'Batch results' }).waitFor({ state: 'detached' });
  const target = outcome === 'empty' ? page.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('heading') : page.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('link', { name: `Synthetic ${outcome === 'restored' ? 'a' : 'c'}`, exact: true });
  assert.equal(await target.evaluate(node => node === document.activeElement), true, 'Finishing batch review must focus the next Home card or the inbox heading');
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
});

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]])
  for (const width of [390, 375, 360, 1440]) for (const theme of ['light', 'dark']) for (const action of ['settle', 'snooze'])
    test(`bulk Undo stays visible and tappable ${engineName} ${width} ${theme} ${action}`, { skip: engine.skip }, async t => {
      const { page, fake } = await open(t, { engine, width, height: width < 700 ? 667 : 900, theme, mixed: false, longTitles: true });
      for (const item of fake.items.slice(2)) await page.getByRole('checkbox', { name: `Select ${item.title}`, exact: true }).uncheck();
      const activate = async locator => width < 700 ? locator.tap() : locator.click();
      await activate(page.getByRole('button', { name: action === 'settle' ? 'Settle selected' : 'Snooze selected', exact: true }));
      if (action === 'snooze') await activate(page.getByRole('button', { name: 'Not now · Tomorrow 9:00 AM Central', exact: true }));
      await page.locator('[data-batch-state="results"]').waitFor();
      assert.deepEqual(fake.items.map(item => item.disposition), [action === 'settle' ? 'settled' : 'snoozed', action === 'settle' ? 'settled' : 'snoozed', 'inbox', 'inbox']);
      const undo = page.getByRole('button', { name: 'Undo whole batch', exact: true });
      const visible = async () => {
        const geometry = await undo.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight, exposed: hit === node || node.contains(hit) };
        });
        assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height && geometry.exposed, `Undo must be inside viewport and unoccluded: ${JSON.stringify(geometry)}`);
      };
      await page.screenshot({ path: `/tmp/WR617.S12.J15-${engineName}-${width}-${theme}-${action}.png` });
      await visible();
      await page.clock.install();
      await page.clock.fastForward(10_000);
      await visible();
      await activate(undo);
      await page.locator('[data-batch-state="undone"]').waitFor();
      assert.equal(fake.items.every(item => item.disposition === 'inbox'), true);
      for (const item of fake.items.slice(0, 2)) await page.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('link', { name: item.title, exact: true }).waitFor();
    });
