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
  outDir = await mkdtemp(join(tmpdir(), 'reply-outcomes-'));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
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
const sent = { id: '10000000-0000-4000-8000-000000000001', deal: 'demo-deal', subject: 'Demo sent reply', outcome: 'sent', result_recorded_at: '2026-10-28T12:00:00Z', failure_reason_code: null };
const failed = { ...sent, id: '10000000-0000-4000-8000-000000000002', subject: 'Demo failed reply', outcome: 'failed', failure_reason_code: 'unconfirmed_after_dispatch' };
const pending = owner => ({ id: `pending-${owner}`, deal: 'demo-deal', status: 'approved_to_send', kind: 'reply_draft', reply_draft: { owner, subject: `Demo ${owner} pending reply`, body: 'Private body' }, send_result: null, submitted_email: { subject: `Demo ${owner} submitted reply` } });
const pageOf = (proposals, more = false) => ({ schema_version: 'email-reply-outcomes.v1', proposals, send: false, more, next_cursor: more ? proposals.at(-1).id : null });
async function open(t, { width = 390, outcomes = () => pageOf([sent, failed]), waiting = () => ({ schema_version: 'email-proposals.v1', proposals: [pending('joe'), pending('dell')], send: false, more: false, next_cursor: null }) } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const calls = [];
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (name !== 'list-email-proposals' || (!args.mode && args.status !== 'approved_to_send')) return route.continue();
    calls.push(args);
    try { return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(await (args.mode ? outcomes(args) : waiting(args))) }] } } }); }
    catch { return route.fulfill({ status: 503, json: { error: 'synthetic_read_failure' } }); }
  });
  assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `reply-${width}`, viewer: 'joe', reset: true } })).status(), 200);
  await page.goto(`${origin}/?mode=live`);
  await page.locator('#dealAttention[aria-busy="false"]').waitFor();
  const card = page.locator('#homeReplyOutcomes');
  assert.equal(await card.count(), 1, 'Home has a sent replies outcomes panel');
  await card.scrollIntoViewIfNeeded();
  await card.locator('h2').waitFor();
  return { page, card, calls };
}

for (const width of [390, 1440]) test(`Home renders signed-in partner sent replies outcomes at ${width}px`, async t => {
  const { page, card, calls } = await open(t, { width });
  await card.getByText('Demo sent reply', { exact: true }).waitFor();
  await card.getByText('Demo failed reply', { exact: true }).waitFor();
  await card.getByText('Demo joe submitted reply', { exact: true }).waitFor();
  assert.match(await card.innerText(), /Sent/);
  assert.match(await card.innerText(), /Failed.*Delivery could not be confirmed/s);
  assert.match(await card.innerText(), /Pending.*Delivery is not yet confirmed/s);
  assert.doesNotMatch(await card.innerText(), /dell|Private body|example.test/);
  assert.equal(await card.locator('time').first().getAttribute('datetime'), sent.result_recorded_at);
  await page.locator('[data-scope="team"]').click();
  assert.doesNotMatch(await card.innerText(), /dell/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(calls.some(args => args.mode === 'recent_outcomes' && args.limit === 20 && !Object.hasOwn(args, 'status')));
  await mkdir('out/test-artifacts/reply-outcomes', { recursive: true });
  await page.setViewportSize({ width, height: 1200 });
  await card.evaluate(node => window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - 100, behavior: 'instant' }));
  await page.screenshot({ path: `out/test-artifacts/reply-outcomes/home-${width}.png`, animations: 'disabled' });
});

test('Home distinguishes a successful empty reply outcomes read from unavailable data', async t => {
  const { card } = await open(t, { outcomes: () => pageOf([]), waiting: () => ({ schema_version: 'email-proposals.v1', proposals: [], send: false, more: false, next_cursor: null }) });
  await card.page().waitForFunction(() => document.querySelector('#homeReplyOutcomes')?.getAttribute('aria-busy') === 'false');
  assert.match(await card.innerText(), /No recorded reply outcomes\./);
  assert.match(await card.innerText(), /No replies pending delivery\./);
  assert.equal(await card.locator('article').count(), 0);
});

test('Home shows a reply outcomes read error with retry while keeping pending replies', async t => {
  let failedRead = true;
  const { card, page } = await open(t, { outcomes: () => { if (failedRead) throw Error('offline'); return pageOf([sent]); } });
  await page.waitForFunction(() => document.querySelector('#homeReplyOutcomes')?.getAttribute('aria-busy') === 'false');
  assert.match(await card.innerText(), /Could not load recent reply outcomes/);
  assert.doesNotMatch(await card.innerText(), /No recorded reply outcomes/);
  assert.match(await card.innerText(), /Demo joe submitted reply/);
  failedRead = false;
  await card.getByRole('button', { name: 'Retry recent reply outcomes' }).click();
  await card.getByText('Demo sent reply', { exact: true }).waitFor();
});

test('Home reply outcomes pagination is bounded and retries the same failed page', async t => {
  let failPage = true;
  const { card, page, calls } = await open(t, {
    outcomes: args => { if (!args.cursor) return pageOf([sent], true); if (failPage) throw Error('offline'); return pageOf([failed]); },
    waiting: args => ({ schema_version: 'email-proposals.v1', proposals: args.cursor ? [pending('joe')] : [pending('dell')], send: false, more: !args.cursor, next_cursor: args.cursor ? null : 'pending-dell' }),
  });
  await page.waitForFunction(() => document.querySelector('#homeReplyOutcomes')?.getAttribute('aria-busy') === 'false');
  assert.equal(calls.filter(args => args.mode).length, 1, 'initial read does not drain history');
  assert.match(await card.innerText(), /No matching replies on this page/);
  assert.doesNotMatch(await card.innerText(), /No replies pending delivery/);
  assert.equal(await card.getByRole('button', { name: 'Load more outcomes', exact: true }).count(), 1);
  await card.getByRole('button', { name: 'Load more outcomes', exact: true }).click();
  await card.getByText(/Could not load recent reply outcomes/).waitFor();
  assert.match(await card.innerText(), /Demo sent reply/);
  failPage = false;
  await card.getByRole('button', { name: 'Retry recent reply outcomes', exact: true }).click();
  await card.getByText('Demo failed reply', { exact: true }).waitFor();
  assert.equal(await card.locator('[data-reply-outcome]').count(), 2);
  assert.equal(await card.getByRole('button', { name: 'Load more outcomes', exact: true }).count(), 0);
  await card.getByRole('button', { name: 'Load more pending replies', exact: true }).click();
  await card.getByText('Demo joe submitted reply', { exact: true }).waitFor();
  assert.deepEqual(calls.filter(args => args.mode).map(args => args.cursor || null), [null, sent.id, sent.id]);
  assert.deepEqual(calls.filter(args => args.status).map(args => args.cursor || null), [null, 'pending-dell']);
  assert.ok(calls.every(args => args.limit === 20));
});
