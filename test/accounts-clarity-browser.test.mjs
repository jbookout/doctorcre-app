import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Account phases stay complete at ${width}px ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    const shot = async name => {
      if (!process.env.UI_SCREENSHOT_DIR) return;
      await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/${name}-${width}-${theme}.png`, fullPage: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/${name}-${width}-${theme}-viewport.png` });
    };
    await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
    const card = page.locator('.account-card').first();
    await card.waitFor();
    const accountName = await card.locator('h2').innerText();
    const owner = await card.locator('.account-owner').getAttribute('title');
    await shot('accounts');
    const metricOffset = await card.evaluate(node => node.querySelector('.account-metrics').getBoundingClientRect().top - node.getBoundingClientRect().top);
    assert.ok(metricOffset <= 160, `account metrics start ${metricOffset}px into the card`);
    assert.match(await card.innerText(), /Open account/);
    await card.click();
    await page.locator('#accountGrid').waitFor({ state: 'hidden' });
    await shot('detail');
    const phases = await page.locator('select[data-phase]').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return { label: node.selectedOptions[0].textContent, width: node.clientWidth,
        needed: context.measureText(node.selectedOptions[0].textContent).width + 28 };
    }));
    assert.ok(phases.length > 0);
    assert.ok(phases.every(phase => phase.width >= phase.needed), JSON.stringify(phases));
    assert.equal(await page.locator('#boardSection h1').count(), 1, 'the main detail names the selected national account');
    assert.equal(await page.locator('#boardSection h1').innerText(), accountName);
    assert.equal(await page.locator('#accountContextOwner').innerText(), owner);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}
