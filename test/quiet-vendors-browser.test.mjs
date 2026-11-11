import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';

const id = '00000000-0000-4000-8000-000000000002';
const snapshot = () => ({ schema_version: 'quiet-follow-ups.v1', cadence: { lead_days: 45, vendor_days: 90 }, sent: false, tasks_created: false,
  proposals: Array.from({ length: 26 }, (_, n) => ({ subject_type: n === 25 ? 'lead' : 'vendor', subject_id: id,
    ref: `V-DEMO-${n}`, name: n === 25 ? 'Hidden lead' : `Quiet vendor ${n + 1} ${'Synthetic long name '.repeat(3)}`,
    owner: n % 2 ? 'joe' : 'dell', basis: n % 2 ? 'last_contact' : 'created_at', anchor_on: '2028-01-01', due_on: '2028-03-31', days_overdue: n % 3 })) });

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`quiet vendors are opt-in, bounded and preserve directory navigation at ${width} ${theme}`, async t => {
    const server = await startFixtureServer();
    t.after(() => server.stop());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('https://**', route => route.abort());
    let reads = 0, response = snapshot(), refuse = false, release = null, onHeld = null;
    await page.route('**/api/v1/business/**', route => route.fulfill({ json: directoryFixture(route.request().url()) }));
    await page.route('**/mcp', async route => {
      const request = route.request().postDataJSON();
      if (request.params.name !== 'quiet-follow-ups') return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{}' }] } } });
      reads++;
      if (release) { onHeld(); await release; }
      return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: { isError: refuse, content: [{ type: 'text', text: JSON.stringify(refuse ? { error: 'forbidden' } : response) }] } } });
    });
    await page.goto(`${server.url}/clients`);
    await page.locator('.record-row').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Show quiet vendors' }).count(), 0);
    assert.equal(reads, 0);
    await page.goto(`${server.url}/vendors?q=Demo&owner=all`);
    await page.locator('.record-row').first().waitFor();
    const show = page.getByRole('button', { name: 'Show quiet vendors' });
    await show.waitFor();
    assert.equal(reads, 0);
    assert.equal(await show.getAttribute('aria-expanded'), 'false');
    let finishOpen;
    release = new Promise(resolve => finishOpen = resolve);
    const opening = new Promise(resolve => onHeld = resolve);
    await show.focus();
    await page.keyboard.press('Enter');
    await opening;
    assert.equal(await page.getByRole('button', { name: 'Loading quiet vendors…' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(reads, 1);
    finishOpen(); release = null;
    const section = page.getByRole('region', { name: 'Quiet vendor follow-ups' });
    await section.getByText('Showing 1–5 of 25 quiet vendors.', { exact: true }).waitFor();
    const refresh = section.getByRole('button', { name: 'Refresh quiet vendors' });
    const hide = section.getByRole('button', { name: 'Hide quiet vendors' });
    assert.equal(await refresh.getAttribute('aria-expanded'), null);
    assert.equal(await refresh.getAttribute('aria-controls'), null);
    assert.equal(await hide.getAttribute('aria-expanded'), 'true');
    assert.equal(await hide.getAttribute('aria-controls'), 'quietVendorsContent');
    const focusFailures = [];
    const checkFocus = async action => {
      if (await page.evaluate(() => document.activeElement === document.body)) focusFailures.push(action);
    };
    await checkFocus('Show');
    assert.equal(reads, 1);
    assert.equal(await section.getByText('Hidden lead').count(), 0);
    assert.match(await section.innerText(), /Never contacted/);
    assert.match(await section.innerText(), /Last contact/);
    await section.getByRole('button', { name: 'Next vendors' }).focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
    await section.getByText('Showing 21–25 of 25 quiet vendors.', { exact: true }).waitFor();
    assert.equal(reads, 1);
    assert.equal(await section.getByRole('link').count(), 5);
    await checkFocus('Next at last page');
    await section.getByRole('button', { name: 'Previous vendors' }).focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
    assert.equal(await section.getByRole('link').count(), 5);
    await page.keyboard.press('Enter');
    assert.equal(await section.getByRole('link').count(), 5);
    await checkFocus('Previous at first page');
    assert.match(await section.innerText(), /Due today/);
    assert.match(await section.innerText(), /1 day overdue/);
    assert.match(await section.innerText(), /2 days overdue/);
    assert.match(await section.innerText(), /Owner: Dell/);
    assert.match(await section.innerText(), /Owner: Joe/);
    assert.equal(await section.getByText('Yours', { exact: true }).count(), 0);
    assert.doesNotMatch(await section.innerText(), /[01] days overdue|Owner dell/);
    assert.equal(await section.locator('ol').evaluate(el => el.scrollHeight > el.clientHeight), false);
    await section.getByRole('button', { name: 'Hide quiet vendors' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await show.evaluate(el => el === document.activeElement), true);
    assert.equal(await section.getByRole('link').count(), 0);
    await page.keyboard.press('Enter');
    assert.equal(await section.getByRole('link').count(), 5);
    assert.equal(reads, 1);
    await page.locator('#searchInput').fill('Demo Partner');
    await page.locator('#searchInput').press('Enter');
    await section.getByRole('link').first().scrollIntoViewIfNeeded();
    const priorScroll = await page.evaluate(() => window.scrollY);
    const prior = new URL(page.url()).search;
    await section.getByRole('link').first().click();
    await page.locator('#recordPanel.open').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('record'), id);
    assert.equal(new URL(page.url()).searchParams.get('q'), 'Demo Partner');
    await page.goBack();
    assert.equal(new URL(page.url()).search, prior);
    assert.equal(await page.evaluate(() => Math.round(window.scrollY)), Math.round(priorScroll));
    await section.getByRole('button', { name: 'Next vendors' }).click();
    await section.getByText('Showing 6–10 of 25 quiet vendors.', { exact: true }).waitFor();
    await refresh.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.evaluate(() => window.scrollBy(0, -document.querySelector('.search-dock').getBoundingClientRect().top));
    await refresh.focus();
    await page.keyboard.press('Enter');
    await section.getByText('Showing 1–5 of 25 quiet vendors.', { exact: true }).waitFor();
    const geometry = await refresh.evaluate(el => {
      const button = el.getBoundingClientRect();
      const dock = document.querySelector('.search-dock').getBoundingClientRect();
      return { buttonTop: button.top, buttonBottom: button.bottom, dockBottom: dock.bottom,
        viewportHeight: window.innerHeight, focused: el === document.activeElement };
    });
    assert.equal(geometry.focused, true);
    assert.ok(geometry.buttonTop >= geometry.dockBottom && geometry.buttonBottom <= geometry.viewportHeight,
      `Focused Refresh must be below the sticky search bar and inside the viewport: ${JSON.stringify(geometry)}`);
    assert.equal(reads, 2);
    await checkFocus('Refresh');
    const wrappedDates = await section.locator('li p').evaluateAll(paragraphs => paragraphs.flatMap(p => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const failures = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        for (const match of node.textContent.matchAll(/2028-\d{2}-\d{2}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          if (range.getClientRects().length > 1) failures.push(match[0]);
        }
      }
      return failures;
    }));
    assert.deepEqual({ focusFailures, wrappedDates }, { focusFailures: [], wrappedDates: [] });
    assert.equal(await section.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await mkdir('.github/pr-evidence/WR647.S1.J32', { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `.github/pr-evidence/WR647.S1.J32/${width}-${theme}.png` });
    refuse = true;
    await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
    await section.getByRole('alert').waitFor();
    assert.doesNotMatch(await section.innerText(), /No quiet vendors/);
    response = { ...snapshot(), proposals: [] }; refuse = false;
    await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
    await section.getByText('No quiet vendors in this server snapshot.').waitFor();
    let finish;
    release = new Promise(resolve => finish = resolve);
    response = snapshot();
    const beforeLate = reads;
    const lateRequest = new Promise(resolve => onHeld = resolve);
    await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
    await lateRequest;
    assert.equal(await section.getByRole('button', { name: 'Loading quiet vendors…' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(reads, beforeLate + 1);
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    finish();
    await page.waitForLoadState('networkidle');
    assert.equal(await section.count(), 0);
  });
}
