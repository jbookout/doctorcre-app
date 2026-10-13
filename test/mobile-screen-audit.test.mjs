import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from './browser-harness.mjs';
import { auditScreen } from '../tests/journeys/screen-audit.mjs';

test('screen audit rejects phone overflow, short targets, clipped text and unnamed controls', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true });
  await page.setContent(`<html lang="en"><title>Qualification</title><main>
    <button style="width:20px;height:20px"></button>
    <p style="width:40px;white-space:nowrap;overflow:hidden">Clipped sentence</p>
    <div style="width:600px">Overflow</div>
    <p style="color:#ccc;background:#fff">Low contrast text</p>
  </main></html>`);
  const broken = await auditScreen(page, { mobile: true });
  assert.ok(broken.blocking.some(v => v.id === 'button-name' && v.impact === 'critical'));
  assert.ok(broken.blocking.some(v => v.id === 'color-contrast' && v.impact === 'serious'));
  assert.ok(broken.layout.some(v => v.kind === 'horizontal-scroll'));
  assert.ok(broken.layout.some(v => v.kind === 'tap-target'));
  assert.ok(broken.layout.some(v => v.kind === 'clipped-text'));
  await page.setContent('<button style="box-sizing:border-box;width:43.75px;height:44px">Narrow</button>');
  assert.ok((await auditScreen(page, { mobile: true })).layout.some(v => v.kind === 'tap-target'));
  await page.setContent(`<html lang="en"><title>Qualification</title><main>
    <button style="min-width:44px;min-height:44px">Continue</button>
    <h1>Qualification</h1><h3>Skipped heading</h3><p>Readable sentence</p>
  </main></html>`);
  const repaired = await auditScreen(page, { mobile: true });
  assert.deepEqual(repaired.blocking, []);
  assert.deepEqual(repaired.layout, []);
  assert.ok(repaired.moderate.some(v => v.id === 'heading-order'));
});

test('screen audit rejects an endless animation only when motion is reduced', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
  const screen = fallback => `<html lang="en"><title>Qualification</title><style>
    @keyframes glow { 50% { opacity: .5 } } .glow { animation: glow 2s infinite }
    ${fallback ? '@media (prefers-reduced-motion: reduce) { .glow { animation: none } }' : ''}
  </style><main><p class="glow" id="pulse">Live status</p></main></html>`;
  await page.setContent(screen(false));
  assert.deepEqual((await auditScreen(page, { reducedMotion: true })).motion.map(v => v.selector), ['#pulse']);
  assert.deepEqual((await auditScreen(page)).motion, [], 'full motion may animate');
  await page.setContent(screen(true));
  assert.deepEqual((await auditScreen(page, { reducedMotion: true })).motion, []);
});
