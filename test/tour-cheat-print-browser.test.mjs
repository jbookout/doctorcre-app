import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { detail, tourId } from './fixtures/tour-day.synthetic.mjs';

test('broker can print complete saved notes and the current draft without changing the tour', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const fixture = structuredClone(detail), posts = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  fixture.routes[0].stops.forEach(stop => { stop.locked_appointment = false; });
  fixture.route_version_id = fixture.routes[0].id;
  fixture.route_version_state = 'accepted'; fixture.accepted_route_version = 1;
  fixture.cheat_sheet = { revision_number: 3, content: { notes: 'Saved broker notes' } };
  fixture.updated_at = '2026-10-25T12:00:00Z';
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST') posts.push(path);
    return route.fulfill({ json: path === '/api/tours/detail' ? { data: fixture }
      : path === '/api/tours/library' ? { data: { tours: [{ id: tourId, name: fixture.name }] } }
      : ['/api/system-work/session', '/auth/session'].includes(path) ? { actor: { slug: 'joe' }, csrf_token: 'synthetic-only' } : {} });
  });
  await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
  await page.locator('#tour-panel').waitFor({ state: 'visible' });
  await page.locator('#internal-cheat-sheet > summary').click();
  const print = page.getByRole('button', { name: 'Print internal sheet', exact: true });
  assert.equal(await print.count(), 1);
  await page.evaluate(() => { window.print = () => { window.dispatchEvent(new Event('beforeprint')); }; });
  await print.click();
  await page.emulateMedia({ media: 'print' });
  const sheet = page.locator('#cheat-print');
  assert.match(await sheet.innerText(), /Internal only.*Not for client distribution/);
  assert.match(await sheet.innerText(), /Synthetic tour/);
  assert.match(await sheet.innerText(), /Saved revision 3/);
  assert.match(await sheet.innerText(), /Saved broker notes/);
  assert.equal(await page.locator('#tour-panel').isVisible(), false);
  assert.equal(await page.locator('#appShell').isVisible(), false);
  for (const selector of ['body', '#cheat-print', '#cheat-print h1', '#cheat-print pre']) {
    assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).color), 'rgb(0, 0, 0)');
    assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
  }
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.equal(await sheet.textContent(), '');
  await page.emulateMedia({ media: 'screen' });
  const notes = `${Array.from({ length: 120 }, (_, i) => `Broker line ${i + 1}`).join('\n')}\n<img src=x onerror=alert(1)>\nLAST BROKER LINE`;
  await page.locator('#cheat-content').fill(notes);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  assert.match(await sheet.innerText(), /Unsaved draft/);
  assert.equal(await sheet.locator('pre').textContent(), notes);
  assert.equal(await sheet.locator('img').count(), 0);
  const bounds = await sheet.locator('pre').evaluate(node => ({ height: node.clientHeight, scroll: node.scrollHeight, overflow: getComputedStyle(node).overflowY, whiteSpace: getComputedStyle(node).whiteSpace }));
  assert.ok(bounds.height > 1500, JSON.stringify(bounds));
  assert.equal(bounds.height, bounds.scroll);
  assert.equal(bounds.overflow, 'visible');
  assert.equal(bounds.whiteSpace, 'pre-wrap');
  await mkdir('test-artifacts', { recursive: true });
  await page.screenshot({ path: 'test-artifacts/tour-cheat-print.png', fullPage: true });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.emulateMedia({ media: 'screen' });
  assert.equal(await page.locator('#cheat-content').inputValue(), notes);
  assert.equal(await sheet.isVisible(), false);
  assert.deepEqual(posts, []);
  fixture.cheat_sheet = {};
  await page.reload(); await page.locator('#tour-panel').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#internal-cheat-sheet > summary').click();
  const box = await print.boundingBox();
  assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  assert.match(await sheet.textContent(), /Not saved/);
  assert.match(await sheet.textContent(), /No internal notes recorded/);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    window.dispatchEvent(new Event('beforeprint'));
  });
  assert.equal(await sheet.textContent(), '', 'revoked session cannot reconstruct private print notes');
  await page.evaluate(() => { document.body.replaceChildren(); window.dispatchEvent(new Event('beforeprint')); });
  assert.deepEqual(errors, []);
});
