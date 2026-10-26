import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { detail, tourId } from './fixtures/tour-day.synthetic.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';

const artifactDir = await mkdtemp(join(tmpdir(), 'doctorcre-print-'));
before(() => buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir: artifactDir }));
after(() => rm(artifactDir, { recursive: true, force: true }));

test('the shared stylesheet keeps the Tour planner printable', async t => {
  const server = await fixtureServer({ root: join(artifactDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/tours/index.html`);
  await page.getByRole('heading', { name: 'Plan a tour', exact: true }).waitFor();
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.getByRole('heading', { name: 'Plan a tour', exact: true }).isVisible(), true);
});

test('broker can print complete saved notes and the current draft without changing the tour', async t => {
  const server = await fixtureServer({ root: join(artifactDir, 'site') }); t.after(() => server.close());
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
  await page.clock.install();
  await page.clock.pauseAt(new Date());
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

test('broker notes autosave one revision after a pause and preserve drafts across Tour navigation', async t => {
  const server = await fixtureServer({ root: join(artifactDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const fixture = structuredClone(detail), writes = [];
  fixture.routes[0].stops.forEach(stop => { stop.locked_appointment = false; });
  fixture.route_version_id = fixture.routes[0].id;
  fixture.route_version_state = 'accepted'; fixture.accepted_route_version = 1;
  fixture.cheat_sheet = { revision_number: 3, content: { notes: 'Saved notes' } };
  const other = structuredClone(fixture); other.id = '99999999-9999-4999-8999-999999999999'; other.name = 'Other synthetic Tour';
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let data = {};
    if (url.pathname === '/api/tours/cheat-sheet/autosave') {
      const body = request.postDataJSON(); writes.push(body);
      fixture.cheat_sheet = { revision_number: body.expected_revision_number + 1, content: body.content };
      data = { ok: true, cheat_sheet_revision_id: '88888888-8888-4888-8888-888888888888' };
    } else if (url.pathname === '/api/tours/detail') data = url.searchParams.get('tour_id') === tourId ? fixture : other;
    else if (url.pathname === '/api/tours/library') data = { tours: [fixture, other].map(({ id, name }) => ({ id, name })) };
    await route.fulfill({ json: { data, csrf_token: 'synthetic-only' } });
  });
  await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
  await page.locator('#tour-panel').waitFor({ state: 'visible' });
  await page.locator('#internal-cheat-sheet > summary').click();
  await page.clock.install(); await page.clock.pauseAt(new Date());
  const editor = page.locator('#cheat-content');
  await editor.fill('First draft'); await page.clock.runFor(600);
  await editor.fill('Final draft'); await page.clock.runFor(600);
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Other synthetic Tour' }).click();
  assert.match(await page.locator('#status').innerText(), /Save the current sheet/);
  assert.equal(await editor.inputValue(), 'Final draft');
  await page.clock.runFor(400);
  await page.locator('#sheet-state').filter({ hasText: /save confirmed/i }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].tour_id, tourId);
  assert.equal(writes[0].expected_revision_number, 3);
  assert.deepEqual(writes[0].content, { notes: 'Final draft' });
  await editor.fill('Saved immediately');
  await page.getByRole('button', { name: 'Save now', exact: true }).click();
  await page.locator('#sheet-state').filter({ hasText: /save confirmed/i }).waitFor();
  await page.clock.runFor(2000);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].expected_revision_number, 4);
  assert.deepEqual(writes[1].content, { notes: 'Saved immediately' });
  await editor.fill('Cancelled by revocation');
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  await page.clock.runFor(2000);
  assert.equal(writes.length, 2);
});
