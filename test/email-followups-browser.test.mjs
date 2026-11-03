import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium, settles } from './browser-harness.mjs';

let outDir, server, browser, origin;
before(async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  outDir = await temporaryDirectory('email-followups-');
  await buildArtifact({ root, outDir });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`Home email review confirms and defers at ${width}px in ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `email-${width}-${theme}`, viewer: 'joe', reset: true } })).status(), 200);
    await page.goto(`${origin}/?mode=fixture`);
    const card = page.locator('#homeEmailFollowups');
    await card.scrollIntoViewIfNeeded();
    await card.locator('article').first().waitFor().catch(async error => { assert.fail(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`); });
    assert.equal(await card.locator('article').count(), width === 390 ? 1 : 2);
    if (width === 390) await card.getByRole('button', { name: 'Show 1 more', exact: true }).click();
    const defer = card.locator('article').first().getByRole('button', { name: 'Not now', exact: true });
    assert.ok((await defer.boundingBox()).height >= 44, 'actions are full touch targets');
    assert.equal(await card.getByRole('button', { name: 'Wrong deal', exact: true }).count(), 0);
    assert.match(await card.locator('.email-source').first().innerText(), /Dana Demo · Oct 26, .* CDT · \d+ days waiting/);
    const first = card.locator('article').first();
    await first.getByRole('button', { name: 'Confirm', exact: true }).click();
    await first.getByRole('button', { name: 'Confirm change', exact: true }).waitFor();
    await card.screenshot({ path: `out/test-artifacts/email-followups/${width}-${theme}-preview.png`, animations: 'disabled' });
    await first.getByRole('button', { name: 'Confirm change', exact: true }).click();
    await first.getByText('Confirmed.', { exact: true }).waitFor();
    const second = card.locator('article').last();
    await second.getByRole('button', { name: 'Not now', exact: true }).click();
    await second.getByRole('button', { name: 'Defer follow-up', exact: true }).click();
    await card.getByText(/Returns .*America\/Chicago/).waitFor();
    await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
    await card.getByText('No email follow-ups.', { exact: true }).waitFor();
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
  assert.equal(await card.getByText('No email follow-ups.', { exact: true }).count(), 0);
  fail = false; await card.getByRole('button', { name: 'Retry email follow-ups' }).click();
  await card.locator('article').first().waitFor();
  fail = true; await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
  await card.getByText(/Showing the last successful read/).waitFor();
  assert.equal(await card.locator('article').count(), 1);
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
    await review.getByText('Review source email', { exact: true }).click();
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
    await review.getByText('Review source email', { exact: true }).click();
    await review.getByText('The tour is confirmed for November 3.', { exact: true }).waitFor();
    assert.doesNotMatch(await review.innerText(), /Please send the revised plan/);
    await review.getByRole('button', { name: 'Not now', exact: true }).click();
    await review.getByLabel('Optional note').fill('Synthetic tour later');
    await review.getByRole('button', { name: 'Defer follow-up', exact: true }).click();
    await review.getByText(/Returns .*America\/Chicago/).first().waitFor();
    await panel.getByRole('button', { name: 'Refresh deal', exact: true }).click();
    await review.getByText('No email follow-ups.', { exact: true }).waitFor();
    assert.equal(calls.find(call => call.name === 'snooze-email-proposal').arguments.note, 'Synthetic tour later');
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
  assert.equal(await review.getByText('No email follow-ups.', { exact: true }).count(), 0);
  fail = false;
  await review.getByRole('button', { name: 'Retry email follow-ups' }).click();
  await review.getByText('No email follow-ups.', { exact: true }).waitFor();
  await page.goto(`${origin}/deals?mode=live&deal=qa-deal-1`);
  await review.locator('article').waitFor();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('doctorcre-session-invalidated')));
  await page.waitForFunction(() => !document.querySelector('#panelEmailFollowups article'));
  assert.equal(await page.locator('#recordPanel').getByText('Please send the revised plan by November 3.', { exact: true }).count(), 0);
});

for (const width of [1440, 390]) test(`Home mixed deal and contact reply cards edit and submit exact text at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `reply-${width}`, viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const row = { id: '10000000-0000-4000-8000-000000000003', version: 3, kind: 'reply_draft', status: 'pending',
    deal: null, deal_name: null, confidence: 0.9, suspected_instruction: null,
    source: { activity_id: '30000000-0000-4000-8000-000000000003', sender: 'Dana Demo', subject: 'Demo floor plan',
      evidence_quote: 'Please review the floor plan.', occurred_at: '2026-10-27T12:00:00Z' },
    confirm_verb: 'submit-email-draft', preview: null, preview_error: null,
    reply_draft: { subject: 'Re: Demo floor plan', body: 'Thank you for the plan.', owner: 'joe', to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] } };
  const dealDraft = { ...row, id: '10000000-0000-4000-8000-000000000004', deal: 'qa-deal-1', deal_name: 'Demo Harbor expansion',
    source: { ...row.source, subject: 'Demo deal floor plan' } };
  let releaseAgenda;
  const agendaGate = new Promise(resolve => { releaseAgenda = resolve; });
  const submitted = [];
  let reloadGate = Promise.resolve(), holdReload = false;
  const heldReads = new Set();
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let result;
    if (holdReload && ['read-home-agenda', 'list-email-proposals'].includes(name)) {
      heldReads.add(name);
      await reloadGate;
    }
    if (name === 'read-home-agenda') { await agendaGate; return route.continue(); }
    if (name === 'list-email-proposals') result = { schema_version: 'email-proposals.v1', proposals: submitted.length ? [dealDraft] : [dealDraft, row], send: false, more: false, next_cursor: null };
    else if (name === 'submit-email-draft') {
      submitted.push(args);
      result = { ok: true, proposal_id: row.id, status: 'approved_to_send', version: 4, subject: args.subject,
        body: args.body, sha256: 'a'.repeat(64), to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] };
    } else return route.continue();
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await page.clock.install();
  await page.goto(`${origin}/?mode=live`);
  const panel = page.locator('#homeEmailFollowups');
  await panel.scrollIntoViewIfNeeded();
  if (width === 390) await panel.getByRole('button', { name: 'Show 1 more', exact: true }).click();
  const card = panel.locator(`[data-email-id="${row.id}"]`);
  await card.waitFor();
  assert.equal(await panel.locator('article').count(), 2);
  await panel.getByRole('link', { name: 'Demo Harbor expansion', exact: true }).waitFor();
  await card.getByText('Contact · Dana Demo', { exact: true }).waitFor();
  assert.equal(await card.locator('a[href^="/deals"]').count(), 0);
  await mkdir('out/test-artifacts/email-followups', { recursive: true });
  await panel.screenshot({ path: `out/test-artifacts/email-followups/mixed-replies-${width}-pending.png`, animations: 'disabled' });
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
  await panel.screenshot({ path: `out/test-artifacts/email-followups/reply-${width}-edit.png`, animations: 'disabled' });
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await card.getByText('Sending in 10s ·').waitFor();
  let releaseReload;
  reloadGate = new Promise(resolve => { releaseReload = resolve; });
  holdReload = true;
  const readiness = card.getByRole('button', { name: 'Review reply', exact: true });
  try {
    await page.reload();
    await settles(() => assert.deepEqual([...heldReads].sort(), ['list-email-proposals', 'read-home-agenda'], 'both post-reload reads must reach the response gate'));
    assert.equal(await readiness.count(), 0);
  } finally {
    holdReload = false;
    releaseReload();
  }
  if (width === 390) await panel.getByRole('button', { name: 'Show 1 more', exact: true }).click();
  await readiness.waitFor({ state: 'visible' });
  await card.locator('button[data-email-action="edit-draft"]:enabled').waitFor();
  await page.clock.runFor(30_000);
  assert.equal(submitted.length, 0, 'leaving the page during the grace sends nothing');
  assert.equal(await card.getByText(/Sending in/).count(), 0, 'send intent never survives a reload');
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Subject', exact: true }).inputValue(), 'Re: Demo plan reviewed');
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'I reviewed the plan.\nPlease send the dimensions.', 'a reload restores text without restoring send authorization');
  await card.getByRole('textbox', { name: 'Subject', exact: true }).fill('Re: Demo plan reviewed');
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('I reviewed the plan.\nPlease send the dimensions.');
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await card.getByText('Sending in 10s ·').waitFor();
  await page.clock.runFor(9_000);
  await card.getByText('Sending in 1s ·').waitFor();
  await panel.screenshot({ path: `out/test-artifacts/email-followups/reply-${width}-grace.png`, animations: 'disabled' });
  await card.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.clock.runFor(30_000);
  assert.equal(submitted.length, 0, 'Undo during the grace reaches no server');
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'I reviewed the plan.\nPlease send the dimensions.');
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.clock.runFor(10_000);
  await card.getByText('Submitted for sending. Delivery is not yet confirmed.', { exact: true }).waitFor();
  await page.clock.runFor(30_000);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].to, ['demo-correspondent@example.test']);
  assert.deepEqual(submitted[0].cc, ['demo-dell@example.test']);
  const { idempotency_key, ...args } = submitted[0];
  assert.ok(idempotency_key);
  assert.deepEqual(args, { proposal_id: row.id, base_version: 3, subject: 'Re: Demo plan reviewed', body: 'I reviewed the plan.\nPlease send the dimensions.', to: row.reply_draft.to, cc: row.reply_draft.cc });
  await card.getByText('To: demo-correspondent@example.test', { exact: true }).waitFor();
  await card.getByText('CC: demo-dell@example.test', { exact: true }).waitFor();
  await panel.screenshot({ path: `out/test-artifacts/email-followups/reply-${width}-submitted.png`, animations: 'disabled' });
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
    else if (name === 'preview-email-filing') { calls.push({ name, args }); result = { ...row.preview, contract: 'email-followups.v2', base_version: 1, deal: args.deal }; }
    else if (name === 'confirm-email-filing') { calls.push({ name, args }); result = { ok: true, proposal_id: id, version: 2, disposition: args.disposition, note: args.note, status: 'confirmed', deal: args.deal, activity_id: activity }; }
    else return route.continue();
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.scrollIntoViewIfNeeded();
  await card.getByText('Possible new demo practice').waitFor();
  await card.getByRole('button', { name: 'New deal', exact: true }).click();
  await card.getByRole('textbox', { name: 'Deal name' }).fill('Demo office');
  await card.getByRole('textbox', { name: 'Existing client reference or exact name' }).fill('Demo Client');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/email-followups', { recursive: true });
  await card.screenshot({ path: 'out/test-artifacts/email-followups/filing-new-deal.png', animations: 'disabled' });
  await card.getByRole('button', { name: 'Create deal and review filing', exact: true }).click();
  await card.getByRole('button', { name: 'Confirm filing', exact: true }).click();
  await card.getByText('Filed to the selected deal.', { exact: true }).first().waitFor();
  assert.equal(calls[0].name, 'new-deal'); assert.equal(calls[0].args.client, 'Demo Client');
  assert.equal(calls[1].name, 'preview-email-filing');
  assert.equal(calls[2].name, 'confirm-email-filing'); assert.equal(calls[2].args.deal, 'demo-created');
  assert.equal(calls[2].args.proposal_digest, digest);
});

test('Home loads email follow-ups even outside the viewport', async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'quality-after-paint', viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  let reviewDownloads = 0;
  await page.route('**/js/email-followups.js', async route => { reviewDownloads++; await route.continue(); });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('#dealFlags .home-flag').first().waitFor();
  assert.equal(reviewDownloads, 1, 'email follow-ups load with Home without scrolling');
  await page.locator('#homeEmailFollowups article').first().waitFor();
  assert.equal(await page.locator('#homeEmailFollowups').evaluate(node => node.getBoundingClientRect().top >= innerHeight), true);
});

test('session loss during the email command download prevents a late confirmation', async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'email-command-session', viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const writes = [];
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    if (name === 'confirm-email-next-step') writes.push(name);
    return route.continue();
  });
  await page.route('**/js/email-proposal-command.js', async route => {
    await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
    await route.continue();
  });
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.locator('article').first().getByRole('button', { name: 'Confirm', exact: true }).click();
  await card.getByRole('button', { name: 'Confirm change', exact: true }).click();
  await card.getByText('Sign in to review email follow-ups.', { exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  assert.deepEqual(writes, []);
  assert.equal(await card.locator('article').count(), 0);
});

test('a failed command download after leaving keeps the cancelled reply draft editable', async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'reply-import-failure', viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const row = { id: '10000000-0000-4000-8000-000000000004', version: 3, kind: 'reply_draft', status: 'pending',
    deal: 'qa-deal-1', deal_name: 'Demo Harbor expansion', confidence: 0.9, suspected_instruction: null,
    source: { activity_id: '30000000-0000-4000-8000-000000000004', sender: null, subject: 'Demo floor plan',
      evidence_quote: 'Please review the floor plan.', occurred_at: '2026-10-27T12:00:00Z' },
    confirm_verb: 'submit-email-draft', preview: null, preview_error: null,
    reply_draft: { subject: 'Re: Demo floor plan', body: 'Thank you for the plan.', owner: 'joe', to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] } };
  const submitted = [];
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (name === 'submit-email-draft') submitted.push(args);
    if (name !== 'list-email-proposals') return route.continue();
    const result = { schema_version: 'email-proposals.v1', proposals: [row], send: false, more: false, next_cursor: null };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  let held, requested;
  const download = new Promise(resolve => { requested = resolve; });
  await page.route('**/js/email-proposal-command.js', route => { held = route; requested(); });
  await page.clock.install();
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  const message = card.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Not yet sent.');
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.clock.runFor(10_000);
  await download;
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  assert.equal(await message.inputValue(), 'Not yet sent.');
  await held.abort('failed');
  await page.clock.runFor(1_000);
  assert.equal(await message.count(), 1, 'the cancelled draft stays editable');
  assert.equal(await message.inputValue(), 'Not yet sent.');
  assert.equal(await card.getByText(/Outcome unknown/).count(), 0);
  assert.deepEqual(submitted, []);
});

for (const [subject_type,width] of [['client',1440],['lead',390],['vendor',390]]) {
  test(`Home confirms a non-deal ${subject_type} at ${width}px through the live adapter`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `non-deal-${subject_type}`, viewer: 'joe', reset: true } });
    await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
    const source = { activity_id: '30000000-0000-4000-8000-000000000099', evidence_quote: 'Please send the revised plan by November 3.',
      sender: 'Dana Demo', subject: 'Demo contact follow-up', occurred_at: '2026-10-26T12:00:00Z' };
    const preview = { contract: 'email-next-step.v1', status: 'proposed', deal: null, deal_name: null,
      subject_type, subject_id: '40000000-0000-4000-8000-000000000099', subject_name: 'Demo contact',
      text: 'Send the revised plan', next_date: '2026-11-03', owner: 'joe', current_next_step: 'Call Dana Demo',
      current_next_date: '2026-11-01', source, evidence_quote: source.evidence_quote,
      proposal_digest: `sha256:${'a'.repeat(64)}`, requires_confirmation: true };
    const row = { id: '10000000-0000-4000-8000-000000000099', version: 1, kind: 'next_step', deal: null, deal_name: null,
      subject_type, subject_id: preview.subject_id, subject_name: preview.subject_name, source, preview,
      confirm_verb: 'confirm-email-next-step', preview_error: null, confidence: 0.9, suspected_instruction: null };
    const writes = [];
    await page.route('**/mcp', async route => {
      const rpc = route.request().postDataJSON(), { name, arguments: args } = rpc.params;
      let result;
      if (name === 'list-email-proposals' && !args.mode) {
        assert.equal(args.include_non_deal, true);
        result = { schema_version: 'email-proposals.v1', proposals: [row], send: false, more: false, next_cursor: null };
      } else if (name === 'preview-email-next-step') result = preview;
      else if (name === 'confirm-email-next-step') { writes.push(args); result = { ...preview, status: 'confirmed', requires_confirmation: false }; }
      else return route.continue();
      return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
    });
    await page.goto(`${origin}/?mode=live`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const card = page.locator('#homeEmailFollowups');
    await card.getByText('Demo contact follow-up', { exact: true }).waitFor();
    assert.match(await card.innerText(), new RegExp(`${subject_type[0].toUpperCase()+subject_type.slice(1)} · Demo contact`));
    await card.getByRole('button', { name: 'Confirm', exact: true }).click();
    await card.getByText(`Joe confirms this change to the ${subject_type}.`, { exact: true }).waitFor();
    await card.screenshot({ path: `out/test-artifacts/email-followups/non-deal-${subject_type}-${width}.png`, animations: 'disabled' });
    await card.getByRole('button', { name: 'Confirm change', exact: true }).click();
    await card.getByText('Confirmed.', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].deal, null);
    assert.equal(writes[0].activity_id, source.activity_id);
    assert.equal(writes[0].proposal_digest, preview.proposal_digest);
  });
}

test('Home saved reply survives send Undo and submits once after grace', async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'reply-save-grace', viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  const row = { id: '10000000-0000-4000-8000-000000000003', version: 3, kind: 'reply_draft', status: 'pending',
    deal: 'qa-deal-1', deal_name: 'Demo Harbor expansion', confidence: 0.9, suspected_instruction: null,
    source: { activity_id: '30000000-0000-4000-8000-000000000003', sender: null, subject: 'Demo floor plan',
      evidence_quote: 'Please review the floor plan.', occurred_at: '2026-10-27T12:00:00Z' },
    confirm_verb: 'submit-email-draft', preview: null, preview_error: null,
    reply_draft: { subject: 'Re: Demo floor plan', body: 'Thank you for the plan.', owner: 'joe', to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] } };
  const submitted = [];
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let result;
    if (name === 'edit-email-draft') {
      row.version++; row.reply_draft = { ...row.reply_draft, subject: args.subject, body: args.body };
      result = { ok: true, proposal_id: row.id, version: row.version, subject: args.subject, body: args.body };
    } else if (name === 'list-email-proposals') result = { schema_version: 'email-proposals.v1', proposals: submitted.length ? [] : [row], send: false, more: false, next_cursor: null };
    else if (name === 'submit-email-draft') {
      submitted.push(args);
      result = { ok: true, proposal_id: row.id, status: 'approved_to_send', version: 5, subject: args.subject,
        body: args.body, sha256: 'a'.repeat(64), to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] };
    } else return route.continue();
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await page.clock.install();
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.scrollIntoViewIfNeeded();
  await card.getByText('Reply draft · Re: Demo floor plan · Joe', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  await card.getByText('To: demo-correspondent@example.test', { exact: true }).waitFor();
  await card.getByText('CC: demo-dell@example.test', { exact: true }).waitFor();
  await card.getByRole('textbox', { name: 'Subject', exact: true }).fill('Re: Demo plan reviewed');
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('I reviewed the plan.\nPlease send the dimensions.');
  assert.equal(submitted.length, 0);
  await card.getByRole('button', { name: 'Save draft', exact: true }).click();
  await card.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(submitted.length, 0);
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await card.getByText('Sending in 10s ·').waitFor();
  await page.clock.runFor(9_000);
  await card.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.clock.runFor(30_000);
  assert.equal(submitted.length, 0, 'Undo during the grace reaches no server');
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'I reviewed the plan.\nPlease send the dimensions.');
  assert.equal(await card.getByRole('textbox', { name: 'Subject', exact: true }).inputValue(), 'Re: Demo plan reviewed');
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.clock.runFor(10_000);
  await card.getByText('Submitted for sending. Delivery is not yet confirmed.', { exact: true }).waitFor();
  await page.clock.runFor(30_000);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].to, ['demo-correspondent@example.test']);
  assert.deepEqual(submitted[0].cc, ['demo-dell@example.test']);
  const { idempotency_key, ...args } = submitted[0];
  assert.ok(idempotency_key);
  assert.deepEqual(args, { proposal_id: row.id, base_version: 4, subject: 'Re: Demo plan reviewed', body: 'I reviewed the plan.\nPlease send the dimensions.', to: row.reply_draft.to, cc: row.reply_draft.cc });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`Home exact-target file and durable deferral ${width} ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.clock.install({ time: new Date('2026-10-31T18:00:00Z') });
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `home-file-defer-${width}-${theme}`, viewer: 'joe', reset: true } });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    const source = { activity_id: '30000000-0000-4000-8000-000000000010', subject: 'Demo lease follow-up', sender: 'Dana Demo', evidence_quote: 'Please review the lease.', occurred_at: '2026-10-30T12:00:00Z' };
    const digest = `sha256:${'a'.repeat(64)}`;
    const row = { id: '10000000-0000-4000-8000-000000000010', kind: 'possible_new_deal', version: 1, deal: null, deal_name: null,
      source, confirm_verb: 'confirm-email-filing', suggested_deals: [{ deal: 'qa-deal-1', name: 'Demo Harbor expansion', reasons: ['Existing client transaction'] }],
      email_summary: { status: 'available', text: 'Dana asks for a review of the lease.' },
      preview: { contract: 'email-filing.v1', proposal_id: '10000000-0000-4000-8000-000000000010', kind: 'possible_new_deal', deal: null, activity_id: source.activity_id, evidence_quote: source.evidence_quote, sender: {}, new_people: [], requires_confirmation: true, proposal_digest: digest } };
    const calls = []; let until = null, filed = false, stale = false, lose = true, loseFiling = true;
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      let result;
      if (name === 'list-email-proposals' && !args.mode && !args.status) result = { schema_version: 'email-proposals.v1', proposals: filed || until && Date.parse('2026-10-31T18:00:00Z') < Date.parse(until) ? [] : [row], send: false, more: false, next_cursor: null };
      else if (name === 'preview-email-filing') { calls.push({ name, args }); result = args.deal === 'created-demo' && !args.correction_reason ? { error: 'email_new_deal_client_mismatch' } : { ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: row.version }; }
      else if (name === 'confirm-email-filing') {
        calls.push({ name, args });
        if (stale) result = { error: 'version_conflict' };
        else {
          if (loseFiling) { loseFiling = false; await route.abort('failed'); return; }
          filed = true; result = { ok: true, proposal_id: row.id, status: 'confirmed', version: row.version + 1, disposition: args.disposition, note: args.note, deal: args.deal, activity_id: source.activity_id }; }
      } else if (name === 'snooze-email-proposal') {
        calls.push({ name, args }); until = args.deferred_until;
        if (lose) { lose = false; await route.abort('failed'); return; }
        row.version = 2;
        result = { ok: true, proposal_id: row.id, status: 'pending', version: 2, disposition: 'deferred', deferred_until: until, note: args.note };
      } else if (name === 'new-deal') { calls.push({ name, args }); result = { deal_id: 'created-demo' }; }
      else if (name === 'get-deal-room' && args.deal === 'created-demo') result = { deal_id: 'created-demo', base_version: 1 };
      else if (name === 'set-lead' && args.deal === 'created-demo') result = { ok: true };
      else return route.continue();
      await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
    });
    await page.goto(`${origin}/?mode=live`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const panel = page.locator('#homeEmailFollowups');
    await panel.getByText('Dana asks for a review of the lease.', { exact: true }).waitFor();
    assert.equal(await panel.locator('q:visible').count(), 0);
    await panel.getByText('Review source email', { exact: true }).click();
    await panel.getByText('Please review the lease.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Already handled', exact: true }).click();
    await panel.getByRole('button', { name: 'Review selected deal', exact: true }).click();
    await panel.getByText('Choose the deal before continuing.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.getByRole('button', { name: 'Not now', exact: true }).click();
    assert.equal(await panel.getByLabel('Return time in America/Chicago').inputValue(), '2026-11-01T09:00');
    assert.equal(await panel.getByLabel('Return time in America/Chicago').evaluate(node => node === document.activeElement), true);
    await panel.getByLabel('Optional note').fill('Review tomorrow');
    await panel.screenshot({ path: `out/test-artifacts/email-followups/file-defer-${width}-${theme}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.getByRole('button', { name: 'Defer follow-up', exact: true }).click();
    await panel.getByRole('button', { name: 'Check outcome', exact: true }).click();
    await panel.getByText('No email follow-ups.', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /Returns .*America\/Chicago/);
    const snoozes = calls.filter(call => call.name === 'snooze-email-proposal');
    assert.equal(snoozes.length, 2); assert.deepEqual(snoozes[0], snoozes[1]);
    assert.equal(until, '2026-11-01T15:00:00.000Z');
    await page.reload(); await panel.getByText('No email follow-ups.', { exact: true }).waitFor();
    until = '2026-10-30T15:00:00.000Z';
    row.suggested_deals = []; row.source.subject = 'Demo lease follow-up with a long recorded subject '.repeat(8);
    await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
    await panel.getByRole('button', { name: 'File to existing deal', exact: true }).click();
    await panel.getByLabel('Selected deal', { exact: true }).selectOption('qa-deal-1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.getByLabel('Optional note').fill('Lease reviewed');
    await panel.getByRole('button', { name: 'Review selected deal', exact: true }).click();
    await panel.getByRole('button', { name: 'Confirm filing', exact: true }).waitFor();
    assert.equal(calls.filter(call => call.name === 'confirm-email-filing').length, 0);
    await panel.getByRole('button', { name: 'Confirm filing', exact: true }).focus();
    assert.equal(await panel.getByRole('button', { name: 'Confirm filing', exact: true }).evaluate(node => node === document.activeElement), true);
    stale = true;
    await panel.getByRole('button', { name: 'Confirm filing', exact: true }).click();
    await panel.getByText(/Action refused \(version_conflict\)/).waitFor();
    await panel.getByRole('button', { name: 'Refresh and review', exact: true }).click();
    await panel.getByRole('button', { name: 'File to existing deal', exact: true }).click();
    await panel.getByLabel('Selected deal', { exact: true }).selectOption('qa-deal-1');
    await panel.getByLabel('Optional note').fill('Lease reviewed');
    await panel.getByRole('button', { name: 'Review selected deal', exact: true }).click();
    stale = false;
    await panel.getByRole('button', { name: 'Confirm filing', exact: true }).click();
    await panel.getByRole('button', { name: 'Check outcome', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: `out/test-artifacts/email-followups/filing-recovery-${width}-${theme}.png` });
    await panel.getByRole('button', { name: 'Check outcome', exact: true }).click();
    await panel.getByText('No email follow-ups.', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /Filed to the selected deal/);
    const confirmed = calls.filter(call => call.name === 'confirm-email-filing').at(-1).args;
    assert.equal(confirmed.deal, 'qa-deal-1'); assert.equal(confirmed.note, 'Lease reviewed'); assert.equal(confirmed.proposal_digest, digest);
    assert.equal(calls.filter(call => call.name === 'new-deal').length, 0);
    filed = false; row.version++;
    await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
    await panel.getByRole('button', { name: 'New deal', exact: true }).click();
    await panel.getByLabel('Deal name', { exact: true }).fill('Separate demo transaction');
    await panel.getByLabel('Existing client reference or exact name').fill('Different demo client');
    await panel.getByRole('button', { name: 'Create deal and review filing', exact: true }).click();
    await panel.getByRole('link', { name: 'Open created deal' }).waitFor();
    await panel.getByLabel('Reason for changing the client or filed deal, if needed').fill('Separate transaction for this client');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: `out/test-artifacts/email-followups/created-correction-${width}-${theme}.png` });
    await panel.getByRole('button', { name: 'Review created deal', exact: true }).click();
    await panel.getByRole('button', { name: 'Confirm filing', exact: true }).click();
    await panel.getByText('No email follow-ups.', { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.name === 'new-deal').length, 1);
    const corrected = calls.filter(call => call.name === 'confirm-email-filing').at(-1).args;
    assert.equal(corrected.deal, 'created-demo'); assert.equal(corrected.correction_reason, 'Separate transaction for this client');

  });
}
