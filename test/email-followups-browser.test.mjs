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
    await card.scrollIntoViewIfNeeded();
    await card.locator('article').first().waitFor().catch(async error => { assert.fail(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`); });
    assert.equal(await card.locator('article').count(), 2);
    const confirmBox = await card.locator('article').first().getByRole('button', { name: 'Confirm', exact: true }).boundingBox();
    const chips = card.locator('article').first().getByRole('group', { name: 'Dismiss' }).getByRole('button');
    assert.deepEqual(await chips.allInnerTexts(), ['Already handled', 'Wrong deal', 'Not now', 'Wrong', 'Add a note']);
    const chipBox = await chips.first().boundingBox();
    assert.ok(chipBox.y - confirmBox.y - confirmBox.height >= 8, 'dismiss choices sit apart from Confirm');
    for (const box of await Promise.all((await chips.all()).map(chip => chip.boundingBox()))) assert.ok(box.height >= 44, 'dismiss choices are full touch targets');
    assert.match(await card.locator('.email-source').first().innerText(), /^Email · Demo plan follow-up · Oct 2\d$/);
    assert.match(await card.locator('.email-waiting').first().innerText(), /^(Today|Waiting \d+ business days?|Waiting since \w+)$/);
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
    await second.getByRole('button', { name: 'Not now', exact: true }).click();
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
  await card.scrollIntoViewIfNeeded();
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

for (const width of [1440, 390]) {
  test(`deal email review scopes proposals, confirms and dismisses at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `deal-email-${width}`, viewer: 'joe', reset: true } });
    const calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/mcp', route => { calls.push(route.request().postDataJSON().params); return route.continue(); });
    await page.goto(`${origin}/deals?mode=live&deal=qa-deal-1`);
    const panel = page.locator('#recordPanel'), review = page.locator('#panelEmailFollowups');
    await review.getByText('Please send the revised plan by November 3.', { exact: true }).waitFor();
    assert.equal(await review.locator('article').count(), 1);
    assert.doesNotMatch(await review.innerText(), /The tour is confirmed/);
    assert.ok(calls.some(call => call.name === 'list-email-proposals' && call.arguments.deal === 'qa-deal-1'));
    await mkdir('out/test-artifacts/deal-email-followups', { recursive: true });
    await review.screenshot({ path: `out/test-artifacts/deal-email-followups/${width}-pending.png` });
    await review.getByRole('button', { name: 'Confirm', exact: true }).click();
    await review.getByRole('button', { name: 'Confirm change', exact: true }).waitFor();
    await review.screenshot({ path: `out/test-artifacts/deal-email-followups/${width}-preview.png` });
    await review.getByRole('button', { name: 'Confirm change', exact: true }).click();
    await panel.locator('.deal-current-action strong').filter({ hasText: 'Send the revised plan' }).waitFor();
    const preview = calls.find(call => call.name === 'preview-email-next-step');
    const confirm = calls.find(call => call.name === 'confirm-email-next-step');
    assert.deepEqual(Object.fromEntries(Object.entries(confirm.arguments).filter(([key]) => !['proposal_digest', 'idempotency_key'].includes(key))), preview.arguments);
    await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#recordPanel').hidden);
    await page.locator('.kanban-column [data-id="qa-deal-2"] .card-open').click();
    await review.getByText('The tour is confirmed for November 3.', { exact: true }).waitFor();
    assert.doesNotMatch(await review.innerText(), /Please send the revised plan/);
    await review.getByRole('button', { name: 'Add a note', exact: true }).click();
    await review.getByRole('textbox', { name: 'Reason for dismissal' }).fill('Synthetic tour already handled');
    await review.getByRole('button', { name: 'Dismiss proposal', exact: true }).click();
    await review.getByText('Dismissed.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Refresh deal', exact: true }).click();
    await review.getByText('No pending email follow-ups.', { exact: true }).waitFor();
    assert.equal(calls.find(call => call.name === 'dismiss-email-proposal').arguments.reason, 'Synthetic tour already handled');
    assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.deepEqual(errors, []);
  });
}

test('deal email review distinguishes unavailable from empty and clears proposals after session loss', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'deal-email-recovery', viewer: 'joe', reset: true } });
  let fail = true;
  await page.route('**/mcp', route => {
    if (fail && route.request().postDataJSON().params.name === 'list-email-proposals') return route.fulfill({ status: 503, json: { error: 'synthetic_outage' } });
    return route.continue();
  });
  await page.goto(`${origin}/deals?mode=live&deal=qa-deal-3`);
  const review = page.locator('#panelEmailFollowups');
  await review.getByText('Could not load email follow-ups.', { exact: true }).waitFor();
  assert.equal(await review.getByText('No pending email follow-ups.', { exact: true }).count(), 0);
  fail = false;
  await review.getByRole('button', { name: 'Retry email follow-ups' }).click();
  await review.getByText('No pending email follow-ups.', { exact: true }).waitFor();
  await page.goto(`${origin}/deals?mode=live&deal=qa-deal-1`);
  await review.locator('article').waitFor();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('doctorcre-session-invalidated')));
  await page.waitForFunction(() => !document.querySelector('#panelEmailFollowups article'));
  assert.equal(await page.locator('#recordPanel').getByText('Please send the revised plan by November 3.', { exact: true }).count(), 0);
});

for (const width of [1440, 390]) test(`Home reply card edits and submits exact text at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `reply-${width}`, viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const row = { id: '10000000-0000-4000-8000-000000000003', version: 3, kind: 'reply_draft', status: 'pending',
    deal: 'qa-deal-1', deal_name: 'Demo Harbor expansion', confidence: 0.9, suspected_instruction: null,
    source: { activity_id: '30000000-0000-4000-8000-000000000003', sender: null, subject: 'Demo floor plan',
      evidence_quote: 'Please review the floor plan.', occurred_at: '2026-10-27T12:00:00Z' },
    confirm_verb: 'submit-email-draft', preview: null, preview_error: null,
    reply_draft: { subject: 'Re: Demo floor plan', body: 'Thank you for the plan.', owner: 'joe', to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] } };
  let releaseAgenda;
  const agendaGate = new Promise(resolve => { releaseAgenda = resolve; });
  const submitted = [];
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let result;
    if (name === 'read-home-agenda') { await agendaGate; return route.continue(); }
    if (name === 'list-email-proposals') result = { schema_version: 'email-proposals.v1', proposals: submitted.length ? [] : [row], send: false, more: false, next_cursor: null };
    else if (name === 'submit-email-draft') {
      submitted.push(args);
      result = { ok: true, proposal_id: row.id, status: 'approved_to_send', version: 4, subject: args.subject,
        body: args.body, sha256: 'a'.repeat(64), to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] };
    } else return route.continue();
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.scrollIntoViewIfNeeded();
  await card.getByText('Reply draft · Re: Demo floor plan · Joe', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Review reply', exact: true }).count(), 0);
  releaseAgenda();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  await card.getByText('To: demo-correspondent@example.test', { exact: true }).waitFor();
  await card.getByText('CC: demo-dell@example.test', { exact: true }).waitFor();
  await card.getByRole('textbox', { name: 'Subject', exact: true }).fill('Re: Demo plan reviewed');
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('I reviewed the plan.\nPlease send the dimensions.');
  assert.equal(submitted.length, 0);
  await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'I reviewed the plan.\nPlease send the dimensions.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/email-followups', { recursive: true });
  await card.screenshot({ path: `out/test-artifacts/email-followups/reply-${width}-edit.png`, animations: 'disabled' });
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await card.getByText('Submitted for sending. Delivery is not yet confirmed.', { exact: true }).waitFor();
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].to, ['demo-correspondent@example.test']);
  assert.deepEqual(submitted[0].cc, ['demo-dell@example.test']);
  const { idempotency_key, ...args } = submitted[0];
  assert.ok(idempotency_key);
  assert.deepEqual(args, { proposal_id: row.id, base_version: 3, subject: 'Re: Demo plan reviewed', body: 'I reviewed the plan.\nPlease send the dimensions.', to: row.reply_draft.to, cc: row.reply_draft.cc });
  await card.getByText('To: demo-correspondent@example.test', { exact: true }).waitFor();
  await card.getByText('CC: demo-dell@example.test', { exact: true }).waitFor();
  await card.screenshot({ path: `out/test-artifacts/email-followups/reply-${width}-submitted.png`, animations: 'disabled' });
});

test('Home creates a new deal and files its email through the live client at phone width', async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'filing-new-deal', viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const id = '10000000-0000-4000-8000-000000000031', activity = '30000000-0000-4000-8000-000000000031';
  const digest = `sha256:${'a'.repeat(64)}`, calls = [];
  const row = { id, version: 1, kind: 'possible_new_deal', deal: null, deal_name: null, proposed_matter: 'Possible new demo practice',
    source: { activity_id: activity, evidence_quote: 'Please discuss a new office.' }, confirm_verb: 'confirm-email-filing',
    preview: { contract: 'email-filing.v1', proposal_id: id, kind: 'possible_new_deal', deal: null, activity_id: activity,
      evidence_quote: 'Please discuss a new office.', sender_role: 'client', sender: { name: 'Demo Client', party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest } };
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params; let result;
    if (name === 'list-email-proposals') result = { schema_version: 'email-proposals.v1', proposals: [row], send: false, more: false, next_cursor: null };
    else if (name === 'new-deal') { calls.push({ name, args }); result = { deal_id: 'demo-created' }; }
    else if (name === 'get-deal-room' && args.deal === 'demo-created') result = { base_version: 1 };
    else if (name === 'set-lead' && args.deal === 'demo-created') result = { ok: true };
    else if (name === 'confirm-email-filing') { calls.push({ name, args }); result = { ok: true, status: 'confirmed', deal: args.deal, activity_id: activity }; }
    else return route.continue();
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.scrollIntoViewIfNeeded();
  await card.getByText('Possible new demo practice').waitFor();
  await card.getByRole('button', { name: 'Review filing' }).click();
  await card.getByRole('textbox', { name: 'Deal name' }).fill('Demo office');
  await card.getByRole('textbox', { name: 'Existing client (reference or exact name)' }).fill('Demo Client');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/email-followups', { recursive: true });
  await card.screenshot({ path: 'out/test-artifacts/email-followups/filing-new-deal.png', animations: 'disabled' });
  await card.getByRole('button', { name: 'Create deal and confirm filing' }).click();
  await card.getByText('Confirmed.', { exact: true }).waitFor();
  assert.equal(calls[0].name, 'new-deal'); assert.equal(calls[0].args.client, 'Demo Client');
  assert.equal(calls[1].name, 'confirm-email-filing'); assert.equal(calls[1].args.deal, 'demo-created');
  assert.equal(calls[1].args.proposal_digest, digest);
});
