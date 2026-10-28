import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

async function accountPage(t, width, theme) {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date('2026-10-19T15:00:00Z'));
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator('.account-card').first().waitFor();
  return page;
}

async function screenshot(page, name, width, theme) {
  if (!process.env.UI_SCREENSHOT_DIR) return;
  await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/${name}-${width}-${theme}.png` });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Portfolio card leads with the oldest overdue action at ${width}px ${theme}`, async t => {
    const page = await accountPage(t, width, theme);
    const card = page.locator('.account-card').first();
    await screenshot(page, 'cards', width, theme);
    const urgency = card.locator('.account-next-action');
    assert.equal(await urgency.count(), 1, 'the card names one next action');
    assert.match(await urgency.innerText(), /Review sample documents/);
    assert.match(await urgency.innerText(), /Jan 18 · 274d overdue/);
    const hierarchy = await card.evaluate(node => {
      const action = node.querySelector('.account-next-action');
      const structure = node.querySelector('.account-flow-labels');
      return { actionTop: action.offsetTop, structureTop: structure.offsetTop,
        actionSize: parseFloat(getComputedStyle(action.querySelector('strong')).fontSize),
        metricSize: parseFloat(getComputedStyle(node.querySelector('.account-metrics b')).fontSize) };
    });
    assert.ok(hierarchy.actionTop < hierarchy.structureTop, 'action precedes the structure breadcrumb');
    assert.ok(hierarchy.actionSize > hierarchy.metricSize, 'action dominates supporting counts');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });

  test(`Opening an account action keeps its description and due date in the update form at ${width}px ${theme}`, async t => {
    const page = await accountPage(t, width, theme);
    await page.locator('.account-card').first().click();
    await screenshot(page, 'account', width, theme);
    const action = page.locator('#stats .next-account-action');
    const description = await action.locator('strong').innerText();
    await action.click();
    await page.waitForURL('**/deals?deal=*');
    await page.locator('#detailUpdateForm').waitFor();
    await screenshot(page, 'record', width, theme);
    assert.equal(await page.locator('#dealUpdateStep').inputValue(), description);
    assert.equal(await page.locator('#dealUpdateDate').inputValue(), '2026-01-18');
    assert.match(await page.locator('#detailUpdateDateHint').innerText(), /overdue/i);
    assert.equal(await page.locator('#dealUpdateDate').getAttribute('aria-describedby'), 'detailUpdateDateHint');
    assert.equal(await page.locator('.deal-updates').count(), 0, 'an account action without notes omits Updates');
    assert.equal(await page.locator('#dealUpdate').getAttribute('placeholder'), null);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}

for (const theme of ['dark', 'light']) for (const sidebarOpen of [false, true]) {
  test(`Account columns stay readable with the sidebar ${sidebarOpen ? 'open' : 'closed'} in ${theme}`, async t => {
    const page = await accountPage(t, 1280, theme);
    await page.locator('.account-card').first().click();
    if (sidebarOpen) await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
    assert.equal(await page.locator('.app-layout').getAttribute('data-sidebar'), sidebarOpen ? 'open' : 'closed');
    const captureName = sidebarOpen ? 'columns-sidebar' : 'columns';
    await screenshot(page, captureName, 1280, theme);
    const headings = page.locator('#tableFrame thead');
    assert.match(await headings.textContent(), /Work record.*Phase.*Next step.*Next date/s);
    if (sidebarOpen) {
      assert.equal(await page.locator('#rows tr').first().locator('td').nth(2).evaluate(node => getComputedStyle(node, '::before').content), '"Next step"');
    } else {
      const geometry = await headings.boundingBox();
      assert.ok(geometry && geometry.height >= 24 && geometry.width > 400, 'wide workspace column headings remain visible');
    }
    const rows = await page.locator('#rows tr').evaluateAll(rows => rows.map(row => {
      const step = row.querySelector('.step-button');
      const range = document.createRange();
      range.selectNodeContents(step);
      const nameRange = document.createRange();
      nameRange.selectNodeContents(row.querySelector('.deal-link'));
      const metadata = [...row.querySelectorAll('.deal-meta span')].map(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return { text: node.textContent, lines: range.getClientRects().length };
      });
      return { text: step.textContent, lines: range.getClientRects().length,
        nameLines: nameRange.getClientRects().length, metadata,
        phaseWidth: row.querySelector('select[data-phase]').getBoundingClientRect().width,
        stepWidth: step.getBoundingClientRect().width };
    }));
    if (process.env.UI_SCREENSHOT_DIR) await writeFile(`${process.env.UI_SCREENSHOT_DIR}/${captureName}-1280-${theme}.json`, JSON.stringify(rows, null, 2));
    assert.ok(rows.every(row => row.lines <= 2), JSON.stringify(rows));
    assert.ok(rows.every(row => row.nameLines <= 2 && row.metadata.every(item => item.lines <= 1)), JSON.stringify(rows));
    assert.ok(rows.every(row => row.stepWidth > row.phaseWidth), JSON.stringify(rows));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => document.querySelector('#tableFrame').scrollWidth > document.querySelector('#tableFrame').clientWidth), false);
  });
}
