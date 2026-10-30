import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { lead, workspace } from './leads-workspace-fixture.mjs';

for (const width of [390, 1440]) test(`Specialty filters the board and territory together at ${width}px`, async t => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = [lead(1), lead(2, { specialty: 'Veterinary' }), lead(3, { specialty: 'Dental', city: 'Mobile', state: 'AL' })];
  const writes = [];
  await routeLeads(page, { getBoard: () => board, onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard .lead-card').first().waitFor();
  await page.getByRole('button', { name: 'Show territory', exact: true }).click();
  await page.locator('.market-marker').first().waitFor();
  const canvas = await page.locator('.maplibregl-canvas').elementHandle();
  const specialty = page.locator('#specialtyFilter');
  await specialty.focus();
  await specialty.selectOption('Dental');
  assert.equal(await specialty.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(await page.locator('#leadBoard .lead-card').evaluateAll(nodes => nodes.map(node => node.dataset.leadId)), [lead(1).id, lead(3).id]);
  assert.equal(await page.locator('#filterSummary').textContent(), '2 matching leads');
  await page.waitForFunction(() => [...document.querySelectorAll('.market-marker')].flatMap(node => JSON.parse(node.dataset.leadIds)).length === 2);
  assert.deepEqual(await page.locator('.market-marker').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.dataset.leadIds)).sort()), [lead(1).id, lead(3).id]);
  assert.equal(await canvas.evaluate(node => node === document.querySelector('.maplibregl-canvas')), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mkdir('test-artifacts/wr221-specialty', { recursive: true });
  await page.screenshot({ path: `test-artifacts/wr221-specialty/leads-${width}.png`, fullPage: true });
  await page.locator('#marketFilter').selectOption('Mobile, AL');
  assert.deepEqual(await page.locator('#leadBoard .lead-card').evaluateAll(nodes => nodes.map(node => node.dataset.leadId)), [lead(3).id]);
  await specialty.selectOption('Veterinary');
  assert.equal(await page.getByText('No leads match these filters.', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  assert.equal(await specialty.inputValue(), '');
  assert.equal(await page.locator('#leadBoard .lead-card').count(), 3);
  assert.deepEqual(writes, []);
});

for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
  test(`Leads uneven board stays readable and stage navigation stays usable at ${width}px ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce', colorScheme: theme });
    const board = workspace();
    board.leads = Array.from({ length: 45 }, (_, n) => lead(n + 1, {
      doctor_name: `Synthetic practice ${n + 1}`, owner: 'example-partner',
      stage: n < 43 ? 'new' : 'qualified', score: 90 - n,
    }));
    const writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await routeLeads(page, { getBoard: () => board, onWrite: value => writes.push(value) });
    await page.goto('http://localhost/leads');
    await page.locator('.lead-card').first().waitFor();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('#appSidebarToggle').waitFor();
    assert.equal(await page.locator('select:visible').filter({ has: page.locator('option[value="qualified"]') }).count(), 1, 'one visible stage selector serves the board');
    if (width === 390) {
      await page.mouse.move(195, 600);
      await page.mouse.wheel(0, 1600);
      await page.waitForFunction(() => scrollY > 1000);
      await page.waitForFunction(() => document.querySelector('.stage-nav').getBoundingClientRect().top <= 100);
    } else {
      await page.evaluate(() => scrollTo(0, document.querySelector('#leadBoard').getBoundingClientRect().top + scrollY - 80));
    }
    const layout = await page.evaluate(() => {
      const select = document.querySelector('#stageFilter'), r = select.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        headerBottom: document.querySelector('.app-layout-tabbar').getBoundingClientRect().bottom,
        navTop: document.querySelector('.stage-nav').getBoundingClientRect().top,
        selectTop: r.top, selectHit: hit === select, hitClass: hit?.className,
        lanes: [...document.querySelectorAll('.stage-column')].filter(node => node.getBoundingClientRect().width > 0).map(node => ({ stage: node.dataset.stage, width: node.getBoundingClientRect().width })),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    if (process.env.LEADS_SCREENSHOT_DIR) {
      await mkdir(process.env.LEADS_SCREENSHOT_DIR, { recursive: true });
      const path = `${process.env.LEADS_SCREENSHOT_DIR}/leads-${width}-${theme}`;
      await page.screenshot({ path: `${path}.png` });
      await writeFile(`${path}.json`, JSON.stringify(layout, null, 2));
    }
    assert.equal(layout.overflow, false);
    if (width === 390) {
      assert.ok(layout.navTop >= layout.headerBottom, JSON.stringify(layout));
      assert.equal(layout.selectHit, true, 'stage selector receives its own center hit after wheel scrolling');
      await page.locator('#stageFilter').selectOption('qualified');
      await page.waitForFunction(() => document.querySelector('[data-stage="qualified"]').getBoundingClientRect().width > 0);
      assert.equal(await page.locator('.stage-column:visible .lead-card').count(), 2);
      assert.equal(await page.locator('#stageFilter').evaluate(select => {
        const r = select.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === select;
      }), true, 'stage selection scroll keeps the selector unobscured');
      await page.locator('#stageFilter').selectOption('engaged');
      assert.equal(await page.locator('.filtered-empty p').innerText(), 'No leads match these filters.');
    } else {
      assert.equal(layout.lanes.length, 2, 'only populated stages consume desktop width');
      assert.ok(layout.lanes.every(lane => lane.width >= 280), JSON.stringify(layout));
      const card = page.locator('.lead-card').first();
      await card.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
      assert.equal(await page.locator('.stage-column:visible').count(), 6, 'drag still offers every stage destination');
      await card.dispatchEvent('dragend');
      assert.equal(await page.locator('.stage-column:visible').count(), 2);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  });
}

for (const width of [1440, 390]) test(`Lead lanes start with five cards and expand without losing their controls at ${width}px`, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = Array.from({ length: 200 }, (_, n) => lead(n + 1, {
    doctor_name: `Synthetic practice ${n + 1}`, stage: n < 100 ? 'new' : 'qualified',
  }));
  const writes = [];
  await routeLeads(page, { getBoard: () => board, onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  const lane = page.locator('.stage-column[data-stage="new"]');
  await lane.locator('.lead-card').first().waitFor();
  assert.equal(await lane.locator('.lead-card').count(), 5);
  if (process.env.LEADS_SCREENSHOT_DIR) {
    await mkdir(process.env.LEADS_SCREENSHOT_DIR, { recursive: true });
    await lane.screenshot({ path: `${process.env.LEADS_SCREENSHOT_DIR}/bounded-${width}.png` });
  }
  assert.equal(await page.locator('#filterSummary').innerText(), '200 matching leads');
  const expand = lane.getByRole('button', { name: 'Show all 100 New leads', exact: true });
  await expand.focus();
  await page.keyboard.press('Enter');
  const collapse = lane.getByRole('button', { name: 'Collapse New to 5 leads', exact: true });
  assert.equal(await lane.locator('.lead-card').count(), 100);
  assert.equal(await page.locator('.stage-column[data-stage="qualified"] .lead-card').count(), 5);
  assert.equal(await collapse.evaluate(node => node === document.activeElement), true);
  await lane.evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY));
  const control = await collapse.evaluate(node => {
    const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { reachable: hit === node, top: r.top, hit: hit?.outerHTML.slice(0,200), navBottom: document.querySelector('.stage-nav').getBoundingClientRect().bottom, header: getComputedStyle(node.parentElement).top };
  });
  assert.equal(control.reachable, true, JSON.stringify(control));
  const headTop = await lane.locator('.stage-head').evaluate(node => node.getBoundingClientRect().top);
  await lane.locator('.lead-stack').evaluate(node => node.scrollTop = 900);
  assert.equal(await lane.locator('.stage-head').evaluate(node => node.getBoundingClientRect().top), headTop);
  if (process.env.LEADS_SCREENSHOT_DIR) await lane.screenshot({ path: `${process.env.LEADS_SCREENSHOT_DIR}/expanded-${width}.png` });
  await page.locator('#refreshBoard').click();
  await page.waitForFunction(() => document.querySelector('#leadBoard').getAttribute('aria-busy') === 'false');
  assert.equal(await lane.locator('.lead-card').count(), 100);
  assert.equal(await lane.locator('.lead-stack').evaluate(node => node.scrollTop), 900);
  await lane.locator('.lead-card').last().getByRole('button', { name: 'Synthetic practice 100', exact: true }).click();
  await page.locator('#detailStage').waitFor();
  assert.equal(await page.locator('#detailTitle').innerText(), 'Synthetic practice 100');
  await page.locator('#closeDetail').click();
  assert.equal(await collapse.evaluate(node => {
    const r = node.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node;
  }), true, 'Collapse remains reachable at the final lead');
  await collapse.click();
  assert.equal(await lane.locator('.lead-card').count(), 5);
  await page.locator('#leadSearch').fill('Synthetic practice 100');
  assert.equal(await lane.locator('.lead-card').count(), 1, 'search reaches leads outside the initial five');
  assert.equal(await lane.locator('.lead-open').innerText(), 'Synthetic practice 100');
  assert.deepEqual(writes, []);
});

for (const width of [390,1440]) for (const theme of ['light','dark']) test(`lead board targets and empty stages ${width} ${theme}`, async t => {
 const browser=await chromium.launch(); t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme});
 await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
 const board=workspace(); board.leads=[lead(1,{stage:'new',doctor_name:'Demo practice'})];
 await routeLeads(page,{getBoard:()=>board}); await page.goto('http://localhost/leads');
 await page.locator('.lead-card').first().waitFor();
 const controls=page.locator('.lead-card :is(.lead-open, [data-claim], .drag-handle):visible');
 assert.equal(await controls.count(),3);
 for(const control of await controls.all()) { const box=await control.boundingBox(); assert.ok(box.width>=44 && box.height>=44, await control.evaluate(n=>n.className||n.outerHTML)); }
 await mkdir('out/test-artifacts/WR572.S6.J1',{recursive:true});
 await page.screenshot({path:`out/test-artifacts/WR572.S6.J1/leads-${width}-${theme}.png`});
});
