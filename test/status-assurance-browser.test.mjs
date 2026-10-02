import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { scope, NOW, projection } from './fixtures/assurance-health.mjs';

async function openStatus(t, { width = 390, answer = projection(), refused = false, query = true, timezoneId = 'UTC' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1024 }, timezoneId });
  page.setDefaultTimeout(5000);
  const calls = []; const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON(); calls.push(rpc.params);
      const health = rpc.params.name === 'read-assurance-health';
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: {
        ...(health && refused ? { isError: true } : {}), content: [{ text: JSON.stringify(health ? (refused ? { error: 'demo refusal: private runbook' } : answer) : {}) }],
      } }) });
    }
    if (url.pathname === '/app-release' || url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    const path = url.pathname === '/status' ? 'status.html' : url.pathname.slice(1);
    try {
      const body = await readFile(new URL('../' + path, import.meta.url));
      const contentType = (path.endsWith('.js') || path.endsWith('.mjs')) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html';
      return route.fulfill({ body, contentType });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const args = query ? '&workflow_key=demo.workflow&workflow_version=3&work_request_id=WR-700' : '';
  await page.goto('http://localhost/status?mode=live' + args);
  return { page, calls, errors };
}

test('390px and iPad Status render server scoped state and evidence age with dark glass and 44px controls', async t => {
  for (const width of [390, 768]) await t.test(String(width), async t => {
    const { page, calls, errors } = await openStatus(t, { width, answer: projection('degraded') });
    const covered = page.locator('[data-gap="v5-a01"]');
    await page.waitForFunction(() => document.querySelector('[data-gap="v5-a01"]')?.dataset.state === 'degraded');
    assert.match(await covered.textContent(), /degraded/);
    assert.match(await covered.textContent(), /demo.workflow.*v3.*WR-700/);
    assert.equal(await covered.locator('[data-layer]').count(), 6);
    assert.ok((await covered.locator('[data-layer]').allTextContents()).every(text => text.includes('5m old')));
    assert.deepEqual(calls.find(call => call.name === 'read-assurance-health'), { name: 'read-assurance-health', arguments: { scope } });
    for (const [id, reason] of [['v5-f08', /Backup status unavailable/], ['v5-f07', /Job status unavailable/]]) {
      const row = page.locator(`[data-gap="${id}"]`);
      assert.equal(await row.getAttribute('data-state'), 'unknown'); assert.match(await row.textContent(), reason);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const control of await page.locator('#assuranceScope input, #assuranceScope button, #retryRead, #providerLinks a').all()) {
      const box = await control.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44);
    }
    const glass = await covered.evaluate(el => getComputedStyle(el.closest('.glass')).backdropFilter);
    assert.notEqual(glass, 'none'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await covered.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    assert.deepEqual(errors, []);
  });
});

test('refused read renders unknown without server error prose and retry stays read-only', async t => {
  const { page, calls } = await openStatus(t, { refused: true });
  const covered = page.locator('[data-gap="v5-a01"]');
  await page.waitForFunction(() => document.querySelector('[data-gap="v5-a01"]')?.textContent.includes('refused'));
  assert.equal(await covered.getAttribute('data-state'), 'unknown');
  assert.doesNotMatch(await covered.textContent(), /healthy|private runbook|no producer yet/);
  await page.locator('#appSyncRefresh').click();
  await page.waitForFunction(() => document.querySelector('[data-gap="v5-a01"]')?.textContent.includes('refused'));
  assert.ok(calls.every(call => ['read-assurance-health', 'incident-board', 'current-work-item', 'current-work-requests', 'read-session-identity', 'notification-feed', 'deal-room-board', 'today-triage'].includes(call.name)));
});

test('missing scope is unknown without inventing a workflow; entering a scope performs the exact read', async t => {
  const { page, calls } = await openStatus(t, { query: false });
  assert.match(await page.locator('[data-gap="v5-a01"]').textContent(), /Choose a workflow/);
  assert.equal(calls.some(call => call.name === 'read-assurance-health'), false);
  await page.locator('#assuranceWorkflow').fill(scope.workflow_key);
  await page.locator('#assuranceVersion').fill(String(scope.workflow_version));
  await page.locator('#assuranceWorkRequest').fill(scope.work_request_id);
  await page.locator('#readAssurance').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-layer]').length === 6);
  assert.match(await page.locator('[data-gap="v5-a01"]').textContent(), /workflow truth.*unreadable/);
  assert.equal(await page.locator('[data-gap="v5-a01"]').getAttribute('data-state'), 'unknown');
  assert.deepEqual(calls.find(call => call.name === 'read-assurance-health').arguments, { scope });
});

test('a previously green scoped read loses green as evidence expires on the open page', async t => {
  const { page } = await openStatus(t, { answer: projection('healthy') });
  const covered = page.locator('[data-gap="v5-a01"]');
  await page.waitForFunction(() => document.querySelector('[data-gap="v5-a01"]')?.dataset.state === 'healthy');
  await page.clock.fastForward(601000);
  assert.equal(await covered.getAttribute('data-state'), 'unknown');
  assert.match(await covered.textContent(), /expired/);
  assert.match(await covered.textContent(), /15m old/);
  const saved = await page.evaluate(() => localStorage.getItem('doctorcre.status-snapshot.v1'));
  assert.doesNotMatch(saved, /demo.workflow|evidence|healthy/);
});

test('keyboard scoped reads announce completion and expiry without announcing each evidence-age update', async t => {
  const { page } = await openStatus(t, { answer: projection('healthy'), query: false });
  await page.locator('#assuranceWorkflow').fill(scope.workflow_key);
  await page.locator('#assuranceVersion').fill(String(scope.workflow_version));
  await page.locator('#assuranceWorkRequest').fill(scope.work_request_id);
  await page.locator('#readAssurance').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-gap="v5-a01"]')?.dataset.state === 'healthy');
  const live = page.locator('#assuranceLive');
  assert.equal(await live.count(), 1, 'the assurance result needs a persistent live status region');
  assert.equal(await live.getAttribute('role'), 'status');
  assert.equal(await live.getAttribute('aria-live'), 'polite');
  assert.equal(await live.getAttribute('aria-atomic'), 'true');
  assert.match(await live.textContent(), /demo.workflow.*v3.*WR-700.*healthy/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'readAssurance');
  const coverage = await page.locator('#statusLive').textContent();
  await live.evaluate(el => {
    window.assuranceAnnouncements = [];
    new MutationObserver(() => window.assuranceAnnouncements.push(el.textContent)).observe(el, { childList: true, subtree: true, characterData: true });
  });
  await page.clock.fastForward(2000);
  assert.deepEqual(await page.evaluate(() => window.assuranceAnnouncements), []);
  await page.clock.fastForward(599000);
  assert.match(await live.textContent(), /demo.workflow.*v3.*WR-700.*unknown.*expired/);
  assert.equal(await page.locator('[data-gap="v5-a01"]').getAttribute('data-state'), 'unknown');
  await page.clock.fastForward(2000);
  const changes = await page.evaluate(() => window.assuranceAnnouncements);
  assert.equal(changes.length, 1, 'only the expiry state change is announced');
  assert.doesNotMatch(changes[0], /old/);
  assert.equal(await page.locator('#statusLive').textContent(), coverage);
});

test('scope validation errors and read refusals are announced', async t => {
  for (const refused of [false, true]) await t.test(refused ? 'read refusal' : 'invalid scope', async t => {
    const { page } = await openStatus(t, { refused, query: false });
    if (refused) {
      await page.locator('#assuranceWorkflow').fill(scope.workflow_key);
      await page.locator('#assuranceVersion').fill(String(scope.workflow_version));
      await page.locator('#assuranceWorkRequest').fill(scope.work_request_id);
    }
    await page.locator('#readAssurance').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Enter a workflow|refused/.test(document.querySelector('[data-gap="v5-a01"]')?.textContent));
    const live = page.locator('#assuranceLive');
    assert.equal(await live.count(), 1);
    assert.match(await live.textContent(), refused ? /demo.workflow.*v3.*WR-700.*unknown.*refused/ : /Enter a workflow/);
    assert.doesNotMatch(await live.textContent(), /private runbook/);
  });
});

test('contradictory truth and malformed instants render unknown in the browser', async t => {
  for (const [name, mutate] of [
    ['workflow truth', a => { a.workflow_truth.state = 'unknown'; }],
    ['local timestamps', a => { a.evidence.artifact_assessment.observed_at = '2026-10-01T14:55:00'; a.evidence.artifact_assessment.expires_at = '2026-10-01T15:10:00'; }],
    ['impossible readback', a => { a.evidence.controller_assessment.readback_at = '2026-02-30T14:55:00Z'; }],
  ]) await t.test(name, async t => {
    const answer = projection('healthy'); mutate(answer);
    const { page } = await openStatus(t, { answer });
    await page.waitForFunction(() => document.querySelector('[data-gap="v5-a01"]')?.textContent.includes('invalid'));
    assert.equal(await page.locator('[data-gap="v5-a01"]').getAttribute('data-state'), 'unknown');
  });
});
