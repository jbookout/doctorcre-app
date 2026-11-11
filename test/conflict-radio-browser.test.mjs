import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, animationsSettled } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`conflict choices keep native radios beside their captions at ${width}px ${theme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
    await page.route('**/js/app.js', route => route.fulfill({ contentType: 'text/javascript',
      body: source + '\nglobalThis.radioTest={showConflict,nextStepForm,state};' }));
    await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
    await page.waitForFunction(() => window.radioTest?.state.deals.size > 0);
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      window.radioTest.showConflict({ conflict_id: 'synthetic-conflict', field: 'attention',
        a: { actor: 'dell', value: true }, b: { actor: 'joe', value: false } });
    }, theme);
    const radios = page.locator('#dialogBody input[type="radio"]');
    await radios.first().waitFor();
    await animationsSettled(page);
    await radios.first().focus();
    if (process.env.UI_SCREENSHOT_DIR) {
      await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/conflict-${width}-${theme}.png` });
    }
    const geometry = await radios.evaluateAll(nodes => nodes.map(radio => {
      const box = radio.getBoundingClientRect();
      const label = radio.closest('label');
      const caption = label.querySelector('strong').getBoundingClientRect();
      return { width: box.width, height: box.height, captionLeft: caption.left, right: box.right,
        top: box.top, bottom: box.bottom, captionTop: caption.top, captionBottom: caption.bottom,
        targetHeight: label.getBoundingClientRect().height };
    }));
    assert.equal(geometry.length, 2);
    for (const box of geometry) {
      assert.ok(box.width > 0 && box.width <= 24, `radio width ${box.width}px`);
      assert.ok(box.height > 0 && box.height <= 24, `radio height ${box.height}px`);
      assert.ok(box.captionLeft >= box.right, 'caption sits beside the radio');
      assert.ok(box.captionTop < box.bottom && box.captionBottom > box.top, 'caption shares the radio line');
      assert.ok(box.targetHeight >= 44, 'label preserves a 44px touch target');
    }
    await page.getByText('Your proposed value', { exact: true }).click();
    assert.equal(await radios.nth(1).isChecked(), true);
    assert.equal(await radios.first().isChecked(), false);
    await page.keyboard.press('ArrowUp');
    assert.equal(await radios.first().isChecked(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const app = window.radioTest;
      app.nextStepForm([...app.state.deals.keys()][0]);
    });
    const text = await page.locator('#stepText').evaluate(input => ({
      width: input.getBoundingClientRect().width,
      fieldWidth: input.closest('.field').getBoundingClientRect().width,
      height: input.getBoundingClientRect().height,
    }));
    assert.ok(Math.abs(text.width - text.fieldWidth) < 1, 'text input remains full width');
    assert.ok(text.height >= 44, 'text input keeps its touch height');
  });
}
