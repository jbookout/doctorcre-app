import { reproTest } from './support.mjs';
import { expect } from 'e2e';

// The round-one directory had 166 entries. Seed that scale with Demo records;
// no production board content or authenticated browser state enters this test.
const test = reproTest();
test('QA-004 populated project board filters and lanes stay near the first screen', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser }) => {
  const boards = Array.from({ length: 166 }, (_, i) => ({ board_id: i === 0 ? 'carr-v5' : `demo-board-${i}`, title: `Demo repository ${i + 1}`, updated_at: new Date().toISOString(), task_counts: { running: 1 } }));
  await browser.route('**/mcp', async route => {
    const rpc = JSON.parse(route.request.postData || '{}').params || {};
    let payload;
    if (rpc.name === 'list-progress-boards') payload = { schema: 'progress-board-directory.v1', boards };
    else if (rpc.name === 'read-progress-board') payload = { snapshot: { board_id: rpc.arguments?.board_id || 'carr-v5', version: 1, updated_at: new Date().toISOString(), snapshot_json: { title: 'Demo project board', tasks: { demo: { title: 'Demo task', status: 'running' } } } }, questions: [] };
    else { await route.fallback(); return; }
    await route.fulfill({ json: { result: { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  for (const viewport of [{width:1440,height:960},{width:390,height:844}]) {
  await browser.setViewport(viewport);
  await app.open('/progress-board');
  await expect(browser.locator('#board-stages [data-card-id="demo"]')).toBeVisible();
  const placement = await browser.evaluate(() => {
    const y = id => { const b = document.getElementById(id).getBoundingClientRect(); return b.top + window.scrollY; };
    return { directoryVisible: !document.querySelector('.directory-panel').hidden, directoryCount: document.querySelectorAll('#board-directory .board-link').length, filtersY: y('board-filters'), lanesY: y('board-stages'), viewportHeight: innerHeight };
  });
  await app.screenshot(`qa-004-board-placement-${viewport.width}`);
  if (placement.directoryVisible) expect(placement.directoryCount, 'the representative directory actually rendered').toBe(166);
  expect(placement.filtersY, JSON.stringify(placement)).toBeLessThanOrEqual(placement.viewportHeight * 2);
  expect(placement.lanesY, JSON.stringify(placement)).toBeLessThanOrEqual(placement.viewportHeight * 2);
  }
});
