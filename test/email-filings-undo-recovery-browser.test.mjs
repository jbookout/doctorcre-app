import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

let outDir, server, browser, origin;
const evidence = '/tmp/WR634.S1.J37-evidence';
const filing = n => ({ event_id: `40000000-0000-4000-8000-00000000000${n}`,
  deal: `20000000-0000-4000-8000-00000000000${n}`, current_deal_id: `20000000-0000-4000-8000-00000000000${n}`, activity_version: null,
  subject: `Synthetic lease ${n} ${'LongSubject'.repeat(30)}`, sender_name: 'LongSender'.repeat(30),
  summary: 'PRIVATE synthetic@example.test', occurred_at: '2026-10-27T14:00:00Z' });
const fulfill = (route, result) => route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });

before(async () => {
  outDir = await temporaryDirectory('filing-undo-');
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`automatic filing Undo recovery at ${width} ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `undo-${width}-${theme}`, viewer: 'joe', reset: true } });
    const requests = [], errors = [];
    let committed = false, changed = false, reads = 0, releaseReplay, releaseLate;
    const replay = new Promise(resolve => { releaseReplay = resolve; });
    const late = new Promise(resolve => { releaseLate = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      if (name === 'list-email-thread-filings') {
        reads++;
        return fulfill(route, { filings: [...(committed ? [] : [filing(1)]), { ...filing(2), current_deal_id: changed ? filing(3).deal : filing(2).deal }, { ...filing(3), current_deal_id: null }, { ...filing(4), current_deal_id: undefined }] });
      }
      if (name !== 'undo-email-thread-filing') return route.continue();
      requests.push(JSON.stringify(args));
      if (args.event_id === filing(1).event_id) {
        if (!committed) { committed = true; return route.abort('failed'); }
        await replay;
        return fulfill(route, { ok: true, replayed: true });
      }
      if (args.event_id === filing(2).event_id) { changed = true; return fulfill(route, { error: 'email_thread_filing_changed' }); }
      await late;
      return fulfill(route, { ok: true });
    });
    await page.goto(`${origin}/review-workflows?mode=live`);
    await page.locator('#homeEmailActivity summary').click();
    const panel = page.locator('#homeEmailFilings');
    const first = panel.locator(`[data-filing-id="${filing(1).event_id}"]`), second = panel.locator(`[data-filing-id="${filing(2).event_id}"]`), third = panel.locator(`[data-filing-id="${filing(3).event_id}"]`);
    const undo = first.getByRole('button', { name: 'Undo', exact: true });
    await undo.waitFor();
    assert.equal(await first.getByRole('link').getAttribute('href'), '/deals?deal=20000000-0000-4000-8000-000000000001');
    assert.doesNotMatch(await panel.innerText(), /PRIVATE|example\.test/);
    assert.equal(await third.getByRole('link').count(), 0);
    await third.getByText(/no longer currently filed/).waitFor();
    const legacy = panel.locator(`[data-filing-id="${filing(4).event_id}"]`);
    assert.equal(await legacy.getByRole('link').count(), 0);
    await legacy.getByText('Current filing destination unavailable.', { exact: true }).waitFor();
    assert.equal(await first.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await undo.focus();
    await page.keyboard.press('Enter');
    await first.getByText(/could not confirm/).waitFor();
    assert.ok(reads >= 2);
    assert.equal(await first.getByRole('link').count(), 0);
    await first.getByText(/no longer currently filed/).waitFor();
    assert.equal(committed, true);
    assert.doesNotMatch(await first.innerText(), /left as is|Undone\./);
    assert.equal(await first.getByRole('status').evaluate(node => node === document.activeElement), true);
    await panel.screenshot({ path: join(evidence, `${width}-${theme}-uncertain.png`) });
    await page.keyboard.press('Tab');
    assert.equal(await first.getByRole('button', { name: 'Check outcome' }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter');
    await first.getByText('Checking Undo outcome…', { exact: true }).waitFor();
    assert.equal(await first.getByRole('button').isDisabled(), true);
    await first.getByRole('button').evaluate(button => { button.click(); button.click(); });
    releaseReplay();
    await first.getByText(/Undone\. The email/).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[1], requests[0]);
    assert.equal(await first.getByRole('link').count(), 0);
    assert.equal(await first.getByRole('status').evaluate(node => node === document.activeElement), true);
    await panel.screenshot({ path: join(evidence, `${width}-${theme}-replayed.png`) });
    await second.getByRole('button', { name: 'Undo', exact: true }).click();
    await second.getByText(/changed since it was filed/).waitFor();
    assert.ok(reads >= 3);
    assert.equal(await second.getByRole('link').getAttribute('href'), `/deals?deal=${filing(3).deal}`);
    assert.equal(await second.locator(`a[href="/deals?deal=${filing(2).deal}"]`).count(), 0);
    assert.equal(await second.getByRole('button', { name: 'Undo', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: join(evidence, `${width}-${theme}-refused.png`) });
    await third.getByRole('button', { name: 'Undo', exact: true }).click();
    await third.getByText('Checking Undo outcome…', { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('doctorcre-session-invalidated')));
    await panel.getByText('Sign in to review filed emails.', { exact: true }).waitFor();
    releaseLate();
    await page.waitForLoadState('networkidle');
    assert.doesNotMatch(await panel.innerText(), /Synthetic lease|LongSender|Undone/);
    assert.equal(await panel.getByRole('link').count(), 0);
    assert.deepEqual(errors, []);
  });
}
