import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

let outDir, server, browser, origin;
before(async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  outDir = await mkdtemp(join(tmpdir(), 'email-followups-'));
  await buildArtifact({ root, outDir });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`Home email review confirms and dismisses at ${width}px in ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `email-${width}-${theme}`, viewer: 'joe', reset: true } })).status(), 200);
    await page.goto(`${origin}/?mode=fixture`);
    const card = page.locator('#homeEmailFollowups');
    await card.locator('article').first().waitFor({ timeout: 5000 }).catch(async error => { assert.fail(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`); });
    assert.equal(await card.locator('article').count(), 2);
    assert.doesNotMatch(await card.innerText(), /example.test|@/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('out/test-artifacts/email-followups', { recursive: true });
    await card.screenshot({ path: `out/test-artifacts/email-followups/${width}-${theme}.png`, animations: 'disabled' });
    await page.screenshot({ path: `out/test-artifacts/email-followups/${width}-${theme}-home.png`, animations: 'disabled' });
    const first = card.locator('article').first();
    await first.getByRole('button', { name: 'Confirm', exact: true }).click();
    await first.getByRole('button', { name: 'Confirm change', exact: true }).waitFor();
    await card.screenshot({ path: `out/test-artifacts/email-followups/${width}-${theme}-preview.png`, animations: 'disabled' });
    await first.getByRole('button', { name: 'Confirm change', exact: true }).click();
    await first.getByText('Confirmed.', { exact: true }).waitFor();
    const second = card.locator('article').last();
    await second.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await second.getByRole('textbox', { name: 'Reason for dismissal' }).fill('Already handled in the synthetic review');
    await second.getByRole('button', { name: 'Dismiss proposal', exact: true }).click();
    await second.getByText('Dismissed.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
    await card.getByText('No pending email follow-ups.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  });
}

test('signed-in synthetic Home distinguishes load failure, keeps last good rows, and confirms through the live adapter', async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'email-live-adapter', viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  let fail = true;
  const calls = [];
  await page.route('**/mcp', async route => {
    const rpc = route.request().postDataJSON(); calls.push(rpc.params);
    if (fail && rpc.params.name === 'list-email-proposals') return route.fulfill({ status: 503, json: { error: 'synthetic_outage' } });
    return route.continue();
  });
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.getByText('Could not load email follow-ups.', { exact: true }).waitFor();
  assert.equal(await card.getByText('No pending email follow-ups.', { exact: true }).count(), 0);
  fail = false; await card.getByRole('button', { name: 'Retry email follow-ups' }).click();
  await card.locator('article').first().waitFor();
  fail = true; await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
  await card.getByText(/Showing the last successful read/).waitFor();
  assert.equal(await card.locator('article').count(), 2);
  fail = false; await card.getByRole('button', { name: 'Retry email follow-ups' }).click();
  await card.locator('button[data-email-action="preview"]:enabled').first().waitFor();
  const row = card.locator('article').first();
  await row.getByRole('button', { name: 'Confirm', exact: true }).click();
  await row.getByRole('button', { name: 'Confirm change', exact: true }).click();
  await row.getByText('Confirmed.', { exact: true }).waitFor();
  const preview = calls.find(call => call.name === 'preview-email-next-step');
  const confirm = calls.find(call => call.name === 'confirm-email-next-step');
  assert.ok(preview && confirm);
  assert.deepEqual(Object.fromEntries(Object.entries(confirm.arguments).filter(([key]) => !['proposal_digest', 'idempotency_key'].includes(key))), preview.arguments);
});

test('Home email quality loads separately, retries a failed report, and refreshes after dismissal', async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'email-quality', viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  let fail = true;
  await page.route('**/mcp', async route => {
    if (fail && route.request().postDataJSON().params.name === 'email-proposal-quality') return route.fulfill({ status: 503, json: { error: 'synthetic_outage' } });
    return route.continue();
  });
  await page.goto(`${origin}/?mode=live`);
  const quality = page.getByRole('region', { name: 'Email proposal quality', exact: true });
  await quality.getByText(/Could not load email proposal quality/).waitFor({ timeout: 5000 });
  const review = page.locator('#homeEmailFollowups');
  await review.locator('article').first().waitFor();
  fail = false;
  await quality.getByRole('button', { name: 'Retry email proposal quality' }).click();
  await quality.getByText('Next steps', { exact: true }).waitFor();
  const row = review.locator('article').first();
  await row.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await row.getByRole('textbox', { name: 'Reason for dismissal' }).fill('Already handled in the synthetic review');
  await row.getByRole('button', { name: 'Dismiss proposal' }).click();
  await row.getByText('Dismissed.', { exact: true }).waitFor();
  await quality.getByText('Already handled in the synthetic review', { exact: true }).waitFor();
  assert.match(await quality.innerText(), /100%/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/email-followups', { recursive: true });
  await quality.screenshot({ path: 'out/test-artifacts/email-followups/quality-390.png', animations: 'disabled' });
  fail = true;
  await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
  await quality.getByText(/Showing the last successful read/).waitFor();
  assert.match(await quality.innerText(), /Already handled in the synthetic review/);
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  await quality.getByText(/Sign in/).waitFor();
  assert.doesNotMatch(await quality.innerText(), /Already handled|Demo/);
});
