// Charts in a real browser: what jsdom cannot judge — the phone layout, the
// Details disclosure's motion and keyboard focus across a repaint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';

const root = new URL('../', import.meta.url);
const capture = JSON.parse(await readFile(new URL('test/fixtures/charts-synthetic.json', root), 'utf8'));

async function open(t, { width = 1280, motion = 'no-preference' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: motion });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/mcp') {
      const { name } = route.request().postDataJSON().params;
      const body = name === 'deal-room-board' ? capture : { ok: true };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(body) }] } }) });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = url.pathname === '/' ? 'charts.html' : url.pathname.slice(1);
    try {
      return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/?view=charts&mode=live');
  await page.locator('#chartAccounts tbody tr').first().waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

const shownColumns = (page, table) => page.locator(table).evaluate(node => {
  const shown = cell => getComputedStyle(cell).display !== 'none';
  return { head: [...node.querySelectorAll('thead th')].filter(shown).map(cell => cell.textContent.trim()),
    row: [...node.querySelector('tbody tr').children].filter(shown).length };
});

test('Charts on a phone keep every accounts and owner column under its own header', async t => {
  const page = await open(t, { width: 360 });
  const accounts = await shownColumns(page, '#chartAccounts table');
  assert.deepEqual(accounts.head, ['Account', 'Open', 'Flagged', 'Overdue', 'Stale', 'Parked', 'Last review', 'Details']);
  assert.equal(accounts.row, accounts.head.length);
  await page.locator('#ownerDisclosure summary').click();
  const owners = await shownColumns(page, '#chartOwners table');
  assert.deepEqual(owners.head, ['Owner', 'Records']);
  assert.equal(owners.row, 2);
  const phase = await shownColumns(page, '#chartPhase table');
  assert.equal(phase.head.length, 2);
  assert.equal(phase.row, 2);
  assert.deepEqual(await page.locator('#chartsCanvas > *').evaluateAll(cards => cards.filter(card => card.getBoundingClientRect().right > innerWidth).map(card => card.id)), []);
  assert.equal(await page.locator('#chartAccounts .chart-scroll').evaluate(node => node.scrollWidth > node.clientWidth), true);
});

for (const motion of ['no-preference', 'reduce']) test(`Charts account Details open on the shared motion (${motion})`, async t => {
  const page = await open(t, { motion });
  const details = page.locator('#chartAccounts details').first();
  assert.equal(await details.evaluate(node => node.open), false);
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await details.evaluate(node => node.open), true);
  const style = await details.evaluate(node => ({ enter: getComputedStyle(node.querySelector('dl')).animationName,
    chevron: getComputedStyle(node.querySelector('summary'), '::after').transitionDuration }));
  assert.deepEqual(style, motion === 'reduce' ? { enter: 'none', chevron: '0s' } : { enter: 'receipt-in', chevron: '0.27s' });
});

test('Charts keep keyboard focus on the slice control across its repaint', async t => {
  const page = await open(t);
  const pick = page.locator('#chartPhase [data-pick="pending"]');
  await pick.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#chartPhase [data-pick="pending"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.pick), 'pending');
  await page.locator('#chartsClear').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#chartsClear').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.pick), 'pending', 'focus returns to the slice that was cleared');
});
