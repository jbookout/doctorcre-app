import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { observeFilings, filingRecording } from '../scripts/prove-email-filings-central-source-time.mjs';
let outDir, server, browser;
before(async () => {
  outDir = temporaryDirectory('central-filings-');
  await buildArtifact({ root: process.cwd(), outDir });
  server = await fixtureServer({ root: join(outDir, 'site') });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); if (outDir) await rm(outDir, { recursive: true, force: true }); });
for (const timezoneId of ['UTC', 'America/Los_Angeles', 'America/Chicago']) {
  for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
    test(`Chicago filing source clock ${timezoneId} ${width} ${colorScheme}`, async t => {
      const context = await browser.newContext({ timezoneId, viewport: { width, height: 1000 }, colorScheme });
      t.after(() => context.close());
      const page = await context.newPage();
      await page.goto(server.origin);
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, colorScheme);
      await page.clock.setFixedTime(new Date('2026-11-06T12:00:00Z'));
      const result = await page.evaluate(observeFilings, filingRecording.response);
      assert.deepEqual(result.labels, [
        'From Synthetic Sender · Nov 5, 6:30 PM CST',
        'From Synthetic Sender · Mar 8, 1:59 AM CST',
        'From Synthetic Sender · Mar 8, 3:00 AM CDT',
        'From Synthetic Sender · Nov 1, 1:30 AM CDT',
        'From Synthetic Sender · Nov 1, 1:30 AM CST',
        'From Synthetic Sender · Oct 1, 2025, 8:00 AM CDT',
        'From Synthetic Sender · Feb 29, 2024, 6:00 AM CST',
        ...Array(4).fill('From Synthetic Sender · Time unavailable'),
      ]);
      assert.equal(result.links, 11);
      assert.equal(result.undo, 11);
      assert.equal(result.subject, 'Synthetic filing 0');
      assert.equal(result.reads, 1);
    });
  }
}

test('refresh retry session retirement and disposal ignore late reads', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(server.origin);
  const result = await page.evaluate(async emptyResponse => {
    const { createLiveClient } = await import('/js/live-client.js');
    const recordedClient = createLiveClient({ fetchImpl: async (_path, init) => {
      const rpc = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(emptyResponse) }] } }));
    } });
    const { mountEmailFilings } = await import('/js/email-filings.js');
    const host = document.createElement('section'); document.body.append(host);
    let mode = 'ready', release;
    const client = { listEmailThreadFilings: async () => {
      if (mode === 'error') throw Error('synthetic failure');
      if (mode === 'held') await new Promise(resolve => { release = resolve; });
      return recordedClient.listEmailThreadFilings();
    } };
    const panel = mountEmailFilings({ container: host, client });
    const read = panel.refresh(); const loading = host.getAttribute('aria-busy'); await read;
    const ready = host.textContent.includes('No filed emails');
    mode = 'error'; await panel.refresh(); const error = host.textContent.includes('Could not load');
    mode = 'ready';
    await new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (host.textContent.includes('No filed emails')) { observer.disconnect(); resolve(); }
      });
      observer.observe(host, { childList: true, subtree: true });
      host.querySelector('button').click();
    });
    const retry = host.textContent.includes('No filed emails');
    mode = 'held'; const pending = panel.refresh();
    window.dispatchEvent(new CustomEvent('doctorcre-session-invalidated'));
    const denied = host.textContent; release(); await pending; await panel.refresh();
    const retired = host.textContent === denied; panel.dispose();
    const second = mountEmailFilings({ container: host, client });
    const late = second.refresh(); second.dispose(); const snapshot = host.innerHTML;
    release(); await late; await second.refresh();
    return { loading, ready, error, retry, retired, disposed: snapshot === host.innerHTML };
  }, filingRecording.emptyResponse);
  assert.deepEqual(result, { loading: 'true', ready: true, error: true, retry: true, retired: true, disposed: true });
});

test('ready and failed panels retire on session loss and ready disposal prevents refresh', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.goto(server.origin);
  const result = await page.evaluate(async emptyResponse => {
    const { createLiveClient } = await import('/js/live-client.js');
    const recordedClient = createLiveClient({ fetchImpl: async (_path, init) => {
      const rpc = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(emptyResponse) }] } }));
    } });
    const { mountEmailFilings } = await import('/js/email-filings.js');
    const snapshots = [];
    for (const failed of [false, true]) {
      const host = document.createElement('section'); document.body.append(host);
      const panel = mountEmailFilings({ container: host, client: { listEmailThreadFilings: async () => {
        if (failed) throw Error('synthetic');
        return recordedClient.listEmailThreadFilings();
      } } });
      await panel.refresh();
      window.dispatchEvent(new CustomEvent('doctorcre-session-invalidated'));
      snapshots.push(host.textContent.includes('Sign in to review filed emails.'));
      panel.dispose(); host.remove();
    }
    let reads = 0;
    const host = document.createElement('section'); document.body.append(host);
    const panel = mountEmailFilings({ container: host, client: { listEmailThreadFilings: async () => { reads++; return recordedClient.listEmailThreadFilings(); } } });
    await panel.refresh(); panel.dispose(); await panel.refresh();
    return { snapshots, reads };
  }, filingRecording.emptyResponse);
  assert.deepEqual(result, { snapshots: [true, true], reads: 1 });
});
