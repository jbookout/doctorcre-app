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
  outDir = await mkdtemp(join(tmpdir(), 'home-decisions-'));
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

const filing = { event_id: '40000000-0000-4000-8000-000000000001', deal: 'qa-deal-1', activity_id: '40000000-0000-4000-8000-0000000000a1', recorded_at: '2026-10-27T15:00:00Z',
  summary: 'Demo summary', subject: 'Demo lease question', sender_name: 'Demo Landlord', occurred_at: '2026-10-27T14:00:00Z', activity_version: 1 };
const pendingReply = { id: 'pending-joe', deal: 'qa-deal-1', status: 'approved_to_send', kind: 'reply_draft', reply_draft: { owner: 'joe', subject: 'Demo reply', body: 'Private body' },
  send_result: null, submitted_email: { subject: 'Demo joe submitted reply' } };
const text = value => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });

async function open(t, { width = 390, height = 844, agendaFails = false, onScript } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const reads = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    reads.push({ name, args });
    if (agendaFails && name === 'read-home-agenda') return route.fulfill({ status: 503, json: { error: 'synthetic_outage' } });
    if (name === 'list-email-thread-filings') return route.fulfill({ json: text({ filings: [filing] }) });
    if (name === 'list-email-proposals' && args.mode === 'recent_outcomes') return route.fulfill({ json: text({ schema_version: 'email-reply-outcomes.v1', proposals: [], send: false, more: false, next_cursor: null }) });
    if (name === 'list-email-proposals' && args.status === 'approved_to_send') return route.fulfill({ json: text({ schema_version: 'email-proposals.v1', proposals: [pendingReply], send: false, more: false, next_cursor: null }) });
    return route.continue();
  });
  if (onScript) await page.route('**/js/reply-outcomes.js', async route => { await onScript(page); await route.continue(); });
  assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `decisions-${width}-${agendaFails}-${Boolean(onScript)}`, viewer: 'joe', reset: true } })).status(), 200);
  await page.goto(`${origin}/?mode=live`);
  return { page, reads, errors };
}

for (const width of [390, 1440]) test(`Home puts call and email decisions first and loads email activity without scrolling at ${width}px`, async t => {
  const { page, errors } = await open(t, { width, height: width === 390 ? 844 : 1000 });
  const order = await page.evaluate(() => [...document.querySelectorAll('#main section.home-panel')].filter(node => node.parentElement.closest('section.home-panel') === null).map(node => node.id));
  assert.deepEqual(order.slice(0, 4), ['homeCallOutcomes', 'homeCallTasks', 'homeEmailFollowups', 'dealAttention']);
  const activity = page.locator('#homeEmailActivity');
  await page.locator('#homeEmailFollowups article').first().waitFor({ timeout: 5000 });
  await activity.getByText('Demo joe submitted reply', { exact: true }).waitFor({ timeout: 5000 });
  await activity.getByText('Demo lease question', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => scrollY), 0, 'nothing had to scroll into view to load');

  assert.equal(await page.getByRole('heading', { name: 'Email activity', exact: true }).count(), 1);
  assert.deepEqual(await activity.locator('h3').allInnerTexts(), ['Pending replies', 'Recent replies', 'Filed automatically']);
  assert.equal(await activity.getByRole('button', { name: 'Undo', exact: true }).count(), 1);
  for (const gone of ['Email proposal quality', 'Reply delivery', 'Automatic email filings']) assert.equal(await page.getByText(gone).count(), 0, `${gone} is gone from Home`);
  assert.doesNotMatch(await activity.innerText(), /filing|proposal|Private body/i);

  await page.locator('#dealAttention[aria-busy="false"]').waitFor();
  const counts = await page.locator('#dealCounts').evaluate(node => ({
    inFooter: Boolean(node.closest('#dealAttention > .home-panel-foot')) && node.checkVisibility(),
    afterFlags: Boolean(document.getElementById('dealFlags').compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
    ink: getComputedStyle(node).color, figure: getComputedStyle(node.querySelector('b')).color, body: getComputedStyle(document.body).color,
  }));
  assert.ok(counts.inFooter && counts.afterFlags, 'the counts line sits in the deals panel footer');
  assert.equal(counts.figure, counts.ink, 'the counts figures are muted with their labels');
  assert.notEqual(counts.ink, counts.body);
  const link = await page.locator('#homePrimaryAction').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, text: node.textContent.trim() }));
  assert.equal(link.background, 'rgba(0, 0, 0, 0)', 'the deals link carries no accent fill');
  assert.equal(link.text, 'All deals');

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/home-decisions', { recursive: true });
  await page.screenshot({ path: `out/test-artifacts/home-decisions/home-${width}.png`, fullPage: true, animations: 'disabled' });
  await activity.screenshot({ path: `out/test-artifacts/home-decisions/email-activity-${width}.png`, animations: 'disabled' });
  assert.deepEqual(errors, []);
});

for (const width of [390, 1440]) test(`each whole Home deal flag opens its deal at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `flags-${width}`, viewer: 'joe', reset: true } });
  await page.goto(origin);
  const flag = page.locator('#dealFlags .home-flag').first();
  await flag.waitFor();
  await mkdir('out/test-artifacts/home-decisions', { recursive: true });
  await page.locator('#dealAttention').screenshot({ path: `out/test-artifacts/home-decisions/deal-flags-${width}.png`, animations: 'disabled' });
  await flag.evaluate(node => node.scrollIntoView({ block: 'center' }));
  const name = flag.locator('h3 a');
  const [flagBox, nameBox, href] = [await flag.boundingBox(), await name.boundingBox(), await name.getAttribute('href')];
  assert.ok(nameBox.height >= 44, `deal name target is ${nameBox.height}px tall`);
  const linkAt = (x, y) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'), [x, y]);
  const spot = [flagBox.x + flagBox.width - 6, nameBox.y + nameBox.height / 2];
  assert.equal(await linkAt(...spot), href, 'empty space in the flag opens the deal');
  const items = flag.locator('.deal-items a');
  if (await items.count()) {
    const item = await items.first().boundingBox();
    assert.equal(await linkAt(item.x + 4, item.y + item.height / 2), await items.first().getAttribute('href'), 'item links stay tappable on their own');
  }
  await page.mouse.click(...spot);
  await page.waitForURL(url => url.search.includes('deal='));
});

test('Home still loads email activity when the agenda read fails', async t => {
  const { page } = await open(t, { agendaFails: true });
  await page.locator('#dealFlags').getByText('Deals unavailable', { exact: true }).waitFor();
  await page.locator('#homeEmailActivity').getByText('Demo lease question', { exact: true }).waitFor({ timeout: 5000 });
});

test('Home session loss during the email activity download prevents a late reply read', async t => {
  const { page, reads } = await open(t, { onScript: page => page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated'))) });
  await page.locator('#homeReplyOutcomes').getByText(/Sign in/).waitFor({ timeout: 5000 });
  assert.equal(reads.filter(read => read.name === 'list-email-proposals' && read.args.mode === 'recent_outcomes').length, 0);
});
