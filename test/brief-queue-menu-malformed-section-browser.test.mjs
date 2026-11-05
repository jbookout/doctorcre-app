import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { exerciseQueueMenu } from '../scripts/prove-brief-queue-menu-malformed-section.mjs';

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`malformed menu recovers and disposes at ${width}px in ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.route('**/malformed-menu-fixture', route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/morning-brief.css"><body><div id="morningQueueMenu"></div><main></main></body>' }));
    await page.goto(`${server.origin}/malformed-menu-fixture`);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.ok((await page.evaluate(exerciseQueueMenu)).every(result => result.passed));
    await page.evaluate(async () => {
      const { createBriefQueueView } = await import('/js/ui-queue.js');
      window.view = createBriefQueueView(document.querySelector('#morningQueueMenu'), document.querySelector('main'));
      window.view.renderMenu({ sponsor: 'joe', sections: { today: { items: null, total: 1 }, loops: { items: [], total: 0 } } });
    });
    const button = page.getByRole('button', { name: 'Today queue · coverage unknown', exact: true });
    await button.focus();
    assert.equal(await button.evaluate(node => document.activeElement === node), true);
    assert.equal(await button.isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Open loops · 0 of 0', exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => window.view.dispose());
    assert.equal(await page.locator('button').count(), 0);
  });
}
