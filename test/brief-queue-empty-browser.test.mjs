import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

const queuePage = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app-shell.css"><link rel="stylesheet" href="/css/morning-brief.css"></head><body class="has-app-layout"><button id="docOpen">Doc</button><button id="docMorning">Morning brief</button></body></html>';
const emptyCopy = 'No eligible work in this queue.';

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`empty queues retain coverage, keyboard controls and session cleanup at ${width} in ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.route('**/empty-queue-fixture?mode=live', route => route.fulfill({ contentType: 'text/html', body: queuePage }));
    await page.goto(`${server.origin}/empty-queue-fixture?mode=live`);
    await page.evaluate(async theme => {
      document.documentElement.dataset.theme = theme;
      const { mountMorningBrief } = await import('/js/morning-brief.js');
      window.queueMode = 'empty';
      window.partner = 'joe';
      const empty = () => ({ state: 'empty', items: [], total: 0 });
      const client = {
        morningBrief: async () => ({ sponsor: window.partner, sections: { today: empty(), deals: empty(), loops: empty(), needs_joe: empty(), assurance_cadence: empty() } }),
        getChanges: async () => ({ events: [] }),
        morningBriefQueue: async () => {
          if (window.queueMode === 'held') await new Promise(resolve => { window.releaseQueue = resolve; });
          if (window.queueMode === 'error') throw new Error('Synthetic queue unavailable');
          const items = window.queueMode === 'populated' ? [{ number: '7', kind: 'open_loop', title: 'Synthetic eligible loop', owner_partner: window.partner, due_on: '2026-01-01' }] : [];
          return { sponsor: window.partner, items, total: items.length, returned: items.length, has_more: false, next_cursor: null,
            state: window.queueMode === 'partial' ? 'partial' : items.length ? 'ready' : 'empty',
            total_scope: window.queueMode === 'partial' ? 'available_sources' : 'all' };
        },
      };
      window.brief = mountMorningBrief({ document, window, getClient: async () => client, intervalMs: 100000 });
      await window.brief.refresh();
      await window.brief.open();
    }, theme);
    const switcher = page.getByRole('combobox', { name: 'Work queue' });
    const refresh = page.getByRole('button', { name: 'Refresh morning brief', exact: true });
    const message = page.getByText(emptyCopy, { exact: true });
    for (const partner of ['joe', 'dell']) {
      if (partner === 'dell') {
        await page.getByRole('button', { name: 'Hide morning brief' }).click();
        await page.evaluate(async () => { window.partner = 'dell'; await window.brief.refresh(); await window.brief.open(); });
      }
      const queues = partner === 'joe' ? ['today', 'loops', 'needs_joe', 'assurance_cadence'] : ['today', 'loops', 'assurance_cadence'];
      assert.deepEqual(await page.locator('[data-brief-queue]').evaluateAll(nodes => nodes.map(node => node.dataset.briefQueue)), queues);
      await page.getByRole('button', { name: /^Today queue/ }).focus();
      await page.keyboard.press('Enter');
      await message.waitFor();
      assert.deepEqual(await switcher.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), queues);
      for (const queue of queues) {
        await switcher.focus();
        await switcher.selectOption(queue);
        await message.waitFor();
        assert.equal(await switcher.evaluate(node => node === document.activeElement), true);
      }
      await switcher.selectOption('loops');
      await message.waitFor();
      await page.getByRole('heading', { name: 'Open loops · 0 of 0', exact: true }).waitFor();
      if (partner === 'joe') {
        const evidence = process.env.BRIEF_QUEUE_EMPTY_EVIDENCE_DIR;
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({ path: `${evidence}/${width}-${theme}-empty.png` });
        }
      }
      for (const mode of ['held', 'populated', 'empty', 'partial', 'error', 'empty']) {
        await page.evaluate(mode => { window.queueMode = mode; }, mode);
        await refresh.focus();
        await page.keyboard.press('Enter');
        if (mode === 'held') {
          await page.locator('#morningContent').getByText('Updating…', { exact: true }).waitFor();
          assert.equal(await message.count(), 0);
          await page.waitForFunction(() => typeof window.releaseQueue === 'function');
          await page.evaluate(() => { window.queueMode = 'empty'; window.releaseQueue(); });
          await message.waitFor();
        } else if (mode === 'error') {
          await page.getByText('Queue update unavailable; retry to continue.', { exact: true }).waitFor();
          assert.equal(await message.count(), 0);
        } else if (mode === 'partial') {
          await page.getByText('Some sources are unavailable. This list may be incomplete.', { exact: true }).waitFor();
          assert.equal(await message.count(), 0);
        } else if (mode === 'populated') {
          const row = page.locator('[data-queue-item="open_loop:7"]');
          await row.waitFor();
          assert.equal(await message.count(), 0);
          await row.locator('summary').focus();
          await page.keyboard.press('Enter');
          assert.equal(await row.locator('details').getAttribute('open'), '');
          assert.match(await row.textContent(), /Due2026-01-01Owner/);
          await page.keyboard.press('Space');
          assert.equal(await row.locator('details').getAttribute('open'), null);
          await refresh.focus();
        } else await message.waitFor();
        assert.equal(await refresh.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('#docMorningBrief').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      }
      assert.equal(await page.locator('[data-brief-queue-more]').count(), 0);
      const back = page.getByRole('button', { name: 'Back to priorities', exact: true });
      await refresh.focus();
      await page.keyboard.press('Tab');
      assert.equal(await switcher.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await back.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: /^Today queue/ }).waitFor();
    }
    await page.getByRole('button', { name: /^Open loops/ }).click();
    await message.waitFor();
    let signedIn = true;
    await page.context().route('**/auth/session', route => route.fulfill({ status: signedIn ? 200 : 401,
      json: signedIn ? { actor: { slug: 'dell' }, csrf_token: 'synthetic-queue-csrf' } : {} }));
    await page.context().route('**/auth/signout', route => {
      signedIn = false;
      return route.fulfill({ status: 302, headers: { location: '/' } });
    });
    await page.context().route('**/mcp', route => route.fulfill({ json: { result: { content: [{ type: 'text', text: '{}' }] } } }));
    await page.evaluate(async () => { const { privateSession } = await import('/js/private-session.js'); await privateSession().verify(); });
    const accountPage = await page.context().newPage();
    await accountPage.goto(`${server.origin}/calls?mode=live`);
    await accountPage.getByRole('button', { name: 'Dell: account and settings', exact: true }).click();
    await accountPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL('**/public-shell/session-ended.html');
    await accountPage.waitForURL('**/public-shell/session-ended.html');
    assert.equal(await message.count(), 0);
    assert.equal(await page.locator('[data-queue-item]').count(), 0);
  });
}
