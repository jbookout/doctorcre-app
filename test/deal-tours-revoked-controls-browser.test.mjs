import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { chromium } from './browser-harness.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';

test('retired tour workspace refuses UI re-entry after session invalidation', async t => {
  const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
  const browser = await chromium.launch({ args: CHROMIUM_SAFETY_ARGS });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="view"></div>' }));
  await page.goto('http://fixture.test/deals');
  const result = await page.evaluate(async source => {
    const { mountDealTours } = await import('data:text/javascript;base64,' + source);
    let reads = 0, navigations = 0;
    const root = document.querySelector('#view');
    const panel = mountDealTours(root, { dealId: '11111111-1111-4111-8111-111111111111', client: { library: async () => { ++reads; return []; } }, navigate() { ++navigations; } });
    await new Promise(resolve => requestAnimationFrame(resolve));
    root.querySelector('[data-start-tour]').click();
    const opened = !!root.querySelector('iframe');
    dispatchEvent(new Event('doctorcre-session-invalidated'));
    const before = { reads, navigations };
    root.querySelector('[data-start-tour]')?.click();
    await panel.refresh();
    const result = { opened, frame: !!root.querySelector('iframe'), before, after: { reads, navigations } };
    panel.dispose();
    return result;
  }, bundle.toString('base64'));
  assert.equal(result.opened, true);
  assert.equal(result.frame, false, 'Retired workspace must not recreate an iframe');
  assert.deepEqual(result.after, result.before);
});
