import test from 'node:test';
import { chromium, componentDocument } from '../browser-harness.mjs';

test('negative fixture deliberately omits its unsubscribe', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await componentDocument(page, 'http://localhost', { owner: 'missing-unsubscribe fixture' });
    await page.evaluate(() => window.addEventListener('doctorcre-session-invalidated', () => {}));
  } finally { await browser.close(); }
});
