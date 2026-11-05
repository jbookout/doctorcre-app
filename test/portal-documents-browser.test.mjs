import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium, settles } from './browser-harness.mjs';

const fixture = JSON.parse(readFileSync('test/fixtures/portal-documents/authorized.json'));
const bundle = await build({ stdin: { contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Documents } from './src/ui/portal/documents';
const root = createRoot(document.getElementById('root'));
window.requests = [];
const transport = ({slug, signal}) => new Promise((resolve, reject) => window.requests.push({slug, signal, resolve, reject}));
window.mount = (portalSlug = 'example-health', sessionScope = 'session-one') => root.render(React.createElement(Documents, {portalSlug, sessionScope, transport}));
window.unmount = () => root.unmount();
window.mount();`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });

async function setup(browser, { width = 390, theme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
  await page.route('http://localhost/documents', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html style="color-scheme:${theme}"><meta name="viewport" content="width=device-width"><style>body{font:16px system-ui;margin:24px}button{min-height:44px}h3{margin-bottom:8px}</style><div id="root"></div></html>` }));
  await page.goto('http://localhost/documents');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.requests.length === 1);
  return page;
}
async function resolve(page, result) {
  await page.evaluate(result => window.requests.at(-1).resolve(result), result);
}
const received = payload => ({ kind: 'received', payload });
const empty = { ...fixture, portal: { ...fixture.portal, materials: [] } };

test('Documents renders safe shared text at phone and desktop widths in both themes', async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      const page = await setup(browser, { width, theme });
      const input = structuredClone(fixture);
      input.portal.internal_note = 'Never visible internal note';
      input.portal.materials[0].content = '<img src=x onerror=alert(1)>\nhttps://example.test/private';
      input.portal.materials[0].download_url = 'https://example.test/cached';
      await resolve(page, received(input));
      await page.getByRole('heading', { name: 'Example floor plan' }).waitFor();
      assert.equal(await page.getByRole('article').count(), 3);
      assert.equal(await page.getByText('Document', { exact: true }).count(), 1);
      assert.equal(await page.getByText('Generated deliverable · Report', { exact: true }).count(), 1);
      assert.equal(await page.locator('a,img,input,form').count(), 0);
      assert.equal(await page.getByText('File unavailable.', { exact: true }).count(), 3);
      assert.ok(!(await page.locator('body').innerText()).includes('Never visible'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      mkdirSync('out/test-artifacts/portal-documents', { recursive: true });
      await page.screenshot({ path: `out/test-artifacts/portal-documents/${width}-${theme}.png`, fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
});

test('every refusal replaces stale material and refresh returns to loading without fan-out', async () => {
  const browser = await chromium.launch();
  try {
    const page = await setup(browser);
    for (const [result, message] of [
      [received(empty), 'No materials are shared'],
      [{ kind: 'refused' }, 'not available to this portal session'],
      [{ kind: 'expired' }, 'session has expired'],
      [{ kind: 'withdrawn' }, 'have been withdrawn'],
      [{ kind: 'unavailable' }, 'temporarily unavailable'],
      [received({ ...fixture, portal: { ...fixture.portal, slug: 'second-portal' } }), 'not available to this portal session'],
    ]) {
      await resolve(page, received(fixture));
      await page.getByRole('heading', { name: 'Example floor plan' }).waitFor();
      const before = await page.evaluate(() => window.requests.length);
      await page.getByRole('button', { name: 'Refresh materials' }).click();
      await page.waitForFunction(count => window.requests.length === count + 1, before);
      assert.equal(await page.getByRole('article').count(), 0);
      assert.equal(await page.getByRole('button').isDisabled(), true);
      assert.equal(await page.evaluate(() => window.requests.length), before + 1);
      await resolve(page, result);
      await settles(async () => assert.match(await page.getByRole('status').innerText(), new RegExp(message)));
      assert.equal(await page.locator('a,article').count(), 0);
      await page.getByRole('button').click();
      await page.waitForFunction(count => window.requests.length === count + 2, before);
    }
    await page.evaluate(() => window.requests.at(-1).reject(Error('Synthetic failure')));
    await settles(async () => assert.match(await page.getByRole('status').innerText(), /temporarily unavailable/));
  } finally { await browser.close(); }
});

test('withdrawn item disappears and another portal session cannot restore late text or a cached link', async () => {
  const browser = await chromium.launch();
  try {
    const page = await setup(browser);
    await resolve(page, received(fixture));
    await page.getByRole('heading', { name: 'Example floor plan' }).waitFor();
    await page.getByRole('button').click();
    await page.waitForFunction(() => window.requests.length === 2);
    await resolve(page, received({ ...fixture, portal: { ...fixture.portal, materials: fixture.portal.materials.slice(1) } }));
    await page.getByRole('heading', { name: 'Example report' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Example floor plan' }).count(), 0);
    await page.getByRole('button').click();
    await page.waitForFunction(() => window.requests.length === 3);
    await page.evaluate(() => window.mount('second-portal', 'session-two'));
    await page.waitForFunction(() => window.requests.length === 4);
    assert.equal(await page.evaluate(() => window.requests[2].signal.aborted), true);
    await page.evaluate(payload => window.requests[2].resolve({ kind: 'received', payload }), fixture);
    await resolve(page, received(fixture));
    await settles(async () => assert.match(await page.getByRole('status').innerText(), /not available/));
    assert.equal(await page.locator('article,a').count(), 0);
    await page.evaluate(() => window.mount('example-health', 'new-session'));
    await page.waitForFunction(() => window.requests.length === 5);
    assert.equal(await page.getByRole('article').count(), 0);
    await page.evaluate(() => window.unmount());
    assert.equal(await page.evaluate(() => window.requests[4].signal.aborted), true);
  } finally { await browser.close(); }
});

test('hidden pages clear text and timeout aborts without automatic retry', async () => {
  const browser = await chromium.launch();
  try {
    const page = await setup(browser);
    await resolve(page, received(fixture));
    await page.getByRole('heading', { name: 'Example floor plan' }).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settles(async () => assert.equal(await page.getByRole('article').count(), 0));
    assert.equal(await page.evaluate(() => window.requests[0].signal.aborted), true);
    await page.clock.install();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.requests.length === 2);
    await page.clock.fastForward(10001);
    await settles(async () => assert.match(await page.getByRole('status').innerText(), /temporarily unavailable/));
    assert.equal(await page.evaluate(() => window.requests[1].signal.aborted), true);
    await resolve(page, received(fixture));
    await page.clock.fastForward(20000);
    assert.equal(await page.evaluate(() => window.requests.length), 2);
    assert.equal(await page.locator('article,a').count(), 0);
  } finally { await browser.close(); }
});
