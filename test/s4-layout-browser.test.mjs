import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Doc Activity keeps timestamps clear of undo controls at ${width}px in ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.goto(`${server.origin}/doc-activity`);
    await page.locator('.activity-row').first().waitFor();
    const rows = await page.locator('.activity-row').evaluateAll(nodes => nodes.map(node => {
      const time = node.querySelector('.activity-time').getBoundingClientRect();
      const action = node.querySelector('.activity-row-action').getBoundingClientRect();
      return { title: node.querySelector('strong').textContent, clear: time.bottom <= action.top || time.right <= action.left };
    }));
    assert.deepEqual(rows.filter(row => !row.clear), []);
  });
}
