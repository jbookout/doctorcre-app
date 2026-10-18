import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// The share page ships as its own built stylesheet (tokens + page + shell), so
// it is checked from a real build, at desktop and phone width.
test('S8 the share page sits in the V2 shell with a gutter, a compact stepper and a footer', async t => {
  const outDir = await mkdtemp(join(tmpdir(), 's8-share-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  const { server } = await createQaServer({ buildRoot: join(outDir, 'site') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(); t.after(() => browser.close());

  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/share`);
    await page.locator('body.report-shell').waitFor();
    const layout = await page.evaluate(() => {
      const box = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
      const rail = document.querySelector('.app-shell-header')?.getBoundingClientRect();
      const railRight = rail && getComputedStyle(document.querySelector('.app-shell-header')).display !== 'none' && rail.width < innerWidth ? rail.right : 0;
      return { railRight, shell: box('main.shell'), flow: box('.tour-flow'), footer: box('.report-footer'),
        footerText: document.querySelector('.report-footer')?.textContent.trim() ?? '',
        fontLink: !!document.querySelector('link[href^="https://fonts.googleapis.com/css2?family=DM+Sans"]'),
        bottomPad: parseFloat(getComputedStyle(document.body).paddingBottom),
        bottomBand: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--layout-bottom')) || 0,
        scrollWidth: document.documentElement.scrollWidth };
    });
    assert.ok(layout.shell.left >= layout.railRight + 16, `${width}: content keeps a gutter from the rail (${layout.shell.left} vs ${layout.railRight})`);
    assert.ok(layout.shell.right <= width - 16, `${width}: content keeps a right gutter`);
    assert.ok(layout.scrollWidth <= width, `${width}: no horizontal scroll`);
    assert.ok(layout.flow.height <= (width < 761 ? 96 : 120), `${width}: the stepper stays compact (${layout.flow.height}px)`);
    assert.ok(layout.footer, `${width}: a footer closes the page`);
    assert.match(layout.footerText, /CARR Healthcare Real Estate/);
    assert.ok(layout.fontLink, 'the page loads the V2 typeface');
    if (width < 761) assert.ok(layout.bottomPad >= layout.bottomBand, `${width}: content clears the phone bottom chrome`);
    await page.close();
  }
});
