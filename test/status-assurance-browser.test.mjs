import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { scope, NOW, projection } from './fixtures/assurance-health.mjs';

async function openStatus(t, { width = 390, answer = projection(), refused = false, query = true } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1024 } });
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
    for (const [id, reason] of [['v5-f08', /does not cover backup or restore/], ['v5-f07', /does not cover supervisor or job/]]) {
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
  await page.locator('#retryRead').click();
  await page.waitForFunction(() => document.querySelector('[data-gap="v5-a01"]')?.textContent.includes('refused'));
  assert.ok(calls.every(call => ['read-assurance-health', 'incident-board', 'current-work-item', 'current-work-requests', 'read-session-identity', 'notification-feed'].includes(call.name)));
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
