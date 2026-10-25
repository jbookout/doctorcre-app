import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';

for (const width of [390, 800, 1280]) for (const theme of ['dark', 'light']) {
  test(`Lead filters and records precede supporting panels at ${width}px ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routeLeads(page);
    await page.goto('http://localhost/leads');
    await page.getByRole('button', { name: 'Show territory', exact: true }).click();
    await page.locator('.market-marker').first().waitFor();
    if (process.env.UI_SCREENSHOT_DIR) {
      await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/leads-${width}-${theme}.png`, fullPage: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/leads-${width}-${theme}-viewport.png` });
    }
    assert.equal(await page.locator('#leadSearch').isVisible(), true, 'search is available in the main page');
    const controlsFit = await page.locator('.controls').evaluate(node => {
      const box = node.getBoundingClientRect();
      return [...node.querySelectorAll('input, select, output')].every(child => {
        const bounds = child.getBoundingClientRect();
        return bounds.left >= box.left && bounds.right <= box.right;
      });
    });
    assert.equal(controlsFit, true, 'filters fit the available main-column width');
    {
      const positions = await page.evaluate(() => Object.fromEntries(['#leadSearch', '.lead-card', '.top-grid'].map(selector => [selector, document.querySelector(selector).getBoundingClientRect().top])));
      assert.ok(positions['#leadSearch'] < positions['.lead-card'], JSON.stringify(positions));
      assert.ok(positions['.lead-card'] < 700, 'matching records start on the first screen');
      assert.ok(positions['.lead-card'] < positions['.top-grid'], 'matching records precede territory and global candidates');
    }

    await page.locator('#stageFilter').selectOption('qualified');
    assert.equal(await page.locator('#leadCount').innerText(), '14 total');
    assert.equal(await page.locator('#filterSummary').innerText(), '1 matching lead');
    assert.match(await page.locator('#hotSummary').innerText(), /Across all markets and filters/);
    if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/qualified-${width}-${theme}.png`, fullPage: true });
    await page.locator('.lead-card:visible').first().click();
    await page.locator('#detailStage').waitFor();
    if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/detail-${width}-${theme}.png`, fullPage: true });
    const detailLayout = await page.locator('#detailBody').evaluate(node => {
      const score = node.querySelector('.detail-score').getBoundingClientRect();
      const stage = node.querySelector('#detailStage').getBoundingClientRect();
      const contact = [...node.querySelectorAll('h3')].find(heading => heading.textContent === 'Contact').getBoundingClientRect();
      return { scoreTop: score.top, stageTop: stage.top, contactTop: contact.top,
        panelsAreFlat: [...node.querySelectorAll('.detail-panel')].every(panel => {
          const style = getComputedStyle(panel);
          return style.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(style.borderLeftWidth) === 0 && parseFloat(style.borderRadius) === 0;
        }) };
    });
    assert.ok(detailLayout.scoreTop < detailLayout.contactTop && detailLayout.stageTop < detailLayout.contactTop, 'score and stage action lead the detail');
    assert.equal(detailLayout.panelsAreFlat, true, 'detail groups use spacing and dividers instead of nested cards');
    const detailText = await page.locator('#detailBody').innerText();
    assert.doesNotMatch(detailText, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i, 'human details do not expose raw record UUIDs');
    const sizes = await page.locator('.lead-location, #mapLeadMembers small, .history small').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
    assert.ok(sizes.every(size => size >= 13), JSON.stringify(sizes));
    await page.locator('#closeDetail').click();
    await page.locator('#leadSearch').fill('no-synthetic-result');
    assert.equal(await page.locator('.lead-card').count(), 0);
    assert.equal(await page.locator('#filterSummary').innerText(), '0 matching leads');
    if (process.env.UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/empty-${width}-${theme}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}
