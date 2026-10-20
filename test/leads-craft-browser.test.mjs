import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, settles } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';

const require = createRequire(import.meta.url);
async function capture(page, name, measurements = {}) {
  if (!process.env.LEADS_CRAFT_DIR) return;
  await mkdir(process.env.LEADS_CRAFT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.LEADS_CRAFT_DIR}/${name}.png` });
  await writeFile(`${process.env.LEADS_CRAFT_DIR}/${name}.json`, JSON.stringify(measurements, null, 2));
}

test('Lead opening and actions are separate accessible keyboard controls', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const writes = [];
  await routeLeads(page, { onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.locator('.market-marker').first().waitFor();
  await page.route('**/__axe.js', route => route.fulfill({ path: require.resolve('axe-core/axe.min.js'), contentType: 'text/javascript' }));
  await page.addScriptTag({ url: 'http://localhost/__axe.js' });
  const violations = await page.evaluate(async () => (await axe.run('.leads-workspace', { runOnly: ['nested-interactive'] })).violations);
  await capture(page, '1440-accessibility', violations);
  assert.deepEqual(violations, [], 'axe reports zero nested-interactive violations including Claim, Link and Undo');
  const opener = page.locator('.hot-row').first().getByRole('button', { name: 'Dr. Example 1', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  await page.locator('#detailStage').waitFor();
  await page.locator('#closeDetail').click();
  await settles(async () => assert.equal(await opener.evaluate(node => node === document.activeElement), true, 'closing details restores the opening control'));
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.hot-row').first().getByRole('button', { name: 'Claim', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#moveAnnouncement').textContent === 'Lead claimed');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'claim-lead');
  assert.equal(await page.locator('#leadDetail').evaluate(node => node.open), false, 'Claim does not open details');
  await page.getByRole('button', { name: 'Link Dr. Example 19 to Example Client Match', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#moveAnnouncement').textContent === 'Client linked');
  assert.equal(writes.at(-1).name, 'link-lead-client');
  assert.equal(await page.locator('#leadDetail').evaluate(node => node.open), false, 'Link does not open details');
  await page.getByRole('button', { name: 'Undo', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('#stageDialog[open] .stage-proposal').waitFor();
  assert.equal(await page.locator('#leadDetail').evaluate(node => node.open), false, 'Undo opens stage review only');
  assert.equal(writes.length, 2, 'Undo requires review before writing');
  await page.locator('#closeStage').click();
  const boardOpener = page.locator('.lead-card .lead-open').first();
  await boardOpener.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await page.locator('#stageDialog[open] .stage-proposal').waitFor();
  assert.match(await page.locator('.stage-proposal').innerText(), /New.*Qualified/s);
  assert.equal(writes.length, 2);
});

for (const width of [768, 1280, 1440]) for (const theme of ['light', 'dark']) {
  test(`Lead stages pack independently and names stay readable at ${width}px mouse ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 1024 }, reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routeLeads(page);
    await page.goto('http://localhost/leads');
    await page.locator('.market-marker').first().waitFor();
    const layout = await page.evaluate(() => {
      const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, bottom: r.bottom }; };
      return {
        stages: [...document.querySelectorAll('.stage-column')].map(box).filter(r => r.width),
        names: [...document.querySelectorAll('.hot-row h3')].map(box),
        hot: box(document.querySelector('.hot-section')), territory: box(document.querySelector('.territory')),
        todayHidden: document.querySelector('#appToday').inert,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    await capture(page, `${width}-${theme}-first`, layout);
    await page.locator('.territory').scrollIntoViewIfNeeded();
    await capture(page, `${width}-${theme}-territory`, layout);
    assert.equal(layout.overflow, false);
    assert.ok(layout.names.every(r => r.width >= 160), 'each lead name gets at least 160px of text width');
    for (const stage of layout.stages) {
      const previous = layout.stages.filter(r => Math.abs(r.x - stage.x) < 2 && r.y < stage.y).sort((a, b) => b.y - a.y)[0];
      if (previous) assert.ok(stage.y - previous.bottom <= 20, `stage gap is ${stage.y - previous.bottom}px at ${width}px`);
    }
    if (width === 768) {
      assert.equal(layout.todayHidden, true, 'Today collapses for a mouse at tablet width');
      assert.ok(layout.territory.y >= layout.hot.bottom, 'supporting panels stack');
      await page.locator('#appTodayToggle').click();
      assert.equal(await page.locator('#appToday').evaluate(node => node.inert), false, 'Today remains reachable');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#appToday').evaluate(node => node.inert), true);
    }
  });
}

test('Filtered-empty Leads explains the result and resets every filter without a write', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 768, height: 1024 }, reducedMotion: 'reduce' });
  const writes = [];
  await routeLeads(page, { onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  await page.locator('#stageFilter').selectOption('archived');
  await page.locator('#ownerFilter').selectOption('example-partner');
  await page.locator('#marketFilter').selectOption('Pensacola, FL');
  await page.locator('#leadSearch').fill('no-synthetic-match');
  await capture(page, '768-empty');
  assert.match(await page.locator('#leadBoard').innerText(), /No leads match these filters\./);
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  for (const selector of ['#leadSearch', '#stageFilter', '#ownerFilter', '#marketFilter']) assert.equal(await page.locator(selector).inputValue(), '');
  assert.equal(await page.locator('.lead-card:visible').count(), 14);
  assert.deepEqual(writes, []);
});

for (const width of [768, 1280, 1440]) test(`Leads loading uses board, ranked-row and map skeletons at ${width}px`, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1024 }, reducedMotion: 'reduce' });
  await routeLeads(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route('**/mcp', async route => {
    const params = route.request().postDataJSON().params;
    if (params.name === 'lead-board') await held;
    await route.fallback();
  });
  await page.goto('http://localhost/leads');
  await page.locator('#appSidebarToggle').waitFor();
  await capture(page, `${width}-loading`);
  assert.ok(await page.locator('#leadBoard .lead-skeleton').count() >= 6, 'loading reserves stage and card shapes');
  assert.equal(await page.locator('#hotLeads .hot-skeleton').count(), 5);
  assert.equal(await page.locator('#territoryMap').getAttribute('aria-busy'), 'true');
  const loadingWidth = await page.locator('.stage-column').first().evaluate(node => node.getBoundingClientRect().width);
  release();
  await page.locator('.lead-card').first().waitFor();
  assert.equal(await page.locator('#leadBoard .lead-skeleton, #hotLeads .hot-skeleton').count(), 0);
  const loadedWidth = await page.locator('.stage-column').first().evaluate(node => node.getBoundingClientRect().width);
  assert.ok(Math.abs(loadingWidth - loadedWidth) < 2, 'loading and final stage widths match');
  assert.equal(await page.locator('#territoryMap').getAttribute('aria-busy'), 'false');
});
