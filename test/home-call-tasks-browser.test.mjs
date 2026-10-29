import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let outDir, server, browser, origin;
before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'home-call-tasks-'));
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

const task = (id, owner = 'joe', due_on = '2026-10-02') => ({
  id, session_id: 'demo-call-session', kind: 'assigned_action', deal_id: 'qa-deal-1', deal_name: 'Demo coastal purchase',
  payload: { deal_id: 'qa-deal-1', assignee: owner, action: `Demo ${id} lender follow-up`, due_on },
  evidence_quote: 'Joe will call the demo lender.', created_at: '2026-10-01T14:00:00Z',
});

async function open(t, { width = 1280, candidates = [task('proposal-joe')], companion = null, holdCommands = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `call-tasks-${width}`, viewer: 'joe', reset: true } })).status(), 200);
  const pending = structuredClone(candidates), actions = [], writes = [], reads = [], errors = [], gate = { hold: null };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/mcp', async route => {
    const rpc = route.request().postDataJSON();
    const { name, arguments: args } = rpc.params;
    const reply = payload => route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    if (name === 'read-post-call-followups') {
      reads.push(name);
      await gate.hold;
      return reply({ schema_version: 'post-call-followups.v1', candidates: pending, send: false });
    }
    if (name === 'resolve-post-call-candidate') {
      writes.push(args);
      const index = pending.findIndex(row => row.id === args.candidate_id);
      assert.ok(index >= 0);
      const candidate = pending.splice(index, 1)[0];
      if (!args.accept) return reply({ ok: true, candidate_id: candidate.id, status: 'skipped', ref: null });
      const action = { id: `action-${candidate.id}`, owner: candidate.payload.assignee, description: candidate.payload.action,
        due_on: candidate.payload.due_on, status: 'open', hold_until: null };
      actions.push(action);
      return reply({ ok: true, candidate_id: candidate.id, status: 'confirmed', ref: action.id, assignee: action.owner });
    }
    if (name === 'read-home-agenda') {
      reads.push(name);
      const response = await route.fetch();
      const envelope = await response.json();
      const agenda = JSON.parse(envelope.result.content[0].text);
      const deal = agenda.deals.find(row => row.id === 'qa-deal-1');
      deal.next_actions = [...deal.next_actions, ...actions];
      envelope.result.content[0].text = JSON.stringify(agenda);
      return route.fulfill({ response, json: envelope });
    }
    return route.continue();
  });
  const companionRequests = [];
  if (companion) await page.route('http://127.0.0.1:4682/**', async route => {
    const url = new URL(route.request().url());
    companionRequests.push({ path: url.pathname, session: url.searchParams.get('session'), method: route.request().method() });
    if (companion.unavailable || companion.reportUnavailable && url.pathname === '/api/post-call') return route.abort();
    return route.fulfill({ json: url.pathname === '/api/state'
      ? { state: 'filed', mode: 'weekly_deal_call', session: 'demo-latest-call' }
      : { status: { state: 'filed' }, report: { draft_proposals: [{ draft_id: 'demo-draft', candidate_id: 'proposal-email',
        deal_id: 'qa-deal-1', deal_name: 'Demo coastal purchase', recipient_name: 'Demo lender', subject: 'Demo saved email',
        body: 'Demo lender follow-up from the older call.', content_hash: 'a'.repeat(64), status: 'pending' }] } } });
  });
  let releaseCommands;
  if (holdCommands) {
    const commands = new Promise(resolve => { releaseCommands = resolve; });
    t.after(() => releaseCommands());
    await page.route('**/js/retained-commands.mjs', async route => { await commands; await route.continue().catch(() => {}); });
    await page.exposeFunction('__resolveCallTask', args => {
      writes.push(args);
      return { ok: true, candidate_id: args.candidate_id, status: args.accept ? 'confirmed' : 'skipped', ref: 'demo-action', assignee: 'joe' };
    });
    await page.route(url => url.pathname === '/js/home-boot.js' && !url.search, route => route.fulfill({
      contentType: 'text/javascript', body: `import { homeClient as original } from './home-boot.js?fixture';
        export const homeClient = original.then(client => {
          client.getPostCallFollowups = async () => ({ schema_version: 'post-call-followups.v1', candidates: ${JSON.stringify(candidates)}, send: false });
          client.resolvePostCallCandidate = window.__resolveCallTask;
          return client;
        });`,
    }));
  }
  await page.goto(`${origin}/${holdCommands ? '' : '?mode=live'}`, { waitUntil: holdCommands ? 'commit' : 'load' });
  await page.locator('#refreshHome[aria-busy="false"]').waitFor();
  return { page, pending, actions, writes, reads, errors, gate, releaseCommands, companionRequests };
}

test('Home adds a reviewed call task and reads its exact owner, date and text through the agenda', async t => {
  const { page, actions, writes, reads, errors } = await open(t);
  const proposal = page.locator('[data-call-task="proposal-joe"]');
  await proposal.waitFor();
  assert.match(await proposal.innerText(), /Demo coastal purchase.*Demo proposal-joe lender follow-up.*Joe.*Oct 2/s);
  assert.equal(await proposal.getByRole('link', { name: 'Demo coastal purchase' }).getAttribute('href'), '/deals?deal=qa-deal-1');
  assert.equal(writes.length, 0);
  await mkdir(join(root, 'out/test-artifacts/home-call-tasks'), { recursive: true });
  await page.locator('#dealAttention').screenshot({ path: join(root, 'out/test-artifacts/home-call-tasks/desktop-review.png') });
  await proposal.getByRole('button', { name: 'Add Joe task', exact: true }).click();
  await page.getByText('Task added', { exact: true }).waitFor();
  await page.locator('#homeBrief').getByText('Demo proposal-joe lender follow-up', { exact: true }).waitFor();
  assert.deepEqual(actions, [{ id: 'action-proposal-joe', owner: 'joe', description: 'Demo proposal-joe lender follow-up', due_on: '2026-10-02', status: 'open', hold_until: null }]);
  assert.deepEqual(writes.map(({ candidate_id, accept }) => ({ candidate_id, accept })), [{ candidate_id: 'proposal-joe', accept: true }]);
  assert.match(writes[0].idempotency_key, /^[0-9a-f-]{36}$/);
  assert.ok(reads.filter(name => name === 'read-home-agenda').length >= 2);
  assert.deepEqual(errors, []);
});

test('phone Home scopes by proposed assignee and skipping a sibling creates no task or email', async t => {
  const email = { ...task('proposal-email'), kind: 'email_draft', payload: { deal_id: 'qa-deal-1', recipient_party_id: 'demo-recipient', recipient_ref: 'DEMO-P-01', subject: 'Demo email proposal', body_sha256: 'a'.repeat(64) } };
  const { page, actions, writes, errors } = await open(t, { width: 390, candidates: [task('proposal-joe'), task('proposal-dell', 'dell', null), email] });
  await page.locator('[data-call-task="proposal-dell"]').waitFor();
  assert.match(await page.locator('[data-call-task="proposal-dell"]').innerText(), /Dell.*No date/s);
  assert.equal(await page.locator('[data-call-task="proposal-email"]').count(), 0);
  await page.getByRole('button', { name: 'Just me', exact: true }).click();
  assert.equal(await page.locator('[data-call-task="proposal-joe"]').count(), 1);
  assert.equal(await page.locator('[data-call-task="proposal-dell"]').count(), 0);
  await page.getByRole('button', { name: 'Team view', exact: true }).click();
  const sibling = page.locator('[data-call-task="proposal-dell"]');
  await sibling.getByText('Call evidence', { exact: true }).click();
  assert.match(await sibling.innerText(), /Joe will call the demo lender/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#dealAttention').screenshot({ path: join(root, 'out/test-artifacts/home-call-tasks/phone-review.png') });
  await sibling.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByText('Task skipped', { exact: true }).waitFor();
  assert.deepEqual(actions, []);
  assert.deepEqual(writes.map(({ candidate_id, accept }) => ({ candidate_id, accept })), [{ candidate_id: 'proposal-dell', accept: false }]);
  assert.equal(await page.locator('#homeBrief').getByText('Demo proposal-dell lender follow-up', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('a slow Home refresh keeps the call task section and keyboard focus in place', async t => {
  const { page, gate, errors } = await open(t, { candidates: [task('proposal-joe'), task('proposal-dell', 'dell', null)] });
  const skip = '[data-call-task-key="proposal-joe:false"]';
  await page.locator(skip).focus();
  let release;
  gate.hold = new Promise(resolve => { release = resolve; });
  await page.evaluate(() => document.getElementById('refreshHome').click());
  await page.locator('#refreshHome[aria-busy="true"]').waitFor();
  await page.locator(`${skip}[aria-disabled="true"]`).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.callTaskKey), 'proposal-joe:false');
  assert.equal(await page.locator('#homeCallTasks').isVisible(), true);
  release();
  await page.locator('#refreshHome[aria-busy="false"]').waitFor();
  await page.locator(`${skip}:not([aria-disabled="true"])`).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.callTaskKey), 'proposal-joe:false');
  assert.deepEqual(errors, []);
});


for (const width of [390, 1280]) test(`Home opens the exact saved email report at ${width}px without creating a draft`, async t => {
  const email = { ...task('proposal-email'), session_id: 'demo-older-call', kind: 'email_draft', payload: {
    deal_id: 'qa-deal-1', recipient_party_id: 'demo-recipient', recipient_ref: 'DEMO-P-01', subject: 'Demo saved email', body_sha256: 'a'.repeat(64) } };
  const { page, writes, companionRequests, errors } = await open(t, { width, candidates: [email], companion: {} });
  const proposal = page.locator('[data-call-draft="proposal-email"]');
  await proposal.waitFor();
  assert.match(await proposal.innerText(), /Demo coastal purchase.*Demo saved email.*DEMO-P-01.*Draft only/s);
  assert.equal(await proposal.getByRole('link').getAttribute('href'), '/deals?deal=qa-deal-1');
  assert.equal(await proposal.getByRole('button').count(), 1);
  await mkdir(join(root, 'out/test-artifacts/home-call-drafts'), { recursive: true });
  await proposal.screenshot({ path: join(root, `out/test-artifacts/home-call-drafts/${width}-offer.png`) });
  await proposal.getByRole('button', { name: 'Review draft', exact: true }).click();
  await page.locator('#callModeDialog[open] .draft-body').waitFor();
  assert.match(await page.locator('#postCallReport').innerText(), /Demo lender follow-up from the older call/);
  assert.deepEqual(companionRequests.filter(row => row.path === '/api/post-call').map(row => row.session), ['demo-older-call']);
  assert.equal(companionRequests.some(row => row.method !== 'GET'), false);
  assert.deepEqual(writes, []);
  await mkdir(join(root, 'out/test-artifacts/home-call-drafts'), { recursive: true });
  await page.locator('.vendor-draft').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, `out/test-artifacts/home-call-drafts/${width}-report.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('Home keeps a draft offer when the local companion is unavailable', async t => {
  const email = { ...task('proposal-email'), session_id: 'demo-older-call', kind: 'email_draft', payload: {
    deal_id: 'qa-deal-1', recipient_party_id: 'demo-recipient', recipient_ref: 'DEMO-P-01', subject: 'Demo saved email', body_sha256: 'a'.repeat(64) } };
  const { page, writes, companionRequests } = await open(t, { candidates: [email], companion: { unavailable: true } });
  await page.getByRole('button', { name: 'Review draft', exact: true }).click();
  await page.getByText('Open Call Mode on the Mac that recorded this call to review this draft.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review draft', exact: true }).isVisible(), true);
  assert.equal(companionRequests.some(row => row.path === '/api/post-call'), false);
  assert.deepEqual(writes, []);
});


test('an unavailable saved report never falls back to the latest call', async t => {
  const email = { ...task('proposal-email'), session_id: 'demo-missing-call', kind: 'email_draft', payload: {
    deal_id: 'qa-deal-1', recipient_party_id: 'demo-recipient', recipient_ref: 'DEMO-P-01', subject: 'Demo saved email', body_sha256: 'a'.repeat(64) } };
  const { page, writes, companionRequests } = await open(t, { candidates: [email], companion: { reportUnavailable: true } });
  await page.getByRole('button', { name: 'Review draft', exact: true }).click();
  await page.locator('#callModeDialog[open]').waitFor();
  await page.locator('#postCallStatus').getByText(/could not read the companion response/).waitFor();
  assert.deepEqual(companionRequests.filter(row => row.path === '/api/post-call').map(row => row.session), ['demo-missing-call']);
  assert.equal(await page.locator('.vendor-draft').count(), 0);
  assert.deepEqual(writes, []);
});

test('Home renders useful task review before loading its decision writer', async t => {
  const { page, writes, errors, releaseCommands } = await open(t, { holdCommands: true });
  const add = page.getByRole('button', { name: 'Add Joe task', exact: true });
  await add.waitFor();
  assert.equal(await page.locator('#homeAgenda').isVisible(), true);
  await add.click();
  assert.equal(await add.getAttribute('aria-disabled'), 'true');
  await add.evaluate(button => button.click());
  assert.deepEqual(writes, []);
  releaseCommands();
  await page.getByText('Task added', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.deepEqual(errors, []);
});

test('session invalidation cancels a task decision waiting for its writer', async t => {
  const { page, writes, errors, releaseCommands } = await open(t, { holdCommands: true });
  await page.getByRole('button', { name: 'Add Joe task', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  releaseCommands();
  await page.waitForLoadState('networkidle');
  assert.deepEqual(writes, []);
  assert.equal(await page.locator('#homeCallTasks').isVisible(), false);
  assert.deepEqual(errors, []);
});
