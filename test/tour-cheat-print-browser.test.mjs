import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, fixtureServer, pausedClock } from './browser-harness.mjs';
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
  await page.clock.install({ time: new Date('2026-10-25T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-25T13:00:00Z'));
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
  let heldSave = null, saveStarted = null, heldRefresh = null, refreshStarted = null;
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
      saveStarted?.();
      if (heldSave) await heldSave;
      fixture.cheat_sheet = { revision_number: body.expected_revision_number + 1, content: body.content };
      data = { ok: true, cheat_sheet_revision_id: '88888888-8888-4888-8888-888888888888' };
    } else if (url.pathname === '/api/tours/detail') {
      refreshStarted?.();
      if (heldRefresh) await heldRefresh;
      data = url.searchParams.get('tour_id') === tourId ? fixture : other;
    }
    else if (url.pathname === '/api/tours/library') data = { tours: [fixture, other].map(({ id, name }) => ({ id, name })) };
    await route.fulfill({ json: { data, csrf_token: 'synthetic-only' } });
  });
  await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
  await page.locator('#tour-panel').waitFor({ state: 'visible' });
  await page.locator('#internal-cheat-sheet > summary').click();
  await page.clock.install({ time: new Date('2026-10-25T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-25T13:00:00Z'));
  const editor = page.locator('#cheat-content');
  await editor.fill('First draft'); await page.clock.runFor(600);
  await editor.fill('Final draft'); await page.clock.runFor(600);
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Other synthetic Tour' }).click();
  assert.match(await page.locator('#status').innerText(), /Save the current sheet/);
  assert.equal(await editor.inputValue(), 'Final draft');
  await editor.focus();
  await editor.evaluate(node => node.setSelectionRange(5, 5));
  await page.clock.runFor(400);
  await page.locator('#sheet-state').filter({ hasText: /save confirmed/i }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].tour_id, tourId);
  assert.equal(writes[0].expected_revision_number, 3);
  assert.deepEqual(writes[0].content, { notes: 'Final draft' });
  await page.locator('#status').filter({ hasText: /save confirmed/i }).waitFor();
  assert.equal(await editor.evaluate(node => document.activeElement === node), true, 'autosave keeps keyboard focus in the notes');
  assert.equal(await page.locator('#internal-cheat-sheet').evaluate(node => node.open), true);
  assert.deepEqual(await editor.evaluate(node => [node.selectionStart, node.selectionEnd]), [5, 5]);
  await page.keyboard.type(' more');
  assert.equal(await editor.inputValue(), 'Final more draft');
  await editor.fill('Saved immediately');
  await page.getByRole('button', { name: 'Save now', exact: true }).click();
  await page.locator('#sheet-state').filter({ hasText: /save confirmed/i }).waitFor();
  await page.clock.runFor(2000);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].expected_revision_number, 4);
  assert.deepEqual(writes[1].content, { notes: 'Saved immediately' });
  for (const target of ['print', 'close sheet']) {
    let releaseSave;
    heldSave = new Promise(resolve => { releaseSave = resolve; });
    const sending = new Promise(resolve => { saveStarted = resolve; });
    await editor.fill(`Notes while choosing to ${target}`); await page.clock.runFor(1000);
    await sending;
    assert.equal(await editor.isEnabled(), true);
    if (target === 'print') {
      await editor.press('End');
      await page.keyboard.type(' with newer typing');
      assert.equal(await editor.inputValue(), 'Notes while choosing to print with newer typing');
    }
    const control = target === 'print' ? page.getByRole('button', { name: 'Print internal sheet', exact: true }) : page.locator('#internal-cheat-sheet > summary');
    if (target === 'print') await control.focus(); else await control.click();
    let releaseRefresh;
    const refreshing = target === 'print' ? new Promise(resolve => { refreshStarted = resolve; }) : null;
    if (refreshing) heldRefresh = new Promise(resolve => { releaseRefresh = resolve; });
    releaseSave();
    if (refreshing) {
      await refreshing;
      assert.equal(await editor.isVisible(), true, 'typing remains available during the confirmation refresh');
      await editor.focus(); await page.keyboard.type(' during refresh');
      await control.focus();
      releaseRefresh(); heldRefresh = null; refreshStarted = null;
    }
    await page.locator('#status').filter({ hasText: /save confirmed/i }).waitFor();
    assert.equal(await control.evaluate(node => document.activeElement === node), true, 'autosave respects deliberately moved focus');
    assert.equal(await page.locator('#internal-cheat-sheet').evaluate(node => node.open), target === 'print');
    if (target === 'print') {
      assert.equal(await editor.inputValue(), 'Notes while choosing to print with newer typing during refresh');
      await page.clock.runFor(1000);
      await page.locator('#sheet-state').filter({ hasText: /save confirmed/i }).waitFor();
      assert.deepEqual(writes.at(-1).content, { notes: 'Notes while choosing to print with newer typing during refresh' });
      assert.equal(writes.at(-1).expected_revision_number, 6);
    }
  }
  await page.locator('#internal-cheat-sheet > summary').click();
  await editor.fill('Cancelled by revocation');
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  await page.clock.runFor(2000);
  assert.equal(writes.length, 5);
});

test('broker regenerates an editable internal sheet from the accepted itinerary with deliberate replacement', async t => {
  const server = await fixtureServer({ root: join(artifactDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await pausedClock(page, new Date('2026-10-26T13:00:00Z'));
  const fixture = structuredClone(detail), writes = [];
  const accepted = fixture.routes[0];
  accepted.stops.forEach(stop => { stop.locked_appointment = false; });
  accepted.stops[0].property_name = '<img src=x onerror=alert(1)> Waterfront';
  accepted.stops.reverse();
  accepted.stops.unshift(
    { ...accepted.stops[0], id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', property_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      route_sequence: null, route_label: null, stop_state: 'excluded', property_name: 'Demo excluded office', property_address: '400 Example Way' },
    { ...accepted.stops[0], id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', property_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      route_sequence: null, route_label: null, stop_state: 'held', property_name: 'Demo held office', property_address: '300 Example Way' },
  );
  const draft = structuredClone(accepted);
  draft.id = '99999999-9999-4999-8999-999999999999'; draft.route_version = 2; draft.accepted = false;
  draft.stops.forEach(stop => { stop.property_name = 'Unaccepted replacement'; });
  fixture.routes.unshift(draft); fixture.stops = draft.stops;
  fixture.route_version_id = draft.id; fixture.route_version_state = 'draft'; fixture.accepted_route_version = 1;
  fixture.cheat_sheet = { revision_number: 3, content: { notes: 'Keep my handwritten preparation' } };
  let failSave = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data = {};
    if (request.method() === 'POST') {
      const body = request.postDataJSON(); writes.push({ path, body });
      if (failSave) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      assert.equal(path, '/api/tours/cheat-sheet/autosave');
      fixture.cheat_sheet = { revision_number: body.expected_revision_number + 1, content: body.content };
      data = { ok: true, cheat_sheet_revision_id: '88888888-8888-4888-8888-888888888888' };
    } else if (path === '/api/tours/detail') data = fixture;
    else if (path === '/api/tours/library') data = { tours: [{ id: tourId, name: fixture.name }] };
    await route.fulfill({ json: { data, csrf_token: 'synthetic-only' } });
  });
  await page.clock.install({ time: new Date('2026-10-26T13:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-26T13:00:00Z'));
  await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
  await page.locator('#tour-panel').waitFor({ state: 'visible' });
  await page.locator('#internal-cheat-sheet > summary').click();
  const editor = page.locator('#cheat-content');
  const regenerate = page.getByRole('button', { name: 'Regenerate from accepted itinerary', exact: true });
  assert.equal(await regenerate.count(), 1);
  assert.equal(await regenerate.isEnabled(), true);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const box = await regenerate.boundingBox();
    assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('test-artifacts', { recursive: true });
    await page.screenshot({ path: `test-artifacts/tour-cheat-regenerate-${width}.png`, fullPage: true });
  }
  page.once('dialog', dialog => dialog.dismiss());
  await regenerate.click();
  assert.equal(await editor.inputValue(), 'Keep my handwritten preparation');
  assert.deepEqual(writes, []);
  page.once('dialog', dialog => dialog.accept());
  await regenerate.click();
  const generated = await editor.inputValue();
  assert.match(generated, /Internal only\. Not for client distribution\./);
  assert.match(generated, /Accepted route version 1/);
  assert.ok(generated.indexOf('A · <img') < generated.indexOf('B · Demo garden suites'));
  assert.match(generated, /100 Example Way · Suite 200/);
  assert.match(generated, /Dwell: 30 minutes/);
  assert.match(generated, /Buffer: 10 minutes/);
  assert.match(generated, /Appointment start: Not recorded/);
  const omittedSchedule = [
    'Not on the active itinerary', '', 'Demo excluded office', 'Status: Excluded', 'Address: 400 Example Way',
    'Appointment start: Not recorded', 'Appointment end: Not recorded', 'Dwell: 20 minutes', 'Buffer: 10 minutes',
    '', 'Demo held office', 'Status: Held', 'Address: 300 Example Way', 'Appointment start: Not recorded',
    'Appointment end: Not recorded', 'Dwell: 20 minutes', 'Buffer: 10 minutes',
  ].join('\n');
  assert.ok(generated.includes(omittedSchedule));
  assert.ok(generated.indexOf('B · Demo garden suites') < generated.indexOf('Not on the active itinerary'));
  assert.doesNotMatch(generated, /Contact:|Phone:|Access:|Demo listing contact|West entrance/);
  assert.doesNotMatch(generated, /Unaccepted replacement/);
  assert.equal(await page.locator('#internal-cheat-sheet img').count(), 0);
  assert.equal(writes.length, 0);
  await page.clock.runFor(1000);
  await page.locator('#sheet-state').filter({ hasText: /save confirmed/i }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.expected_revision_number, 3);
  assert.deepEqual(writes[0].body.content, { notes: generated });
  await page.reload(); await page.locator('#tour-panel').waitFor({ state: 'visible' });
  assert.equal(await editor.inputValue(), generated);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  assert.equal(await page.locator('#cheat-print pre').textContent(), generated);
  assert.equal(await page.locator('#cheat-print img').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: 'test-artifacts/tour-cheat-dispositions-390.png', fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.locator('#internal-cheat-sheet > summary').click();
  await editor.fill('Preparation after regeneration');
  await editor.dispatchEvent('compositionstart');
  assert.equal(await regenerate.isDisabled(), true);
  await editor.dispatchEvent('compositionend');
  assert.equal(await regenerate.isEnabled(), true);
  fixture.cheat_sheet = { revision_number: 5, content: { notes: 'Another partner saved this' } };
  page.once('dialog', dialog => dialog.accept());
  await regenerate.click(); await page.clock.runFor(1000);
  await page.locator('#sheet-conflict').waitFor({ state: 'visible' });
  assert.equal(writes.length, 1, 'regeneration retains the dirty draft revision instead of rebasing');
  assert.equal(await regenerate.isDisabled(), true);
  assert.equal(await editor.inputValue(), generated);
  await page.getByRole('button', { name: 'I reviewed the current sheet; keep my draft' }).click();
  failSave = true;
  await page.getByRole('button', { name: 'Save now', exact: true }).click();
  await page.getByRole('button', { name: 'Check save outcome', exact: true }).waitFor();
  assert.equal(await regenerate.isDisabled(), true);
  assert.equal(await editor.inputValue(), generated);
  failSave = false;
  await page.getByRole('button', { name: 'Check save outcome', exact: true }).click();
  await page.locator('#sheet-state').filter({ hasText: /save confirmed/i }).waitFor();
  fixture.routes.forEach(route => { route.accepted = false; });
  fixture.accepted_route_version = 0;
  await page.reload(); await page.locator('#tour-panel').waitFor({ state: 'visible' });
  assert.equal(await regenerate.isDisabled(), true);
  fixture.routes[1].accepted = true; fixture.accepted_route_version = 1;
  await page.reload(); await page.locator('#tour-panel').waitFor({ state: 'visible' });
  await page.locator('#internal-cheat-sheet > summary').click();
  assert.equal(await regenerate.isEnabled(), true);
  await editor.evaluate(node => { node.value = ''; });
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await regenerate.isDisabled(), true);
  await regenerate.evaluate(button => button.dispatchEvent(new Event('click')));
  assert.equal(await editor.inputValue(), '');
});
