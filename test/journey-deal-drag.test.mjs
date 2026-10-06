import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { dragDealToPhase } from '../tests/journeys/deal-drag.mjs';

test('journey drag reaches the phase header on a tall board without leaving a native drag active', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const seed = JSON.parse(await readFile(new URL('../data/board-seed.json', import.meta.url)));
  // A populated column stretches its empty neighbours too. Their centres can
  // be below the viewport even when the card and destination header both fit.
  for (let i = 0; i < 8; i++) seed.deals.push({ ...seed.deals.find(d => d.id === 'd23'), id: `drag-demo-${i}` });
  await page.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
  await page.goto(server.origin + '/deals');
  await page.locator('.kanban-column [data-id="d23"]').waitFor();
  assert.equal(await page.evaluate(() => {
    const box = document.querySelector('[data-column="legal"]').getBoundingClientRect();
    return box.y + box.height / 2 > innerHeight;
  }), true, 'exercise a drop column whose centre is below the viewport');
  // Model the engine boundary where the first destination movement enters the
  // drop zone but has not delivered an accepted dragover yet. A second native
  // pointer move must reach the board handler; no synthetic drag is dispatched.
  await page.evaluate(() => {
    let entered = false;
    document.addEventListener('dragover', event => {
      if (!event.target.closest('[data-column="legal"]') || entered) return;
      entered = true;
      event.stopImmediatePropagation();
    }, { capture: true });
  });
  await dragDealToPhase(page, 'd23', 'legal');
  await page.locator('#completionDialog[open]').waitFor();
  assert.equal(await page.locator('[data-dragging="true"]').count(), 0);
  assert.equal(await page.locator('[data-column="negotiation"] [data-id="d23"]').count(), 1,
    'the gesture reviews the move before writing it');
  await page.locator('#completionConfirm').click();
  await page.locator('[data-column="legal"] [data-id="d23"]').waitFor();
  assert.equal(await page.locator('[data-column="negotiation"] [data-id="d23"]').count(), 0);
});
