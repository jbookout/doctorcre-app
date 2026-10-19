import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let outDir, server, browser, origin, sequence = 0;
before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'v2-s6-'));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});
async function open(t, width, theme) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  t.after(() => page.close());
  const seeded = await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `s6-${++sequence}`, reset: true } });
  assert.equal(seeded.status(), 200);
  await page.goto(`${origin}/design-lab`);
  await page.locator('#contrastTable tbody tr').first().waitFor();
  return page;
}

test('Design Lab component specimens fit a narrow phone without overlapping receipt actions', async t => {
  for (const theme of ['dark', 'light']) {
    const page = await open(t, 320, theme);
    await page.getByRole('tab', { name: 'Components', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320, `${theme}: no horizontal page scroll`);
    const overlap = await page.locator('.receipt-grid .receipt').evaluateAll(receipts => receipts.some(receipt => {
      const text = receipt.children[1].getBoundingClientRect();
      const button = receipt.querySelector('button')?.getBoundingClientRect();
      return button && text.left < button.right && button.left < text.right && text.top < button.bottom && button.top < text.bottom;
    }));
    assert.equal(overlap, false, `${theme}: receipt text and actions do not overlap`);
  }
});
