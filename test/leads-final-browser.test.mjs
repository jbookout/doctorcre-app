import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, settles } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { lead, workspace } from './leads-workspace-fixture.mjs';

async function capture(page, name, measurements) {
  if (!process.env.LEADS_FINAL_DIR) return;
  await mkdir(process.env.LEADS_FINAL_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.LEADS_FINAL_DIR}/${name}.png` });
  await writeFile(`${process.env.LEADS_FINAL_DIR}/${name}.json`, JSON.stringify(measurements, null, 2));
}

test('An unclaimed New lead can be claimed on the first screen of a 45-lead board', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = Array.from({ length: 45 }, (_, n) => lead(n + 1, {
    stage: n < 43 ? 'new' : 'qualified', owner: n === 1 ? 'example-partner' : null,
  }));
  const writes = [];
  await routeLeads(page, { getBoard: () => board, onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  const claim = page.locator('#leadBoard').getByRole('button', { name: 'Claim', exact: true }).first();
  assert.ok(await claim.count(), 'the board exposes a labelled Claim action');
  const bounds = await claim.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 900, `Claim is on the first screen: ${JSON.stringify(bounds)}`);
  assert.equal(await page.locator('.lead-card').nth(1).getByRole('button', { name: 'Claim', exact: true }).count(), 0, 'owned leads cannot be claimed');
  assert.equal(await page.locator('[data-stage="qualified"] [data-claim]').count(), 0, 'Claim follows existing New-lead eligibility');
  await claim.focus();
  await page.keyboard.press('Space');
  await settles(async () => assert.equal(await page.locator('#moveAnnouncement').innerText(), 'Lead claimed'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'claim-lead');
  assert.equal(writes[0].arguments.lead, 'L-1');
  assert.equal(await page.locator('#leadDetail').evaluate(node => node.open), false);
});

for (const width of [390, 768, 1280, 1440]) for (const theme of ['dark', 'light']) {
  test(`The selected stage fills the board at ${width}px ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    const board = workspace();
    board.leads = Array.from({ length: 45 }, (_, n) => lead(n + 1, { stage: n < 43 ? 'new' : 'qualified' }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await routeLeads(page, { getBoard: () => board });
    await page.goto('http://localhost/leads');
    await page.locator('.market-marker').first().waitFor();
    const claim = await page.locator('#leadBoard [data-claim]').first().boundingBox();
    assert.ok(claim.y >= 0 && claim.y + claim.height < 900, 'Claim is visible without scrolling');
    await capture(page, `${width}-${theme}-board`, { claim });
    await page.locator('#stageFilter').selectOption('qualified');
    const layout = await page.evaluate(() => {
      const board = document.querySelector('#leadBoard').getBoundingClientRect();
      const stages = [...document.querySelectorAll('.stage-column')].map(node => node.getBoundingClientRect()).filter(box => box.width);
      return { boardWidth: board.width, stageWidths: stages.map(box => box.width), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    await capture(page, `${width}-${theme}-qualified`, layout);
    assert.deepEqual(layout.stageWidths.map(value => Math.round(value)), [Math.round(layout.boardWidth)], JSON.stringify(layout));
    assert.equal(await page.locator('.stage-column:visible .lead-card').count(), 2);
    assert.equal(layout.overflow, false);
    assert.deepEqual(errors, []);
  });

  test(`An empty board offers one explanation and a working refresh at ${width}px ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    const board = workspace();
    board.leads = [];
    const writes = [];
    let reads = 0;
    await routeLeads(page, { getBoard: () => board, onRead: () => reads++, onWrite: value => writes.push(value) });
    await page.goto('http://localhost/leads');
    await page.locator('#leadBoard[aria-busy="false"]').waitFor();
    const content = await page.locator('#leadBoard').innerText();
    await capture(page, `${width}-${theme}-empty`, { content });
    assert.equal(await page.locator('#leadBoard .stage-column').count(), 0, 'empty boards do not render six empty stages');
    assert.equal(await page.locator('#leadBoard p').count(), 1);
    assert.equal(await page.locator('#leadBoard p').innerText(), 'No active leads are on the board.');
    assert.equal(await page.locator('#leadBoard button').count(), 1);
    assert.equal(await page.locator('.top-grid').isVisible(), false, 'a genuinely empty board has no empty supporting panels');
    const before = reads;
    board.leads = [lead(1)];
    await page.locator('#leadBoard').getByRole('button', { name: 'Refresh leads', exact: true }).click();
    await page.locator('.lead-card').waitFor();
    assert.ok(reads > before, 'the empty-state action fetches a fresh board');
    await page.locator('#leadSearch').fill('no-synthetic-match');
    assert.equal(await page.locator('.top-grid').isVisible(), true, 'global claim candidates remain available for filtered emptiness');
    await capture(page, `${width}-${theme}-filtered-empty`, { content: await page.locator('#leadBoard').innerText() });
    await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
    assert.equal(await page.locator('#leadSearch').evaluate(node => node === document.activeElement), true, 'reset returns focus to search');
    assert.equal(await page.locator('.lead-card').count(), 1);
    assert.deepEqual(writes, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}
