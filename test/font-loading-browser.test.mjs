import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';

test('Slice A every optional Google font stylesheet is a nonblocking preload', async () => {
  const files = execFileSync('git', ['ls-files', '*.html'], { encoding: 'utf8' }).trim().split('\n');
  const blocking = [];
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    for (const link of html.matchAll(/<link\b[^>]*https:\/\/fonts\.googleapis\.com\/css[^>]*>/g)) {
      if (!/rel="preload"/.test(link[0]) || !/as="style"/.test(link[0]) || !/data-font-stylesheet/.test(link[0])) blocking.push(file);
    }
  }
  assert.deepEqual(blocking, []);
});

for (const path of ['/', '/leads', '/deals']) for (const fonts of ['held', 'available']) {
  test(`Slice A ${path} paints and exposes primary controls with ${fonts} font CSS`, async t => {
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const server = await fixtureServer(); t.after(() => server.close());
    const origin = path === '/leads' ? 'http://localhost' : server.origin;
    if (path === '/leads') await routeLeads(page);
    let fontRequests = 0, fontCompleted = false;
    await page.route('https://fonts.googleapis.com/**', route => {
      fontRequests++;
      if (fonts === 'available') {
        fontCompleted = true;
        return route.fulfill({ contentType: 'text/css', body: ':root { --synthetic-font-loaded: yes; }' });
      }
    });
    await page.goto(origin + path, { waitUntil: 'commit' });
    await page.waitForFunction(() => performance.getEntriesByType('paint').some(entry => entry.name === 'first-contentful-paint'), null, { timeout: 3000 });
    assert.ok(fontRequests > 0, 'the font request really started');
    assert.equal(fontCompleted, fonts === 'available', 'held CSS has not completed at first contentful paint');
    await page.getByRole('button', { name: 'Joe: account and settings', exact: true }).waitFor();
    const primary = page.locator(path === '/' ? '#refreshHome' : path === '/leads' ? '#leadSearch' : '#boardView');
    await primary.waitFor();
    assert.ok(await primary.isEnabled());
    if (fonts === 'available') {
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--synthetic-font-loaded').trim() === 'yes');
    }
    assert.match(await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily), /Arial|system-ui|sans-serif/);
  });
}
