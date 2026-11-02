import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { callChangeText, callOutcomesHtml, mountCallOutcomes, undoRefusal } from '../js/call-outcomes.js';

// Synthetic read-call-outcomes rows (CARR call-outcomes.v1).
const synthetic = () => [{
  session_id: 'session-1', call_date: '2026-10-26', recorder: 'joe',
  applied: [
    { candidate_id: 'phase-1', kind: 'phase_move', deal_id: 'deal-a', deal_name: 'Demo Bayside relocation', deal_version: 7,
      payload: { deal: 'deal-a', field: 'phase', value: 'negotiation', started_on: '2026-10-20', base_event_id: 'phase-base' },
      evidence_quote: 'Bayside moves to negotiation', applied_at: '2026-10-26T14:00:00Z', undone_at: null },
    { candidate_id: 'step-1', kind: 'next_step', deal_id: 'deal-b', deal_name: 'Demo Harbor expansion', deal_version: 3,
      payload: { deal: 'deal-b', text: 'Schedule the second walkthrough', next_date: '2026-11-03' },
      evidence_quote: 'schedule the second walkthrough on November 3', applied_at: '2026-10-26T14:00:00Z', undone_at: null },
  ],
  open_cards: [{ candidate_id: 'card-1', resolver: 'resolve-post-call-candidate', kind: 'email_draft', deal_id: 'deal-a' }],
}];

test('each applied change says what changed, quotes the call, and opens the guide', () => {
  assert.equal(callChangeText(synthetic()[0].applied[0]), 'Phase moved to Negotiation, started Oct 20');
  assert.equal(callChangeText(synthetic()[0].applied[1]), 'Next step: Schedule the second walkthrough · due Nov 3');
  // Phase words match the board's, not a second vocabulary.
  assert.equal(callChangeText({ kind: 'phase_move', payload: { value: 'due_diligence' } }), 'Phase moved to Diligence');
  assert.equal(callChangeText({ kind: 'phase_move', payload: { value: 'pending' } }), 'Phase moved to On Deck');
  const html = callOutcomesHtml(synthetic());
  assert.match(html, /Applied from the Oct 26 pipeline call/);
  assert.match(html, /<q>Bayside moves to negotiation<\/q>/);
  assert.doesNotMatch(html, /data-call-undo|data-call-reviewed|Looks right/);
  assert.match(html, /Review call/);
  assert.match(html, /1 item from this call still needs Joe or Dell to decide/);
});

test('Undo refusals explain the next action', () => {
  assert.match(undoRefusal({ payload: { error: 'version_conflict' } }), /deal changed/);
  assert.match(undoRefusal({ payload: { error: 'newer_change_exists' } }), /Edit it on the deal/);
  assert.match(undoRefusal({ payload: { error: 'overdue_action_changed' } }), /tasks directly/);
});

test("Home's count of undecided items opens the cards", async () => {
  const dom = new JSDOM('<section id="outcomes"></section>');
  const container = dom.window.document.getElementById('outcomes');
  const opened = [];
  const older = { ...synthetic()[0], session_id: 'older-call', call_date: '2026-10-19' };
  const view = mountCallOutcomes({ container, openReview: session => { opened.push(session); },
    client: () => ({ readCallOutcomes: async () => ({ calls: [...synthetic(), older] }) }) });
  await view.refresh();
  const link = [...container.querySelectorAll('[data-call-open-cards]')].find(button => button.textContent.startsWith('1 item'));
  assert.equal(container.querySelector('[data-call-reviewed]'), null, 'Home opens the guide before acknowledging');
  assert.equal(link.tagName, 'BUTTON');
  assert.equal(link.textContent, '1 item from this call still needs Joe or Dell to decide');
  await view.click({ target: link });
  await view.click({ target: container.querySelector('[data-call-session="older-call"] [data-call-open-cards]') });
  assert.deepEqual(opened, ['session-1', 'older-call']);
});

test('a failed read says it could not check; a signed-out read stays quiet', async () => {
  const dom = new JSDOM('<section id="outcomes" hidden></section>');
  const container = dom.window.document.getElementById('outcomes');
  let fail = Object.assign(new Error('offline'), { status: 503 });
  const view = mountCallOutcomes({ container, client: () => ({
    readCallOutcomes: async () => { if (fail) throw fail; return { calls: synthetic() }; },
  }) });
  await view.refresh();
  assert.equal(container.hidden, false);
  assert.match(container.textContent, /Couldn't check for changes from the pipeline call\./);
  fail = null;
  await view.click({ target: container.querySelector('[data-call-recheck]') });
  assert.match(container.innerHTML, /Applied from the Oct 26 pipeline call/);
  fail = Object.assign(new Error('signed out'), { status: 401 });
  await view.refresh();
  assert.equal(container.hidden, true);
});

test('retiring an outcome list clears its controls and ignores late reads and detached clicks', async () => {
  const dom = new JSDOM('<section id="outcomes"></section>');
  const container = dom.window.document.getElementById('outcomes');
  let release, writes = 0;
  const client = {
    readCallOutcomes: async () => ({ calls: synthetic() }),
    undoCallChange: async () => { writes++; },
  };
  const view = mountCallOutcomes({ container, client: () => client });
  await view.refresh();
  const stale = container.querySelector('[data-call-open-review]');
  assert.ok(stale);
  client.readCallOutcomes = () => new Promise(resolve => { release = resolve; });
  const pending = view.refresh();
  view.dispose();
  assert.equal(container.innerHTML, '');
  assert.equal(container.hidden, true);
  release({ calls: synthetic() });
  await pending;
  await view.click({ target: stale });
  assert.equal(container.innerHTML, '');
  assert.equal(writes, 0);
  dom.window.close();
});

test('the call guide orders deals, preserves the outstanding item and acknowledges only after review', async () => {
  const server = await fixtureServer(), browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.guideWrites = [];
      window.guideRows = rows;
      window.guide = mountCallReview(node, { filter: () => ['step-1'], client: () => ({
        readCallOutcomes: async () => ({ calls: window.guideRows }),
        getDeal: async () => ({ history: [{ id: 'phase-base', new_value: 'Prospecting' }] }),
        undoCallChange: async args => { window.guideWrites.push(args); throw Object.assign(new Error('stale'), { payload: { error: 'version_conflict' } }); },
        reviewCallOutcome: async args => { window.guideWrites.push(args); window.guideRows = []; return { ok: true }; },
      }), describe: change => change.payload.text || 'Phase moved to Negotiation', undoRefusal: () => 'Deal changed. Check it again.', openCandidate: () => {} });
      await window.guide.refresh();
    }, synthetic());
    const guide = page.getByRole('region', { name: 'Review this call' });
    await guide.getByRole('heading', { name: 'Demo Bayside relocation' }).waitFor();
    await guide.getByText('Prospecting', { exact: true }).waitFor();
    assert.equal(await guide.getByRole('button', { name: 'Complete call review' }).isEnabled(), false);
    await guide.getByRole('button', { name: 'Undo', exact: true }).click();
    await guide.getByRole('alert').filter({ hasText: 'Deal changed' }).waitFor();
    assert.equal(await guide.getByText(/Item 1 of 3$/).count(), 1);
    await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await guide.getByText('Needs your decision', { exact: true }).waitFor();
    await guide.getByRole('button', { name: 'Next', exact: true }).click();
    await guide.getByRole('heading', { name: 'Demo Harbor expansion' }).waitFor();
    await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.evaluate(() => window.guide.refresh());
    await guide.getByText('Needs your decision', { exact: true }).waitFor();
    assert.equal(await guide.getByRole('button', { name: 'Complete call review' }).isEnabled(), false);
    await page.evaluate(async () => { window.guideRows[0].open_cards = []; await window.guide.refresh(); });
    await page.evaluate(() => window.guideRows[0].open_cards.push({ candidate_id: 'late-card', kind: 'assigned_action', deal_id: 'deal-a' }));
    await guide.getByRole('button', { name: 'Complete call review' }).click();
    await guide.getByRole('alert').filter({ hasText: 'Could not complete' }).waitFor();
    assert.equal(await page.evaluate(() => window.guideWrites.length), 1, 'a stale guide sends no call acknowledgement');
    await page.evaluate(async () => { window.guideRows[0].open_cards = []; await window.guide.refresh(); });
    await guide.getByRole('button', { name: 'Complete call review' }).click();
    await page.getByText('Call review complete.', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.guideWrites), [
      { candidate_id: 'phase-1', base_version: 7 }, { session_id: 'session-1' },
    ]);
  } finally { await page.close(); await browser.close(); await server.close(); }
});

test('the guide distinguishes loading, empty, unavailable and sign-out, and fences late reads', async () => {
  const server = await fixtureServer(), browser = await chromium.launch({ headless: true }), page = await browser.newPage();
  try {
    await page.goto(server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.rows = rows; window.failGuide = false;
      window.guide = mountCallReview(node, { filter: () => ['phase-1'], client: () => ({
        readCallOutcomes: () => window.holdGuide ? new Promise(resolve => { window.releaseGuide = () => resolve({ calls: window.rows }); })
          : window.failGuide ? Promise.reject(new Error('offline')) : Promise.resolve({ calls: window.rows }),
      }), describe: () => 'Phase moved', undoRefusal: () => 'Refused', openCandidate: () => {} });
    }, synthetic());
    await page.getByText('Loading call review…', { exact: true }).waitFor();
    await page.evaluate(() => window.guide.refresh());
    await page.getByRole('heading', { name: 'Demo Bayside relocation' }).waitFor();
    await page.evaluate(async () => { window.failGuide = true; await window.guide.refresh(); });
    await page.getByRole('alert').filter({ hasText: 'Could not check this call' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reviewed', exact: true }).count(), 0);
    await page.evaluate(async () => { window.failGuide = false; window.rows = []; await window.guide.refresh(); });
    await page.getByText('No call items to review.', { exact: true }).waitFor();
    await page.evaluate(() => { window.holdGuide = true; void window.guide.refresh(); });
    await page.evaluate(() => { window.dispatchEvent(new Event('doctorcre-session-invalidated')); window.releaseGuide(); });
    await page.getByText('Sign in again to review this call.', { exact: true }).waitFor();
    await page.evaluate(() => window.guide.refresh());
    assert.equal(await page.getByRole('heading', { name: 'Demo Bayside relocation' }).count(), 0);
  } finally { await page.close(); await browser.close(); await server.close(); }
});

test('Undo refusal refreshes the version, preserves the notice and selection, and allows a safe retry', async () => {
  const server = await fixtureServer(), browser = await chromium.launch({ headless: true }), page = await browser.newPage();
  try {
    await page.goto(server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.undoWrites = [];
      window.guide = mountCallReview(node, { filter: () => ['step-1'], client: () => ({
        readCallOutcomes: async () => ({ calls: structuredClone(rows) }),
        undoCallChange: async args => {
          window.undoWrites.push(args);
          rows[0].applied[1].deal_version = 8;
          if (args.base_version !== 8) throw Object.assign(new Error('stale'), { payload: { error: 'version_conflict' } });
          rows[0].applied[1].undone_at = '2026-10-26T15:00:00Z';
          return { ok: true };
        },
      }), describe: change => change.payload.text || 'Phase moved', undoRefusal: () => 'Deal changed. Check it again.', openCandidate: () => {} });
      await window.guide.refresh();
    }, synthetic());
    const guide = page.getByRole('region', { name: 'Review this call' });
    await guide.getByRole('button', { name: 'Next', exact: true }).click();
    await guide.getByRole('button', { name: 'Next', exact: true }).click();
    await guide.getByRole('button', { name: 'Undo', exact: true }).click();
    await guide.getByRole('alert').filter({ hasText: 'Deal changed' }).waitFor();
    assert.equal(await guide.getAttribute('data-review-candidate'), 'step-1');
    await guide.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.waitForFunction(() => window.undoWrites.length === 2);
    await guide.getByText('Undone', { exact: true }).waitFor();
    await page.evaluate(() => window.guide.refresh());
    assert.equal(await guide.getAttribute('data-review-candidate'), 'step-1');
    assert.deepEqual(await page.evaluate(() => window.undoWrites.map(row => row.base_version)), [3, 8]);
  } finally { await page.close(); await browser.close(); await server.close(); }
});

for (const width of [390, 1440]) test(`guide follow-ups at ${width}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.goto(server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      rows[0].open_cards[0].deal_id = null;
      window.guideWrites = [];
      window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
        readCallOutcomes: async () => ({ calls: structuredClone(rows) }),
        undoCallChange: async args => { window.guideWrites.push(args); rows[0].applied[1].undone_at = '2026-10-26'; return { ok: true }; },
        resolvePostCallCandidate: async args => { window.guideWrites.push(args); rows[0].open_cards = []; return { ok: true }; },
        reviewCallOutcome: async args => { window.guideWrites.push(args); rows.length = 0; return { ok: true }; },
      }), describe: change => change.payload.text || 'Phase moved', undoRefusal: () => 'Refused', openCandidate: () => { window.companionOpened = true; } });
      await window.guide.refresh();
    }, synthetic());
    await mkdir('/tmp/wr617-s2-j8-shots', { recursive: true });
    await page.screenshot({ path: `/tmp/wr617-s2-j8-shots/guide-${width}-${process.env.GUIDE_SHOT_PHASE || 'after'}.png`, fullPage: true });
    assert.equal(await page.getByText('Deal 1 of 2', { exact: true }).count(), 1, 'unlinked items are excluded from the deal count');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('Undone', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-review-candidate]').getAttribute('data-review-candidate'), 'step-1', 'Undo stays on the current item');
    assert.equal(await page.getByRole('button', { name: 'Reviewed', exact: true }).isEnabled(), true, 'the changed item must be reviewed again');
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('button', { name: 'Approve or fix this item' }).click();
    assert.equal(await page.evaluate(() => Boolean(window.companionOpened)), false, 'saved-call decisions do not depend on the companion current call');
    await page.getByRole('button', { name: 'Approve item', exact: true }).click();
    await page.getByText('No longer pending', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Complete call review' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Complete call review' }).click();
    await page.getByRole('status').filter({ hasText: 'Call review complete.' }).waitFor();
    const writes = await page.evaluate(() => window.guideWrites);
    assert.equal(writes[1].candidate_id, 'card-1');
    assert.equal(writes[1].accept, true);
    assert.deepEqual(writes[2], { session_id: 'session-1' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); await browser.close(); await server.close(); }
});

test('older call decisions stay in the saved guide', async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await page.goto(server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.openedCompanion = false;
      const guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({ readCallOutcomes: async () => ({ calls: rows }) }), describe: () => 'Draft proposal', undoRefusal: () => '', openCandidate: () => { window.openedCompanion = true; } });
      await guide.refresh();
    }, synthetic());
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Approve or fix this item' }).click();
    assert.equal(await page.evaluate(() => window.openedCompanion), false);
    assert.equal(await page.getByRole('button', { name: 'Approve item', exact: true }).count(), 1);
  } finally { await page.close(); await browser.close(); await server.close(); }
});

for (const resolver of ['resolve-post-call-candidate', 'resolve-candidate']) for (const accept of [true, false]) test(`saved guide ${accept ? 'approves' : 'skips'} ${resolver}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await page.goto(server.origin);
    await page.evaluate(async ({ rows, resolver }) => {
      const { mountCallReview } = await import('/js/ui.generated.js');
      rows[0].applied = [];
      rows[0].open_cards[0].resolver = resolver;
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.decisions = [];
      let refused = true;
      const decide = async args => { window.decisions.push(args); if (refused) { refused = false; throw new Error('offline'); } rows[0].open_cards = []; return { ok: true }; };
      window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
        readCallOutcomes: async () => ({ calls: structuredClone(rows) }), resolvePostCallCandidate: decide, resolveConfirm: decide,
      }), describe: () => 'Proposal', undoRefusal: () => '' });
      await window.guide.refresh();
    }, { rows: synthetic(), resolver });
    await page.getByRole('button', { name: 'Approve or fix this item' }).click();
    const button = page.getByRole('button', { name: accept ? 'Approve item' : 'Skip item', exact: true });
    await button.click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Complete call review' }).isEnabled(), false);
    assert.equal(await page.evaluate(() => window.decisions.length), 1, 'refusals never auto-retry');
    await button.click();
    await page.getByText('No longer pending', { exact: true }).waitFor();
    const writes = await page.evaluate(() => window.decisions);
    assert.equal(writes[1][resolver === 'resolve-candidate' ? 'proposal_id' : 'candidate_id'], 'card-1');
    assert.equal(writes[1].accept, accept);
    assert.equal(typeof writes[1].idempotency_key, 'string');
  } finally { await page.close(); await browser.close(); await server.close(); }
});

test('Undo leaves an earlier reviewed change on the same deal reviewed', async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await page.goto(server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui.generated.js');
      rows[0].applied[1].deal_id = rows[0].applied[0].deal_id;
      const node = document.createElement('section'); document.body.replaceChildren(node);
      const guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
        readCallOutcomes: async () => ({ calls: structuredClone(rows) }),
        undoCallChange: async () => {
          rows[0].applied[1].undone_at = '2026-10-26';
          rows[0].applied.forEach(change => change.deal_version = 8);
          return { ok: true };
        },
      }), describe: () => 'Change', undoRefusal: () => 'Refused' });
      await guide.refresh();
    }, synthetic());
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('Undone', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-review-candidate]').getAttribute('data-review-candidate'), 'step-1');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Reviewed', exact: true }).isEnabled(), false, 'a version-only change must not unmark the earlier item');
  } finally { await page.close(); await browser.close(); await server.close(); }
});
