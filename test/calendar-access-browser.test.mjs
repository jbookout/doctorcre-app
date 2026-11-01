import test from 'node:test';
import { handleDoctorcreRequest } from '../src/worker.js';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, extname } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { chromium, WAIT_MS } from './browser-harness.mjs';
import { expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: WAIT_MS });
const producer = process.env.CARR_PRODUCER_CHECKOUT;

test('signed-in Calendar journey crosses the real CARR gate and renders a recorded tour meeting', {
  skip: !producer && 'Set CARR_PRODUCER_CHECKOUT to run the signed-in CARR journey',
}, async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const outDir = await temporaryDirectory('calendar-access-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const { startLocalCarr } = await import(pathToFileURL(join(producer, 'mcp-server/test/helpers/local-carr.mjs')));
  const assets = async request => {
    const path = new URL(request.url).pathname;
    try { return new Response(await readFile(join(outDir, 'site', path)), { headers: { 'content-type': mime[extname(path)] || 'application/octet-stream' } }); }
    catch { return new Response('not found', { status: 404 }); }
  };
  const carr = await startLocalCarr({ assets });
  t.after(() => carr.close());
  await carr.mcp('add-critical-date', { deal: Object.values(carr.deals)[0], kind: 'tour',
    due_on: new Date().toISOString().slice(0, 10), note: 'Synthetic calendar tour meeting', source: 'synthetic test fixture' });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  const appOrigin = 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev';
  const appEnv = { ASSETS: { fetch: assets }, APP_ENV: 'staging', GIT_SHA: '0'.repeat(40), CARR: {
    fetch: request => fetch(`${carr.url}${new URL(request.url).pathname}${new URL(request.url).search}`, {
      method: request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      ...(request.body ? { duplex: 'half' } : {}), redirect: 'manual',
    }),
  } };
  const blocked = await handleDoctorcreRequest(new Request(`${appOrigin}/calendar`), appEnv);
  assert.equal(blocked.status, 302);
  assert.match(blocked.headers.get('location'), /auth\/login/);
  await page.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== appOrigin) return route.abort();
    const response = await handleDoctorcreRequest(new Request(request.url(), {
      method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
    }), appEnv);
    await route.fulfill({ status: response.status,
      headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const signedIn = await page.request.post(`${carr.url}/auth/e2e-session`, {
    headers: { authorization: `Bearer ${carr.e2eSecret}` }, maxRedirects: 0 });
  assert.equal(signedIn.status(), 200);
  const session = await page.request.get(`${carr.url}/auth/session`);
  assert.equal(session.status(), 200);
  assert.equal((await session.json()).actor.slug, 'joe');
  const state = await page.request.storageState();
  await page.context().addCookies(state.cookies.map(cookie => ({ ...cookie, domain: new URL(appOrigin).hostname })));
  await page.goto(`${appOrigin}/calendar`);
  await expect(page.locator('#calGrid .cal-day-open').first()).toBeVisible();
  const meetingEntry = page.locator('.cal-agenda-item').filter({ hasText: 'Synthetic calendar tour meeting' });
  await expect(meetingEntry).toBeVisible();
  await meetingEntry.click();
  await expect(page.locator('#dayPanelBody')).toContainText('Synthetic calendar tour meeting');
  await page.reload();
  await expect(meetingEntry).toBeVisible();
});
