import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createFixtureClient } from '../js/fixture-client.js';

const root = new URL('../', import.meta.url);
const contract = JSON.parse(await readFile(new URL('contracts/app-routes.v1.json', root)));
const seedUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json', root))).toString('base64')}`;
const reply = (route, value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }) });

// Live reads are answered from the synthetic fixture; the change feed carries
// one partner change from an hour ago so "overnight" has something to say.
async function setup(t, { width = 1440, triage, changes, boardMap = board => board, held = Promise.resolve() } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 } }); page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    window.spoken = []; window.speechCancels = 0;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: u => window.spoken.push(u.text), cancel: () => { window.speechCancels++; } } });
  });
  const fixture = await createFixtureClient({ seedUrl });
  const calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const partnerChange = { id: 'e-brief-1', recorded_at: new Date(Date.now() - 3_600_000).toISOString(), actor: 'dell', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd05', field: 'phase', old_value: 'Negotiation', new_value: 'Legal' };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/pipeline/changes') {
      const events = changes ?? [partnerChange];
      return route.fulfill({ json: { events: url.searchParams.get('cursor') ? [] : events, presence: [], cursor: 'c1' } });
    }
    if (url.pathname === '/mcp') {
      const { name, arguments: args } = request.postDataJSON().params; calls.push(name);
      if (name === 'deal-room-board') return reply(route, boardMap(await fixture.getBoard(args)));
      if (name === 'today-triage') { await held; return reply(route, triage ?? await fixture.todayTriage()); }
      if (name === 'list-doc-suggestions') return reply(route, await fixture.listDocSuggestions(args));
      return reply(route, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    const file = contract.routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const goto = async path => { await page.goto('http://localhost' + path, { waitUntil: 'domcontentloaded' }); await page.locator('#docPresence').waitFor(); };
  return { page, goto, calls, errors };
}

const shot = async (page, name) => {
  await mkdir(new URL('test-artifacts/w12/', root), { recursive: true });
  await page.screenshot({ path: new URL(`test-artifacts/w12/${name}.png`, root).pathname, animations: 'disabled' });
};

test('Doc shows the brief on the first open of the day, every line opens its record, and it stays dismissed until reopened', async t => {
  const { page, goto, errors } = await setup(t);
  await goto('/?mode=live');
  const brief = page.locator('#docBrief');
  await brief.waitFor({ state: 'visible' });
  assert.match(await brief.locator('h2').innerText(), /^Good (morning|afternoon|evening), Joe$/);
  await page.locator('#docBriefFirst a').waitFor();
  const links = await brief.locator('a.doc-brief-item').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')));
  assert.ok(links.length >= 2, String(links));
  for (const href of links) assert.match(href, /^\/deals\?deal=d\d+$/);
  assert.match(await page.locator('#docBriefOvernight').innerText(), /Dell/);
  assert.match(await page.locator('#docBriefOvernight a').getAttribute('href'), /^\/deals\?deal=d05$/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.doesNotMatch(await brief.innerText(), /record layer|records read|source|Read again|retry/i);
  await shot(page, 'brief-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot(page, 'brief-phone');
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.locator('#docBriefClose').click();
  assert.equal(await brief.isVisible(), false);
  await goto('/deals?mode=live');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#docBrief').isVisible(), false);
  await page.locator('#docBriefOpen').click();
  await page.locator('#docBrief').waitFor({ state: 'visible' });
  await page.locator('#docBriefFirst a').waitFor();
  await page.locator('#docBriefFirst a').click();
  await page.waitForURL(/\/deals\?deal=d\d+/);
  assert.deepEqual(errors, []);
});

test('speech is a remembered setting: on speaks the brief, off silences it, and a new day speaks when it opens', async t => {
  const { page, goto } = await setup(t);
  await goto('/?mode=live');
  const toggle = page.locator('#docBriefSpeech');
  await page.locator('#docBriefFirst a').waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await page.evaluate(() => window.spoken), []);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  const [spoken] = await page.evaluate(() => window.spoken);
  assert.match(spoken, /^Good (morning|afternoon|evening), Joe\. First, /);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.ok(await page.evaluate(() => window.speechCancels) >= 1);
  await toggle.click();
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('doctorcre:brief:')) localStorage.removeItem(key); });
  await goto('/?mode=live');
  await page.locator('#docBriefFirst a').waitFor();
  await page.waitForFunction(() => window.spoken.length === 1);
  assert.equal(await page.locator('#docBriefSpeech').getAttribute('aria-pressed'), 'true');
});

test('a quiet morning omits every empty section instead of padding it', async t => {
  const { page, goto } = await setup(t, { triage: { items: [] }, changes: [], boardMap: board => ({ ...board, deals: board.deals.map(deal => ({ ...deal, attention: false })) }) });
  await goto('/?mode=live');
  await page.locator('#docBrief').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#docBrief')?.dataset.state === 'ready');
  assert.equal(await page.locator('#docBriefFirst').count(), 0);
  assert.equal(await page.locator('#docBriefOvernight').count(), 0);
  assert.equal(await page.locator('#docBriefToday').count(), 0);
});

test('a brief that arrives after the partner starts working waits behind Doc instead of moving the page', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const { page, goto } = await setup(t, { held });
  await goto('/?mode=live');
  await page.mouse.click(700, 900);
  release();
  await page.locator('#docBriefOpen[data-ready="true"]').waitFor();
  assert.equal(await page.locator('#docBrief').isVisible(), false);
  await page.locator('#docBriefOpen').click();
  await page.locator('#docBriefFirst a').waitFor();
  assert.equal(await page.locator('#docBriefOpen').getAttribute('data-ready'), null);
});
