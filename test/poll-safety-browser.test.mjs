import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [390, 1440]) test(`shared pause notice and trusted manual refresh work at ${width}px`, async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route('**/poll-safety-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"></head><body><button id="refresh" style="position:fixed;bottom:1.5rem;right:2rem">Refresh</button></body></html>' }));
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
      for (let i = 0; i < 91; i++) await safety.fetch(transport, '/synthetic').catch(() => {});
    });
  });
  const notice = page.locator('[data-poll-safety]');
  assert.equal(await notice.isVisible(), true);
  assert.ok((await page.getByRole('button', { name: 'Resume updates' }).boundingBox()).height >= 44);
  assert.match(await notice.innerText(), /paused.*request limit/i);
  await page.screenshot({ path: `out/test-artifacts/poll-safety/paused-${width}.png` });
  await page.clock.fastForward(5_000);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click({ timeout: 1000 });
  await page.waitForFunction(() => window.requests === 91);
  assert.equal(await page.evaluate(() => window.requests), 91, 'human refresh uses the separate manual allowance');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click({ timeout: 1000 });
  assert.equal(await page.evaluate(() => window.requests), 91, 'double click cannot bypass minimum gap');
  await page.clock.fastForward(65_000);
  await page.getByRole('button', { name: 'Resume updates' }).click();
  await page.waitForFunction(() => document.querySelector('[data-poll-safety]').hidden);
  assert.equal(await notice.isVisible(), false);
  await page.clock.fastForward(30_000);
  await page.waitForFunction(() => window.requests > 91);
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
  await second.clock.install({ time: new Date(Date.now() + 30_000) });
  await second.evaluate(() => window.read());
  assert.equal(await second.evaluate(() => window.requests), 1);
});

test('Resume works in a modal and session invalidation retires its notice', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/poll-modal-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><dialog id="detail"><button>Close detail</button></dialog></body></html>' }));
  await page.clock.install({ time: new Date('2026-10-27T12:00:00Z') });
  await page.goto(`${server.origin}/poll-modal-fixture`);
  await page.evaluate(async () => {
    const { pollSafety } = await import('/js/poll-safety.mjs');
    const safety = pollSafety(window, { document });
    await safety.run(async () => {
      for (let i = 0; i < 91; i++) await safety.fetch(async () => new Response('{}'), '/synthetic').catch(() => {});
    });
    document.querySelector('#detail').showModal();
  });
  await page.clock.fastForward(60_001);
  await page.getByRole('button', { name: 'Resume updates' }).click({ timeout: 1_000 });
  await page.waitForFunction(() => document.querySelector('[data-poll-safety]').hidden);
  assert.equal(await page.locator('[data-poll-safety]').isVisible(), false);
  assert.equal(await page.locator('#detail').isVisible(), true);
  await page.evaluate(async () => {
    const { pollSafety } = await import('/js/poll-safety.mjs');
    const safety = pollSafety(window);
    await safety.run(async () => {
      for (let i = 0; i < 91; i++) await safety.fetch(async () => new Response('{}'), '/synthetic').catch(() => {});
    });
    window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    document.body.replaceChildren(document.createElement('main'));
  });
  assert.equal(await page.locator('body').innerText(), '');
});

test('a focus-trapped drawer cannot make shared Resume inert', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/poll-drawer-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><aside><button id="close">Close drawer</button></aside></body></html>' }));
  await page.goto(`${server.origin}/poll-drawer-fixture`);
  await page.clock.install();
  await page.evaluate(async () => {
    const { pollSafety } = await import('/js/poll-safety.mjs');
    const safety = pollSafety(window, { document });
    document.querySelector('[data-poll-safety]').inert = true;
    document.querySelector('#close').focus();
    await safety.run(async () => {
      for (let i = 0; i < 91; i++) await safety.fetch(async () => new Response('{}'), '/synthetic').catch(() => {});
    });
  });
  await page.clock.fastForward(60_001);
  await page.getByRole('button', { name: 'Resume updates' }).click({ timeout: 1000 });
  await page.waitForFunction(() => document.querySelector('[data-poll-safety]').hidden);
  assert.equal(await page.locator('[data-poll-safety]').isVisible(), false);
});

test('a person can open a record while an exhausted background cycle awaits completion', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/poll-human-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button id="open">Open record</button><output></output>' }));
  await page.goto(`${server.origin}/poll-human-fixture`);
  await page.evaluate(async () => {
    const { pollSafety } = await import('/js/poll-safety.mjs');
    const { createSessionBoundary } = await import('/js/private-session.js');
    const safety = pollSafety(window, { document });
    let ready;
    const admitted = new Promise(resolve => { ready = resolve; });
    window.held = safety.run(async () => {
      for (let i = 0; i < 91; i++) await safety.fetch(async () => new Response('{}'), '/synthetic').catch(() => {});
      await new Promise(resolve => { window.release = resolve; ready(); });
    });
    await admitted;
    const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => Response.json(path === '/auth/session'
      ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : { title: 'Synthetic record' }) });
    document.querySelector('#open').addEventListener('click', async () => {
      try { document.querySelector('output').textContent = (await (await client.fetch('/record')).json()).title; }
      catch (error) { document.querySelector('output').textContent = error.code; }
      finally { window.release(); }
    });
  });
  await page.getByRole('button', { name: 'Open record' }).click();
  await page.waitForFunction(() => document.querySelector('output').textContent === 'Synthetic record');
  assert.equal(await page.locator('output').innerText(), 'Synthetic record');
});
