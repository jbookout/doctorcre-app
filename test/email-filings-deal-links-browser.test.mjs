import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium, settles } from './browser-harness.mjs';

let outDir, server, browser, origin;
const deal = n => `20000000-0000-4000-8000-00000000000${n}`;
const filing = n => ({ event_id: `40000000-0000-4000-8000-00000000000${n}`, deal: deal(n), current_deal_id: deal(n),
  activity_version: null, subject: n === 1 ? 'Demo lease terms and floor plan review for the expanded synthetic practice location' : 'Demo tour confirmation',
  sender_name: 'Demo Sender', occurred_at: '2026-10-27T14:00:00Z', summary: 'PRIVATE demo@example.test' });
const fulfill = (route, result) => route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });

before(async () => {
  outDir = await temporaryDirectory('filing-links-');
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  server = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
  origin = server.origin;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await server.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`filed receipt opens its exact deal and returns to Home at ${width} ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const context = page.context();
    t.after(() => context.close());
    await context.tracing.start({ screenshots: true, snapshots: true });
    const started = performance.now(), timeline = [], documents = [];
    const record = (event, details = {}) => timeline.push({ elapsedMs: performance.now() - started, event, url: page.url(), ...details });
    page.on('framenavigated', frame => record('framenavigated', { frameUrl: frame.url(), mainFrame: frame === page.mainFrame() }));
    page.on('load', () => record('load'));
    page.on('domcontentloaded', () => record('domcontentloaded'));
    page.on('pageerror', error => record('pageerror', { message: error.message, stack: error.stack }));
    page.on('console', message => { if (message.type() === 'error') record('console', { message: message.text(), location: message.location() }); });
    page.on('requestfailed', request => record('requestfailed', { requestUrl: request.url(), method: request.method(), failure: request.failure() }));
    const snapshot = async phase => {
      const document = { phase, elapsedMs: performance.now() - started, url: page.url() };
      try {
        Object.assign(document, await page.evaluate(() => ({
          readyState: window.document.readyState,
          historyLength: history.length,
          documentUrl: location.href,
          title: window.document.title,
          dealId: new URL(location.href).searchParams.get('deal'),
          renderedDealTitle: window.document.querySelector('#panelTitle')?.textContent ?? null,
          renderedDeal: window.document.querySelector('#recordPanel')?.innerText ?? null,
          homeEmailActivityExists: !!window.document.querySelector('#homeEmailActivity'),
          homeRootExists: !!window.document.querySelector('#homeRoot, main.home-shell'),
        })));
      } catch (error) { document.captureError = error.message; }
      documents.push(document);
    };
    try {
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
      await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `filings-${width}-${theme}`, viewer: 'joe', reset: true } });
      let refuse = true, empty = false, holdRead = false, releaseRead;
      const calls = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // Loopback requires mode=live on each document; deployed hosts select it by hostname.
      await page.route('**/deals?deal=*', route => route.fulfill({ status: 302, headers: { location: route.request().url().replace('/deals?deal=', '/deals?mode=live&deal=') } }));
      await page.route('**/mcp', async route => {
        const rpc = route.request().postDataJSON(), { name, arguments: args } = rpc.params;
        calls.push({ name, args });
        if (name === 'list-email-thread-filings') {
          if (holdRead) await new Promise(resolve => { releaseRead = resolve; });
          return fulfill(route, { filings: empty ? [] : [filing(1), filing(2), { ...filing(3), deal: null, current_deal_id: undefined }] });
        }
        if (name === 'undo-email-thread-filing') return fulfill(route, refuse ? { error: 'email_thread_filing_changed' } : { ok: true });
        if (name === 'deal-room-board' || name === 'get-deal-room') {
          const response = await route.fetch({ postData: JSON.stringify({ ...rpc, params: { ...rpc.params, arguments: { ...args, ...(args.deal ? { deal: args.deal.replace(/^20000000-0000-4000-8000-00000000000([12])$/, 'qa-deal-$1') } : {}) } } }) });
          const body = (await response.text()).replaceAll('qa-deal-1"', `${deal(1)}"`).replaceAll('qa-deal-2"', `${deal(2)}"`);
          return route.fulfill({ response, body });
        }
        return route.continue();
      });
      await page.goto(`${origin}/review-workflows?mode=live`);
      const filingsRead = page.waitForResponse(response => response.url() === `${origin}/mcp`
        && response.request().postDataJSON()?.params?.name === 'list-email-thread-filings');
      await page.locator('#homeEmailActivity summary').click();
      await filingsRead;
      const panel = page.locator('#homeEmailFilings'), first = panel.locator('article').first();
      await first.getByRole('link', { name: 'Open filed deal', exact: true }).waitFor({ timeout: 5000 }).catch(async error => { assert.fail(`${error.message}\n${await panel.innerHTML()}\n${JSON.stringify(calls)}\n${errors.join('\n')}`); });
      await first.locator('h3').evaluate(node => { node.textContent = 'LongSubject'.repeat(30); });
      await first.locator('p').first().evaluate(node => { node.textContent = 'LongSender'.repeat(30); });
      assert.equal(await first.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'long subject and sender fit in the card');
      assert.deepEqual(await panel.getByRole('link').evaluateAll(links => links.map(a => a.getAttribute('href'))), [`/deals?deal=${deal(1)}`, `/deals?deal=${deal(2)}`]);
      assert.doesNotMatch(await panel.innerText(), /PRIVATE|example\.test|20000000/);
      await panel.getByText('Current filing destination unavailable.', { exact: true }).waitFor();
      await panel.scrollIntoViewIfNeeded();
      // Scrolling can place Undo under the pointer; compare both controls at rest.
      await page.mouse.move(0, 0);
      const controls = await first.evaluate(article => {
        const link = article.querySelector('a'), undo = article.querySelector('button');
        return {
          gap: undo.getBoundingClientRect().left - link.getBoundingClientRect().right,
          backgrounds: [link, undo].map(control => getComputedStyle(control).backgroundColor),
        };
      });
      assert.ok(controls.gap >= 4 && controls.backgrounds[0] === controls.backgrounds[1],
        `Filed receipt controls need a gap and matching backgrounds: ${JSON.stringify(controls)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(calls.filter(call => call.name === 'list-email-thread-filings').length, 1);
      assert.equal(calls.filter(call => call.name === 'get-deal-room').length, 0);
      await first.getByRole('link', { name: 'Open filed deal' }).focus();
      const dealRead = page.waitForResponse(response => {
        if (response.url() !== `${origin}/mcp`) return false;
        const { name, arguments: args } = response.request().postDataJSON().params;
        return name === 'get-deal-room' && args.deal === deal(1);
      });
      await page.keyboard.press('Enter');
      await dealRead;
      await page.waitForURL(`**/deals?mode=live&deal=${deal(1)}`);
      await page.locator('#recordPanel').getByRole('button', { name: 'Back to deals', exact: true }).waitFor();
      assert.ok(calls.some(call => call.name === 'get-deal-room' && call.args.deal === deal(1)));
      assert.equal(calls.some(call => call.name === 'undo-email-thread-filing'), false);
      await snapshot('before Back');
      await page.goBack();
      await snapshot('after Back');
      if (!await page.locator('#homeEmailActivity').evaluate(node => node.open)) await page.locator('#homeEmailActivity summary').click();
      await first.getByRole('button', { name: 'Undo', exact: true }).click();
      await first.getByText(/Undo was refused/).waitFor();
      assert.equal(await first.getByRole('link').count(), 1);
      refuse = false;
      await first.getByRole('button', { name: 'Undo', exact: true }).click();
      await first.getByText(/Undone\. The email/).waitFor();
      assert.equal(await first.getByRole('link').count(), 0);
      assert.equal(await first.getByRole('status').evaluate(node => node === document.activeElement), true);
      const write = calls.find(call => call.name === 'undo-email-thread-filing');
      assert.deepEqual(Object.keys(write.args).sort(), ['event_id', 'idempotency_key']);
      assert.equal(write.args.event_id, filing(1).event_id);
      empty = true;
      await page.reload();
      await page.locator('#homeEmailActivity summary').click();
      await panel.getByText('No filed emails to review.', { exact: true }).waitFor();
      holdRead = true;
      await page.reload();
      await page.locator('#homeEmailActivity summary').click();
      await panel.getByText('Loading filed emails…', { exact: true }).waitFor();
      await settles(() => assert.equal(typeof releaseRead, 'function', 'the pending filings read is held'));
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('doctorcre-session-invalidated')));
      await panel.getByText('Sign in to review filed emails.', { exact: true }).waitFor();
      releaseRead();
      assert.equal(await panel.getByRole('link').count(), 0);
      assert.deepEqual(errors, []);
    } catch (error) {
      const artifact = `out/browser-results/email-filings-home-return-${width}-${theme}`;
      const captureErrors = [];
      await snapshot('failure');
      try {
        await mkdir('out/browser-results', { recursive: true });
        for (const [name, capture] of [
          ['screenshot', () => page.screenshot({ path: `${artifact}.png`, timeout: 5000 })],
          ['trace', () => context.tracing.stop({ path: `${artifact}.zip` })],
        ]) {
          try { await capture(); } catch (captureError) { captureErrors.push(`${name}: ${captureError.message}`); }
        }
        await writeFile(`${artifact}.json`, JSON.stringify({ test: t.name, expectedDeal: deal(1), documents, timeline, captureErrors }, null, 2));
      } catch (captureError) { captureErrors.push(captureError.message); }
      throw new Error(`${error.message}\nHome-return diagnostics: ${artifact}.json, ${artifact}.png, ${artifact}.zip${captureErrors.length ? `\nCapture errors: ${captureErrors.join('; ')}` : ''}`, { cause: error });
    } finally {
      await context.tracing.stop().catch(() => {});
    }
  });
}
