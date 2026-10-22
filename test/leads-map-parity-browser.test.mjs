import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { workspace, lead, id } from './leads-workspace-fixture.mjs';

test('phone territory markers appear only after the Census map is painted', async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await routeLeads(page);
  const source = await readFile(new URL('../js/leads-territory-map.js', import.meta.url), 'utf8');
  // Observe the real renderer through its public read methods without changing its scheduling.
  await page.route('**/js/leads-territory-map.js', route => route.fulfill({ contentType: 'text/javascript',
    body: source.replace('const markers = new Map();', 'globalThis.territoryRenderer = map; const markers = new Map();') }));
  await page.goto('http://localhost/leads');
  await page.locator('.market-marker').first().waitFor({ state: 'attached' });
  const painted = await page.evaluate(() => ({ loaded: territoryRenderer.loaded(),
    land: territoryRenderer.queryRenderedFeatures({ layers: ['land'] }).length }));
  assert.equal(painted.loaded, true, 'a DOM marker must not claim that an unpainted map is ready');
  assert.ok(painted.land > 0, 'the Gulf states are painted before the first marker is exposed');
});

for (const width of [1440, 390]) for (const reversed of [false, true])
test(`shared market location membership is order independent at ${width}px (reversed=${reversed})`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = [lead(1, { market: 'Synthetic shared market' }),
    lead(2, { market: 'Synthetic shared market', city: null, state: null })];
  if (reversed) board.leads.reverse();
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-location').filter({ hasText: 'Market area only' }).waitFor();
  const located = await page.locator('.market-marker').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.dataset.leadIds)));
  const unlocated = await page.locator('#mapLeadMembers [data-lead-id]').evaluateAll(nodes =>
    nodes.filter(node => node.textContent.includes('No location')).map(node => node.dataset.leadId));
  assert.deepEqual(located, [id(1)], 'only the located member belongs to a marker');
  assert.deepEqual(unlocated, [id(2)]);
  assert.deepEqual([...located, ...unlocated].sort(), board.leads.map(row => row.id).sort());
  assert.equal(await page.locator('.market-marker').innerText(), '1');
});

test('phone All stages count describes the destination membership', async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, hasTouch: true, reducedMotion: 'reduce' });
  const board = { ...workspace(), leads: [lead(1), lead(2, { stage: 'qualified' }), lead(3, { stage: 'engaged' })] };
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  await page.locator('#stageFilter').selectOption('new');
  const label = await page.locator('#stageFilter option[value=""]').innerText();
  await page.locator('#stageFilter').selectOption('');
  const count = await page.locator('.lead-card:visible').count();
  assert.equal(count, 3);
  assert.equal(label, `All stages · ${count}`);
});

for (const width of [1440, 390]) test(`map members and board select the same lead and retain an unlocated lead at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = [lead(1), lead(2, { city: 'Synthetic Unlocated' })];
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.locator('.market-marker').first().waitFor();
  assert.equal(await page.locator('#mapLeadMembers [data-lead-id]').count(), 2);
  await page.locator('#mapLeadMembers summary').click();
  const member = page.locator(`#mapLeadMembers [data-lead-id="${id(1)}"]`);
  await member.click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('.lead-card[data-selected="true"]').getAttribute('data-lead-id'), id(1));
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 1);
  await page.locator('#closeDetail').click();
  if (process.env.LEADS_MAP_SCREENSHOT_DIR) {
    await mkdir(process.env.LEADS_MAP_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.LEADS_MAP_SCREENSHOT_DIR}/leads-map-${width}.png`, fullPage: true });
  }
  await page.locator(`.lead-card[data-lead-id="${id(2)}"]`).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('#mapLeadMembers [aria-pressed="true"]').getAttribute('data-lead-id'), id(2));
  assert.match(await page.locator(`.lead-card[data-lead-id="${id(2)}"]`).innerText(), /No location/);
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 0);
});

for (const width of [1440, 390]) test(`all stage view has identical visible map and list membership at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = [lead(1), lead(2, { stage: 'qualified', city: 'Mobile', state: 'AL' })];
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.locator('.market-marker').first().waitFor();
  assert.equal(await page.locator('.lead-card:visible').count(), 2);
});

const matrixBoard = () => ({ ...workspace(), leads: [
  lead(1), lead(2, { stage: 'qualified', owner: 'example-partner', city: 'Mobile', state: 'AL' }),
  lead(3, { stage: 'outreach_active', owner: 'other' }),
  lead(4, { stage: 'engaged', owner: 'example-partner', city: 'Synthetic Unlocated' }),
  lead(5, { stage: 'nurture_drip', owner: 'other' }),
  lead(6, { stage: 'opportunity', owner: 'example-partner', city: 'Mobile', state: 'AL' }),
  lead(7, { stage: 'archived', owner: 'other', city: 'Synthetic Unlocated' }),
  lead(8, { stage: 'closed_lost', city: 'Mobile', state: 'AL' }),
  lead(9, { suppressed: true }), lead(10, { client_id: id(900) }),
  lead(11, { stage: 'closed_won' }), lead(12, { merged_into: id(1) }),
  lead(13, { deleted_at: '2026-10-01T16:00:00Z' }), lead(14, { do_not_contact: true }),
  lead(15, { city: null, state: null }), lead(16, { city: 'Westlake' }),
] });
const all = [1,2,3,4,5,6,7,8,15,16];
const stageCases = [['',[1,2,3,4,5,6,8,15,16]], ['new',[1,15,16]], ['qualified',[2]],
  ['outreach_active',[3]], ['engaged',[4]], ['nurture_drip',[5,8]], ['opportunity',[6]], ['archived',[7]]];
const ownerCases = [['',all], ['example-partner',[2,4,6]], ['other',[3,5,7]]];
const marketCases = [['',all], ['Pensacola, FL',[1,3,5]], ['Mobile, AL',[2,6,8]],
  ['Synthetic Unlocated, FL',[4,7]], ['Market pending',[15]], ['Westlake, FL',[16]]];
const searchCases = [['',all], [' EXAMPLE 1 ',[1,15,16]], ['Dental',all], ['Mobile',[2,6,8]], ['zzzero',[]]];
const cases = stageCases.flatMap(([stage, stageIds]) => ownerCases.flatMap(([owner, ownerIds]) =>
  marketCases.flatMap(([market, marketIds]) => searchCases.map(([search, searchIds]) => ({
    stage, owner, market, search,
    expected: stageIds.filter(n => ownerIds.includes(n) && marketIds.includes(n) && searchIds.includes(n)).map(id).sort(),
  })))));

for (const width of [1440, 390]) test(`map/list IDs, count and highlight match all ${cases.length} filter combinations at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await routeLeads(page, { getBoard: matrixBoard, onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.locator('.market-marker').first().waitFor();
  const canvas = await page.locator('#territoryMap canvas').elementHandle();
  const results = await page.evaluate(cases => {
    const $ = id => document.getElementById(id);
    const set = (id, value, type = 'change') => { $(id).value = value; $(id).dispatchEvent(new Event(type)); };
    const ids = selector => [...document.querySelectorAll(selector)].map(node => node.dataset.leadId).sort();
    return cases.map(filters => {
      set('stageFilter', filters.stage);
      set('ownerFilter', filters.owner);
      set('marketFilter', filters.market);
      set('leadSearch', filters.search, 'input');
      const cards = [...document.querySelectorAll('.lead-card')].filter(node => node.getBoundingClientRect().width > 0);
      const members = [...document.querySelectorAll('#mapLeadMembers [data-lead-id]')];
      const unlocated = members.filter(node => node.textContent.includes('No location')).map(node => node.dataset.leadId);
      const markers = [...document.querySelectorAll('.market-marker')];
      const located = markers.flatMap(node => JSON.parse(node.dataset.leadIds));
      const selected = cards[0]?.dataset.leadId;
      cards[0]?.click();
      const boardHighlight = ids('.lead-card[data-selected="true"]');
      const mapHighlight = ids('#mapLeadMembers [aria-pressed="true"]');
      const markerHighlight = [...document.querySelectorAll('.market-marker[aria-pressed="true"]')]
        .flatMap(node => JSON.parse(node.dataset.leadIds)).includes(selected);
      $('leadDetail').close();
      return { list: cards.map(node => node.dataset.leadId).sort(), members: members.map(node => node.dataset.leadId).sort(),
        represented: [...located,...unlocated].sort(), located, unlocated,
        count: markers.reduce((n,node) => n + Number(node.textContent),0) + unlocated.length,
        boardHighlight, mapHighlight, markerHighlight, selected, summary: $('filterSummary').textContent };
    });
  }, cases);
  for (let n = 0; n < cases.length; n++) {
    const result = results[n], expected = cases[n].expected, context = JSON.stringify(cases[n]);
    assert.deepEqual(result.list, expected, `visible list ${context}`);
    assert.deepEqual(result.members, expected, `map members ${context}`);
    assert.deepEqual(result.represented, expected, `markers plus no location ${context}`);
    assert.equal(result.count, expected.length, context);
    assert.match(result.summary, new RegExp(`^${expected.length} matching leads?$`), context);
    const highlight = result.selected ? [result.selected] : [];
    assert.deepEqual(result.boardHighlight, highlight, context);
    assert.deepEqual(result.mapHighlight, highlight, context);
    assert.equal(result.markerHighlight, Boolean(result.selected && result.located.includes(result.selected)), context);
  }
  assert.ok(await canvas.evaluate(node => node.isConnected), 'filtering preserves the renderer');
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
});

for (const width of [1440,390]) test(`marker selection survives matching filters and clears when excluded at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = matrixBoard();
  await routeLeads(page, { getBoard: () => board });
  await page.goto('http://localhost/leads');
  await page.locator('.market-marker').first().waitFor();
  await page.locator('#stageFilter').selectOption('qualified', { force: true });
  await page.getByRole('button', { name: 'Mobile, AL: 1 leads', exact: true }).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('#detailTitle').innerText(), 'Dr. Example 2');
  await page.locator('#closeDetail').click();
  await page.locator('#stageFilter').selectOption('', { force: true });
  await page.locator('#ownerFilter').selectOption('example-partner', { force: true });
  assert.equal(await page.locator('.lead-card[data-selected="true"]').getAttribute('data-lead-id'), id(2));
  assert.equal(await page.locator('#mapLeadMembers [aria-pressed="true"]').getAttribute('data-lead-id'), id(2));
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 1);
  await page.locator('#ownerFilter').selectOption('other', { force: true });
  assert.equal(await page.locator('.lead-card[data-selected="true"]').count(), 0);
  assert.equal(await page.locator('#mapLeadMembers [aria-pressed="true"]').count(), 0);
  assert.equal(await page.locator('.market-marker[aria-pressed="true"]').count(), 0);
  await page.locator('#ownerFilter').selectOption('', { force: true });
  assert.equal(await page.locator('.lead-card[data-selected="true"]').count(), 0, 'cleared selection does not resurrect');
  await page.locator('#stageFilter').selectOption('qualified', { force: true });
  assert.equal(await page.locator('.lead-card:visible').count(), 1);
  assert.equal(await page.locator('#mapLeadMembers [data-lead-id]').getAttribute('data-lead-id'), id(2));
});
