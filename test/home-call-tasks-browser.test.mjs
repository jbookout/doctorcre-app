import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let outDir, server, browser, origin;
before(async () => {
  outDir = await temporaryDirectory('home-call-tasks-');
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

async function open(t, { width = 1280, candidates = [task('proposal-joe')], companion = null, outcomes = [], holdCommands = false, theme = 'dark', viewer = 'joe' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
  assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `call-tasks-${width}`, viewer, reset: true } })).status(), 200);
  const pending = structuredClone(candidates), actions = [], writes = [], reads = [], errors = [], gate = { hold: null };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/mcp', async route => {
    const rpc = route.request().postDataJSON();
    const { name, arguments: args } = rpc.params;
    const reply = payload => route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    if (name === 'review-call-outcome') {
      writes.push({ name, ...args });
      const index = outcomes.findIndex(call => call.session_id === args.session_id);
      assert.ok(index >= 0);
      outcomes.splice(index, 1);
      return reply({ ok: true });
    }
    if (name === 'read-call-outcomes') return reply({ schema_version: 'call-outcomes.v1', calls: outcomes, send: false });
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
  assert.match(await proposal.innerText(), /Demo coastal purchase.*Demo proposal-joe lender follow-up.*Due Oct 2.*Add Joe task/s);
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
  assert.match(await page.locator('[data-call-task="proposal-dell"]').innerText(), /No due date.*Add Dell task/s);
  assert.equal(await page.locator('[data-call-task="proposal-email"]').count(), 0);
  await page.getByRole('button', { name: 'Just me', exact: true }).click();
  assert.equal(await page.locator('[data-call-task="proposal-joe"]').count(), 1);
  assert.equal(await page.locator('[data-call-task="proposal-dell"]').count(), 0);
  await page.getByRole('button', { name: 'Team view', exact: true }).click();
  const sibling = page.locator('[data-call-task="proposal-dell"]');
  await sibling.getByText('What was said', { exact: true }).click();
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

const callOutcome = session_id => ({ session_id, call_date: '2026-09-28', recorder: 'joe', applied: [],
  open_cards: [{ candidate_id: 'proposal-email', resolver: 'resolve-post-call-candidate', kind: 'email_draft', deal_id: 'qa-deal-1' }] });

for (const width of [390, 1280]) test(`Home opens the selected call outcome report at ${width}px`, async t => {
  const { page, writes, companionRequests, errors } = await open(t, { width, candidates: [], companion: {},
    outcomes: [callOutcome('demo-latest-call'), callOutcome('demo-older-call')] });
  await page.locator('#homeCallOutcomes [data-call-session="demo-older-call"] [data-call-open-cards]').click();
  await page.locator('#callModeDialog[open] .draft-body').waitFor();
  assert.match(await page.locator('#postCallReport').innerText(), /Demo lender follow-up from the older call/);
  assert.deepEqual(companionRequests.filter(row => row.path === '/api/post-call').map(row => row.session), ['demo-older-call']);
  assert.equal(companionRequests.some(row => row.method !== 'GET'), false);
  assert.deepEqual(writes, []);
  await mkdir(join(root, 'out/test-artifacts/home-call-outcomes'), { recursive: true });
  await page.locator('.vendor-draft').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(root, `out/test-artifacts/home-call-outcomes/${width}-report.png`) });
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.locator('#homeCallOutcomes').isVisible(), false);
  assert.equal(await page.locator('#homeCallOutcomes button').count(), 0);
  assert.deepEqual(errors, []);
});

test('Home outcome handoff never substitutes the latest call for an unavailable selected report', async t => {
  const { page, writes, companionRequests } = await open(t, { candidates: [], companion: { reportUnavailable: true },
    outcomes: [callOutcome('demo-missing-call')] });
  await page.locator('#homeCallOutcomes [data-call-open-cards]').click();
  await page.locator('#callModeDialog[open]').waitFor();
  await page.locator('#postCallStatus').getByText(/could not read the companion response/).waitFor();
  assert.deepEqual(companionRequests.filter(row => row.path === '/api/post-call').map(row => row.session), ['demo-missing-call']);
  assert.equal(await page.locator('.vendor-draft').count(), 0);
  assert.deepEqual(writes, []);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`call contact and deal fit at ${width}px in ${theme}`, async t => {
  const named = { ...task('named'), contact_name: 'Pat Smith' };
  const unnamed = { ...task('unnamed'), contact_name: null };
  const { page } = await open(t, { width, theme, candidates: [named, unnamed] });
  const first = page.locator('[data-call-task="named"]');
  const second = page.locator('[data-call-task="unnamed"]');
  await first.waitFor();
  await mkdir(join(root, 'out/test-artifacts/call-contact'), { recursive: true });
  await page.locator('#homeCallTasks').screenshot({ path: join(root, `out/test-artifacts/call-contact/${width}-${theme}-${process.env.CONTACT_CAPTURE || 'after'}.png`) });
  assert.equal(await first.locator('.work-card-title').innerText(), 'Pat Smith · Demo coastal purchase');
  assert.equal(await second.locator('.work-card-title').innerText(), 'Demo coastal purchase');
  assert.equal(await first.locator('.work-card-title a').getAttribute('href'), '/deals?deal=qa-deal-1');
  assert.equal((await first.boundingBox()).height, (await second.boundingBox()).height);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Home finishes an older filed call without its companion at ${width}px in ${theme}`, async t => {
  const session = '11111111-1111-4111-8111-111111111111';
  const call = { session_id: session, call_date: '2026-09-28', recorder: 'joe', open_cards: [], applied: [
    { candidate_id: 'old-step', kind: 'next_step', deal_id: 'qa-deal-1', deal_name: 'Demo coastal purchase', deal_version: 7,
      payload: { text: 'Send the lease draft to the landlord', next_date: '2026-10-02' },
      evidence_quote: 'Send the lease draft on Friday.', undone_at: null },
    { candidate_id: 'old-note', kind: 'note', deal_id: null, deal_name: null, deal_version: 7,
      payload: { text: 'Confirm the walkthrough with Dell' }, evidence_quote: 'Confirm the walkthrough with Dell.', undone_at: null },
  ] };
  const { page, writes, companionRequests, errors } = await open(t, { width, theme, viewer: 'dell', candidates: [],
    companion: theme === 'light' ? { unavailable: true } : {},
    outcomes: [{ ...call, session_id: 'newer-call', applied: [{ ...call.applied[0], candidate_id: 'newer-step' }] }, call] });
  const entry = page.locator(`[data-call-session="${session}"]`);
  companionRequests.length = 0;
  await entry.getByRole('button', { name: 'Review call', exact: true }).click();
  const guide = page.getByRole('region', { name: 'Review this call' });
  await guide.getByRole('heading', { name: 'Demo coastal purchase', exact: true }).waitFor({ timeout: 2000 });
  assert.equal(await guide.getByRole('button', { name: 'Complete call review' }).isEnabled(), false);
  assert.deepEqual(writes, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('/tmp/wr617-s2-j3-shots', { recursive: true });
  await page.locator('.call-review-dialog').screenshot({ path: `/tmp/wr617-s2-j3-shots/${width}-${theme}-guide.png` });
  await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await page.getByRole('button', { name: 'Close call review', exact: true }).click();
  await entry.getByRole('button', { name: 'Review call', exact: true }).click();
  await guide.getByText('Confirm the walkthrough with Dell', { exact: true }).first().waitFor();
  assert.equal(await guide.getAttribute('data-review-candidate'), 'old-note');
  await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
  assert.deepEqual(writes, []);
  await guide.getByRole('button', { name: 'Complete call review' }).click();
  await page.getByText('No call items to review.', { exact: true }).waitFor();
  assert.deepEqual(writes.map(row => ({ name: row.name, session_id: row.session_id })), [{ name: 'review-call-outcome', session_id: session }]);
  await page.locator(`[data-call-session="${session}"]`).waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-call-session="newer-call"]').count(), 1);
  assert.deepEqual(companionRequests, [], 'Home review never contacts the recording Mac');
  assert.deepEqual(errors, []);
});

test('Home keeps pending call decisions outstanding without the recording Mac and clears the guide on sign-out', async t => {
  const { page, writes, errors } = await open(t, { candidates: [], companion: { unavailable: true },
    outcomes: [callOutcome('demo-older-call')] });
  const entry = page.locator('[data-call-session="demo-older-call"] [data-call-open-review]');
  await entry.click();
  const guide = page.locator('.call-review-dialog .call-review');
  await guide.getByText('Needs your decision', { exact: true }).waitFor();
  assert.equal(await guide.getByRole('button', { name: 'Complete call review' }).isEnabled(), false);
  await guide.getByRole('button', { name: 'Approve or fix this item' }).click();
  await page.getByText('Open Call Mode on the Mac that recorded the call to decide them.', { exact: true }).waitFor();
  await entry.click();
  await guide.getByText('Needs your decision', { exact: true }).waitFor();
  assert.equal(await guide.getByRole('button', { name: 'Complete call review' }).isEnabled(), false);
  assert.deepEqual(writes, []);
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.locator('.call-review-dialog').count(), 0);
  assert.deepEqual(errors, []);
});
