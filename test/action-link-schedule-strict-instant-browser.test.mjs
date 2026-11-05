import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { observeActionLink } from '../scripts/prove-action-link-schedule-strict-instant.mjs';
const bytes = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'), 'src/ui/action-link.tsx');
test('public mount schedule transitions at phone and desktop widths', async () => {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.route('https://synthetic.invalid/**', route => route.fulfill(route.request().url().endsWith('/ui.js')
        ? { contentType: 'text/javascript', body: bytes } : { contentType: 'text/html', body: '<!doctype html><body></body>' }));
      await page.goto('https://synthetic.invalid/');
      assert.ok((await page.evaluate(observeActionLink, 'https://synthetic.invalid/ui.js')).length > 50);
      await page.close();
    }
  } finally { await browser.close(); }
});
