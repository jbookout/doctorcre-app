import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [390, 1440]) test(`shared pause notice and trusted manual refresh work at ${width}px`, async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route('**/poll-safety-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"></head><body><button id="refresh">Refresh</button></body></html>' }));
  await page.clock.install({ time: new Date('2026-10-27T12:00:00Z') });
  await page.goto(`${server.origin}/poll-safety-fixture`);
  await page.evaluate(async () => {
    const { pollSafety } = await import('/js/poll-safety.mjs');
    const { mountAutoRefresh } = await import('/js/auto-refresh.mjs');
    const safety = pollSafety(window, { document });
    window.requests = 0;
    const transport = async () => { window.requests++; return new Response('{}'); };
    const auto = mountAutoRefresh({ window, document, refresh: () => safety.fetch(transport, '/synthetic') });
    document.querySelector('#refresh').addEventListener('click', auto.refresh);
    await safety.run(async () => {
      for (let i = 0; i < 61; i++) await safety.fetch(transport, '/synthetic').catch(() => {});
    });
  });
  const notice = page.locator('[data-poll-safety]');
  assert.equal(await notice.isVisible(), true);
  assert.ok((await page.getByRole('button', { name: 'Resume updates' }).boundingBox()).height >= 44);
  assert.match(await notice.innerText(), /paused.*request limit/i);
  await page.screenshot({ path: `out/test-artifacts/poll-safety/paused-${width}.png` });
  await page.clock.fastForward(5_000);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await page.evaluate(() => window.requests), 61, 'human refresh uses the separate manual allowance');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await page.evaluate(() => window.requests), 61, 'double click cannot bypass minimum gap');
  await page.clock.fastForward(65_000);
  await page.getByRole('button', { name: 'Resume updates' }).click();
  assert.equal(await notice.isVisible(), false);
  await page.clock.fastForward(30_000);
  await page.waitForFunction(() => window.requests > 61);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `out/test-artifacts/poll-safety/resumed-${width}.png` });
});

test('real browser tabs share one polling owner and hand off after pagehide', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const first = await browser.newPage();
  const second = await first.context().newPage();
  for (const page of [first, second]) {
    await page.route('**/poll-safety-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto(`${server.origin}/poll-safety-fixture`);
    await page.evaluate(async () => {
      const { pollSafety } = await import('/js/poll-safety.mjs');
      window.safety = pollSafety(window, { document });
      window.requests = 0;
      window.read = () => window.safety.run(() => window.safety.fetch(async () => { window.requests++; return new Response('{}'); }, '/synthetic'));
    });
  }
  await first.evaluate(() => window.read());
  await second.evaluate(() => window.read());
  assert.equal(await first.evaluate(() => window.requests), 1);
  assert.equal(await second.evaluate(() => window.requests), 0);
  await first.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await second.clock.install({ time: new Date(Date.now() + 10_000) });
  await second.evaluate(() => window.read());
  assert.equal(await second.evaluate(() => window.requests), 1);
});
