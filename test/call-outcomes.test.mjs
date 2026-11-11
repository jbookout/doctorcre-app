import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { JSDOM } from 'jsdom';
import { componentDocument, chromium, settles } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { callChangeText, callOutcomesHtml, mountCallOutcomes, undoRefusal } from '../js/call-outcomes.js';

async function callDocument(page, origin) {
  return componentDocument(page, origin, { dispose: page => page.evaluate(() => {
    window.guide?.dispose();
    window.companion?.dispose();
    window.sourceTasks?.dispose();
    window.reviewDialog?.dispose();
  }) });
}

async function closeCallFixture(page, browser, server) {
  try { await page.close(); }
  finally { try { await browser.close(); } finally { await server.close(); } }
}

const readerSchema = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/read-call-outcomes.v1.json', import.meta.url)));
const readerValid = new Ajv2020({ strict: false, formats: { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i } }).compile(readerSchema);

// Synthetic read-call-outcomes rows (CARR call-outcomes.v1).
const synthetic = () => [{
  session_id: 'session-1', started_at: '2026-10-26T14:00:00Z', source_version: 'a'.repeat(32), call_date: '2026-10-26', recorder: 'joe',
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
    await callDocument(page, server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
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
      { candidate_id: 'phase-1', base_version: 7 }, { session_id: 'session-1', expected_source_version: 'a'.repeat(32) },
    ]);
  } finally { await closeCallFixture(page, browser, server); }
});

test('the guide distinguishes loading, empty, unavailable and sign-out, and fences late reads', async () => {
  const server = await fixtureServer(), browser = await chromium.launch({ headless: true }), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
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
  } finally { await closeCallFixture(page, browser, server); }
});

test('Undo refusal refreshes the version, preserves the notice and selection, and allows a safe retry', async () => {
  const server = await fixtureServer(), browser = await chromium.launch({ headless: true }), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
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
  } finally { await closeCallFixture(page, browser, server); }
});

for (const width of [390, 1440]) test(`guide follow-ups at ${width}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await callDocument(page, server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      rows[0].open_cards[0].deal_id = null;
      window.guideWrites = [];
      window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
        readCallOutcomes: async () => ({ calls: structuredClone(rows) }),
        undoCallChange: async args => { window.guideWrites.push(args); rows[0].applied[1].undone_at = '2026-10-26'; return { ok: true }; },
        resolvePostCallCandidate: async args => { window.guideWrites.push(args); rows[0].open_cards = []; rows[0].source_version = 'b'.repeat(32); return { ok: true }; },
        reviewCallOutcome: async args => { window.guideWrites.push(args); rows.length = 0; return { ok: true }; },
      }), describe: change => change.payload.text || 'Phase moved', undoRefusal: () => 'Refused', openCandidate: () => { window.companionOpened = true; } });
      await window.guide.refresh();
    }, synthetic());
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
    assert.equal(await page.getByRole('button', { name: 'Complete call review' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Complete call review' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Complete call review' }).click();
    await page.getByRole('status').filter({ hasText: 'Call review complete.' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Back to Home', exact: true }).count(), 0);
    const writes = await page.evaluate(() => window.guideWrites);
    assert.equal(writes[1].candidate_id, 'card-1');
    assert.equal(writes[1].accept, true);
    assert.deepEqual(writes[2], { session_id: 'session-1', expected_source_version: 'b'.repeat(32) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await closeCallFixture(page, browser, server); }
});

test('older call decisions stay in the saved guide', async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.openedCompanion = false;
      const guide = window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({ readCallOutcomes: async () => ({ calls: rows }) }), describe: () => 'Draft proposal', undoRefusal: () => '', openCandidate: () => { window.openedCompanion = true; } });
      await guide.refresh();
    }, synthetic());
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Approve or fix this item' }).click();
    assert.equal(await page.evaluate(() => window.openedCompanion), false);
    assert.equal(await page.getByRole('button', { name: 'Approve item', exact: true }).count(), 1);
  } finally { await closeCallFixture(page, browser, server); }
});

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const resolver of ['resolve-post-call-candidate', 'resolve-candidate']) for (const accept of [true, false]) test(`saved guide ${accept ? 'approves' : 'skips'} ${resolver} at ${width} ${theme}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
  try {
    await callDocument(page, server.origin);
    await page.evaluate(async ({ rows, resolver }) => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      rows[0].applied = [];
      rows[0].open_cards[0].resolver = resolver;
      rows[0].open_cards[0].payload = { assignee: 'joe', due_on: '2026-10-05', subject: 'Send revised proposal' };
      const { dayLabel } = await import('/js/call-change-words.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.decisions = [];
      let refused = true;
      const decide = async args => { window.decisions.push(args); if (refused) { refused = false; throw new Error('offline'); } rows[0].open_cards = []; rows[0].source_version = 'b'.repeat(32); return { ok: true }; };
      window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
        readCallOutcomes: async () => ({ calls: structuredClone(rows) }), resolvePostCallCandidate: decide, resolveConfirm: decide,
      }), describe: () => 'Proposal', dateLabel: dayLabel, undoRefusal: () => '' });
      await window.guide.refresh();
    }, { rows: synthetic(), resolver });
    await page.getByRole('button', { name: 'Approve or fix this item' }).click();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByText('Assigned to Joe · Oct 5', { exact: true }).waitFor();
    if (accept && resolver === 'resolve-post-call-candidate') {
      await mkdir('out/test-artifacts/call-guide-followups', { recursive: true });
      await page.screenshot({ path: `out/test-artifacts/call-guide-followups/guide-decide-${width}-${theme}.png`, fullPage: true });
    }
    const button = page.getByRole('button', { name: accept ? 'Approve item' : 'Skip item', exact: true });
    await button.click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alert').innerText(), 'The decision outcome is unknown. Check outcome before making another decision.');
    if (resolver === 'resolve-post-call-candidate' && process.env.UI_SCREENSHOT_DIR) {
      await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/refusal-${accept ? 'approve' : 'skip'}-${width}-${theme}.png`, fullPage: true });
    }
    assert.equal(await page.getByRole('button', { name: 'Complete call review' }).isEnabled(), false);
    assert.equal(await page.evaluate(() => window.decisions.length), 1, 'unknown outcomes never auto-retry');
    assert.equal(await button.isEnabled(), false, 'the original choice stays blocked while its outcome is unknown');
    assert.equal(await page.getByRole('button', { name: accept ? 'Skip item' : 'Approve item', exact: true }).isEnabled(), false, 'the opposite choice stays blocked while the outcome is unknown');
    const original = await page.evaluate(() => structuredClone(window.decisions[0]));
    await page.getByRole('button', { name: 'Check outcome', exact: true }).click();
    await page.getByText('No longer pending', { exact: true }).waitFor();
    const writes = await page.evaluate(() => window.decisions);
    assert.equal(writes.length, 2, 'one explicit check replays exactly once');
    assert.deepEqual(writes[0], original, 'the held original request is unchanged');
    assert.deepEqual(writes[1], original, 'Check outcome reuses the exact original request');
    assert.equal(writes[1][resolver === 'resolve-candidate' ? 'proposal_id' : 'candidate_id'], 'card-1');
    assert.equal(writes[1].accept, accept);
    assert.equal(typeof writes[1].idempotency_key, 'string');
  } finally { await closeCallFixture(page, browser, server); }
});

test('Undo leaves an earlier reviewed change on the same deal reviewed', async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      rows[0].applied[1].deal_id = rows[0].applied[0].deal_id;
      const node = document.createElement('section'); document.body.replaceChildren(node);
      const guide = window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
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
  } finally { await closeCallFixture(page, browser, server); }
});

test('nine filed-call decisions at two seconds each stay within the human request budget', async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.clock.install();
    await page.evaluate(async () => {
      const { mountCallReview, mountCallReviewDialog } = await import('/js/ui-call.generated.js');
      const rows = [{ session_id: 'budget-call', source_version: 'a'.repeat(32), call_date: '2026-11-02', applied: Array.from({ length: 5 }, (_, i) => ({
        candidate_id: `applied-${i}`, kind: 'next_step', deal_id: `deal-${i}`, deal_name: `Synthetic deal ${i}`,
        deal_version: 1, undone_at: null, payload: { text: `Initial step ${i}` },
      })), open_cards: Array.from({ length: 9 }, (_, i) => ({
        candidate_id: `candidate-${i}`, resolver: 'resolve-post-call-candidate', kind: 'assigned_action',
        deal_id: `deal-${i % 5}`, deal_name: `Synthetic deal ${i % 5}`, payload: { action: `Task ${i}` },
      })) }];
      window.requests = [];
      const count = (verb, id) => {
        window.requests.push({ verb, id });
        if (window.requests.length > 60) throw Object.assign(new Error('budget exceeded'), { status: 429 });
      };
      const client = {
        readCallOutcomes: async () => { count('outcomes'); return { calls: structuredClone(rows) }; },
        getDeal: async id => { count('deal', id); return { history: [] }; },
        resolvePostCallCandidate: async args => { count('decision'); rows[0].open_cards = rows[0].open_cards.filter(row => row.candidate_id !== args.candidate_id); rows[0].source_version = rows[0].open_cards.length.toString(16).padStart(32, 'b'); return { ok: true }; },
        reviewCallOutcome: async () => { count('complete'); rows.length = 0; return { ok: true }; },
      };
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.companion = mountCallReview(node, { sessionId: 'budget-call', client: () => client, describe: () => 'Task', undoRefusal: () => '' });
      await window.companion.refresh();
      const dialog = window.reviewDialog = mountCallReviewDialog(document, { client: () => client, describe: () => 'Task', undoRefusal: () => '',
        onChange: () => { void client.readCallOutcomes(); void window.companion.refresh(); } });
      await dialog.open('budget-call');
    });
    const guide = page.locator('.call-review-dialog .call-review');
    const perStep = [];
    for (let i = 0; i < 9; i++) {
      while (await guide.getByRole('button', { name: 'Reviewed', exact: true }).count() && await guide.getByRole('button', { name: 'Reviewed', exact: true }).isEnabled()) {
        await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
      }
      await page.clock.runFor(2000);
      const before = await page.evaluate(() => window.requests.length);
      const candidate = await guide.getAttribute('data-review-candidate');
      await guide.getByRole('button', { name: 'Approve or fix this item' }).click();
      await guide.getByRole('button', { name: 'Skip item', exact: true }).click();
      await guide.getByText('No longer pending', { exact: true }).waitFor();
      const step = await page.evaluate(start => window.requests.slice(start), before);
      perStep.push(step.length);
      const dealReads = step.filter(row => row.verb === 'deal');
      assert.equal(dealReads.length, 1, 'a decision rereads only its touched deal');
      assert.ok(dealReads.every(row => row.id === `deal-${Number(candidate.split('-')[1]) % 5}`));
      assert.equal(step.filter(row => row.verb === 'outcomes').length, 2);
      assert.equal(await guide.getByText(/Could not check this call/).count(), 0);
      if (i < 8) await guide.getByRole('button', { name: 'Next', exact: true }).click();
    }
    while (await guide.getByRole('button', { name: 'Back', exact: true }).isEnabled()) {
      await guide.getByRole('button', { name: 'Back', exact: true }).click();
    }
    while (await guide.getByRole('button', { name: 'Reviewed', exact: true }).count() && await guide.getByRole('button', { name: 'Reviewed', exact: true }).isEnabled()) {
      await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
    }
    await guide.getByRole('button', { name: 'Complete call review' }).click();
    await guide.getByText('Call review complete.', { exact: true }).waitFor();
    const requests = await page.evaluate(() => window.requests);
    assert.ok(requests.length <= 60);
    console.log(JSON.stringify({ budgetWalkthrough: { requests: requests.length, dealReads: requests.filter(row => row.verb === 'deal').length, perStep } }));
  } finally { await closeCallFixture(page, browser, server); }
});

for (const target of ['outcomes', 'deal', 'decision']) test(`guide recovers automatically from a ${target} 429 without replaying a decision`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.clock.install();
    await page.evaluate(async ({ rows, target }) => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      rows[0].applied = [];
      const node = document.createElement('section'); document.body.replaceChildren(node);
      let refused = false;
      window.decisionAttempts = 0;
      const check = name => { if (name === target && !refused) { refused = true; throw Object.assign(new Error('budget exceeded'), { status: 429 }); } };
      window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
        readCallOutcomes: async () => { check('outcomes'); return { calls: structuredClone(rows) }; },
        getDeal: async () => { check('deal'); return { history: [] }; },
        resolvePostCallCandidate: async () => { window.decisionAttempts++; check('decision'); rows[0].open_cards = []; rows[0].source_version = 'b'.repeat(32); return { ok: true }; },
      }), describe: () => 'Task', undoRefusal: () => '' });
      await window.guide.refresh();
    }, { rows: synthetic(), target });
    if (target === 'decision') {
      await page.getByRole('button', { name: 'Approve or fix this item' }).click();
      await page.getByRole('button', { name: 'Skip item', exact: true }).click();
    }
    await page.getByText('Trying again automatically in 60 seconds.', { exact: true }).waitFor();
    assert.equal(await page.getByText(/Could not check this call/).count(), 0);
    const announcement = await page.getByRole('status').ariaSnapshot();
    await page.clock.runFor(1000);
    assert.equal(await page.getByRole('status').ariaSnapshot(), announcement, 'countdown ticks must not change the live announcement');
    assert.match(await page.getByText(/automatically in 59 seconds/).innerText(), /59 seconds/);
    await page.clock.runFor(58000);
    const decision = page.getByRole('button', { name: 'Approve or fix this item' });
    if (target === 'decision') assert.equal(await decision.isDisabled(), true);
    else assert.equal(await decision.count(), 0);
    await page.clock.runFor(1000);
    await page.getByRole('button', { name: 'Approve or fix this item' }).waitFor();
    assert.equal(await page.evaluate(() => window.decisionAttempts), target === 'decision' ? 1 : 0);
    if (target === 'decision') {
      assert.equal(await page.getByRole('button', { name: 'Skip item', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Check outcome', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Approve or fix this item' }).click();
      await page.getByRole('button', { name: 'Skip item', exact: true }).click();
    }
    await page.getByText('No longer pending', { exact: true }).waitFor();
  } finally { await closeCallFixture(page, browser, server); }
});

test('guide refreshes share one read at a time and coalesce repeated refresh requests', async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    const counts = await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      const first = document.createElement('section'), second = document.createElement('section');
      document.body.replaceChildren(first, second);
      let release, calls = 0, reading = 0, peak = 0;
      const client = { readCallOutcomes: async () => {
        calls++; reading++; peak = Math.max(peak, reading);
        if (calls === 1) await new Promise(resolve => { release = resolve; });
        reading--; return { calls: rows };
      } };
      const options = { sessionId: 'session-1', client: () => client, describe: () => 'Task', undoRefusal: () => '' };
      const a = mountCallReview(first, options), b = mountCallReview(second, options);
      const pending = [a.refresh(), a.refresh(), b.refresh()];
      await Promise.resolve(); await Promise.resolve();
      release();
      await Promise.all(pending);
      a.dispose(); b.dispose();
      return { calls, peak };
    }, synthetic());
    assert.deepEqual(counts, { calls: 2, peak: 1 });
  } finally { await closeCallFixture(page, browser, server); }
});

test('persistent budget refusals pause after three automatic attempts and allow a later manual retry', async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.clock.install();
    await page.evaluate(async rows => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.budgetReads = 0; window.budgetRefused = true;
      window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({ readCallOutcomes: async () => {
        window.budgetReads++;
        if (window.budgetRefused) throw Object.assign(new Error('budget'), { status: 429 });
        return { calls: rows };
      } }), describe: () => 'Change', undoRefusal: () => '' });
      await window.guide.refresh();
    }, synthetic());
    for (let attempt = 0; attempt < 3; attempt++) await page.clock.runFor(60_000);
    await page.getByRole('status').filter({ hasText: 'The call review is still busy.' }).waitFor();
    await page.clock.runFor(120_000);
    assert.equal(await page.evaluate(() => window.budgetReads), 4);
    await page.evaluate(() => { window.budgetRefused = false; });
    await page.getByRole('button', { name: 'Refresh call review' }).click();
    await page.getByRole('heading', { name: 'Demo Bayside relocation' }).waitFor();
  } finally { await closeCallFixture(page, browser, server); }
});

for (const end of ['dispose', 'sign out']) test(`${end} cancels an automatic budget retry`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await page.clock.install();
    await page.evaluate(async end => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      const node = document.createElement('section'); document.body.replaceChildren(node);
      window.budgetReads = 0;
      const guide = window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({ readCallOutcomes: async () => {
        window.budgetReads++; throw Object.assign(new Error('budget'), { status: 429 });
      } }), describe: () => '', undoRefusal: () => '' });
      await guide.refresh();
      if (end === 'dispose') guide.dispose();
      else window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    }, end);
    await page.clock.runFor(120_000);
    assert.equal(await page.evaluate(() => window.budgetReads), 1);
  } finally { await closeCallFixture(page, browser, server); }
});

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const accept of [true, false]) test(`unconfirmed decision stays visible with a countdown at ${width} ${theme} ${accept}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
  try {
    await callDocument(page, server.origin);
    await page.clock.install();
    await page.evaluate(async ({ rows, theme }) => {
      const { mountCallReview } = await import('/js/ui-call.generated.js');
      rows[0].applied = [];
      Object.assign(rows[0].open_cards[0], { deal_name: 'Demo Bayside relocation', evidence_quote: 'Send the revised proposal.', payload: { subject: 'Send revised proposal' } });
      const node = document.createElement('section'); document.body.replaceChildren(node);
      document.documentElement.dataset.theme = theme;
      window.decisionAttempts = 0; window.decisionRequests = [];
      window.guide = mountCallReview(node, { sessionId: 'session-1', client: () => ({
        readCallOutcomes: async () => ({ calls: structuredClone(rows) }),
        resolvePostCallCandidate: async args => {
          window.decisionRequests.push(structuredClone(args));
          if (++window.decisionAttempts === 1) throw Object.assign(new Error('budget'), { status: 429 });
          rows[0].open_cards = []; rows[0].source_version = 'b'.repeat(32); return { ok: true };
        },
      }), describe: () => 'Proposal', undoRefusal: () => '' });
      await window.guide.refresh();
    }, { rows: synthetic(), theme });
    await page.getByRole('button', { name: 'Approve or fix this item' }).click();
    const button = page.getByRole('button', { name: accept ? 'Approve item' : 'Skip item', exact: true });
    await button.click();
    assert.match(await page.locator('.call-review').innerText(), /The decision outcome is unknown. Check outcome before making another decision./);
    assert.equal(await page.getByRole('heading', { name: 'Demo Bayside relocation' }).isVisible(), true);
    assert.equal(await page.getByText('Needs your decision', { exact: true }).isVisible(), true);
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Complete call review' }).isDisabled(), true);
    const disabledColors = await page.locator('.call-review button.primary:disabled').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button);
      const token = document.createElement('span'); token.style.background = 'var(--surface-2)'; button.after(token);
      const mutedBackground = getComputedStyle(token).backgroundColor; token.remove();
      return { background: style.backgroundColor, mutedBackground, cursor: style.cursor };
    }));
    assert.ok(disabledColors.length >= 2);
    for (const colors of disabledColors) {
      assert.equal(colors.background, colors.mutedBackground, 'disabled primary buttons use the neutral surface');
      assert.equal(colors.cursor, 'not-allowed');
    }
    await page.getByText('Trying again automatically in 60 seconds.', { exact: true }).waitFor();
    if (accept) {
      const directory = process.env.UI_SCREENSHOT_DIR || 'out/test-artifacts/call-guide-refused';
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/waiting-${width}-${theme}.png`, fullPage: true });
    }
    const announcement = await page.getByRole('status').ariaSnapshot();
    await page.clock.runFor(1000);
    assert.equal(await page.getByRole('status').ariaSnapshot(), announcement, 'countdown ticks must not change the live announcement');
    assert.match(await page.getByText(/automatically in 59 seconds/).innerText(), /59 seconds/);
    await page.clock.runFor(58000);
    assert.match(await page.getByText('Trying again automatically in 1 second.', { exact: true }).innerText(), /automatically in 1 second\./);
    assert.equal(await page.evaluate(() => window.decisionAttempts), 1);
    await page.clock.runFor(1000);
    assert.equal(await button.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: accept ? 'Skip item' : 'Approve item', exact: true }).isDisabled(), true);
    assert.match(await page.locator('.call-review').innerText(), /The decision outcome is unknown. Check outcome before making another decision./);
    assert.equal(await page.evaluate(() => window.decisionAttempts), 1, 'only reads retry automatically');
    await page.getByRole('button', { name: 'Check outcome', exact: true }).click();
    await page.getByText('No longer pending', { exact: true }).waitFor();
    assert.equal(await page.getByText(/outcome is unknown/).count(), 0);
    const requests = await page.evaluate(() => window.decisionRequests);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(await page.evaluate(() => window.decisionAttempts), 2);
  } finally { await closeCallFixture(page, browser, server); }
});

const actionSnapshot = (description = 'Send revised proposal', owner = 'dell', due_on = '2026-11-03') => ({
  id: description, source: 'next_action', description, owner, due_on, status: 'open',
});
const exactComparison = () => ({
  schema_version: 'post-call-action-comparison.v2', status: 'exact_match',
  exact_match: actionSnapshot(), related_open_tasks: [], related_open_task_total: null,
  date_effect: { current_due_on: '2026-11-03', proposed_due_on: '2026-11-05', resulting_due_on: '2026-11-05', changes_due_on: true, reason: 'stated_date' },
});
const relatedComparison = () => ({
  schema_version: 'post-call-action-comparison.v2', status: 'related_open_tasks', exact_match: null, date_effect: null,
  related_open_tasks: Array.from({ length: 5 }, (_, i) => actionSnapshot(`Recorded task ${5 - i}`, i % 2 ? 'joe' : 'dell', null)),
  related_open_task_total: 8,
});
async function mountComparison(page, { comparison, kind = 'assigned_action', failRead = false, failDeal = false, theme = 'light' } = {}) {
  await page.evaluate(async ({ comparison, kind, failRead, failDeal, theme }) => {
    const { mountCallReview } = await import('/js/ui-call.generated.js');
    const node = document.createElement('section'); document.body.replaceChildren(node);
    document.documentElement.dataset.theme = theme;
    window.comparisonWrites = [];
    const rows = [{ session_id: 'comparison-call', call_date: '2026-11-02', applied: [], open_cards: [{
      candidate_id: 'assigned-1', resolver: 'resolve-post-call-candidate', kind, deal_id: 'demo-deal', deal_name: 'Demo Bayside relocation',
      payload: { action: 'Send revised proposal', assignee: 'dell', due_on: '2026-11-05' },
      evidence_quote: 'Send the revised proposal by November 5.', existing_action_comparison: comparison,
    }] }];
    window.guide = mountCallReview(node, { sessionId: 'comparison-call', client: () => ({
      readCallOutcomes: async () => { if (failRead) throw new Error('offline'); return { calls: rows }; },
      getDeal: async () => { if (failDeal) throw new Error('offline'); return { history: [] }; },
      resolvePostCallCandidate: async args => { window.comparisonWrites.push(args); rows[0].open_cards = []; rows[0].source_version = 'b'.repeat(32); return { ok: true }; },
    }), describe: () => 'Send revised proposal', dateLabel: value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), undoRefusal: () => '' });
    await window.guide.refresh();
  }, { comparison, kind, failRead, failDeal, theme });
}

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`Before shows the server exact action, owner and date at ${width} ${theme}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
  try {
    await callDocument(page, server.origin);
    await mountComparison(page, { comparison: exactComparison(), theme });
    const before = page.locator('dl > div').filter({ has: page.getByText('Before', { exact: true }) });
    const content = await before.innerText();
    assert.equal(content, "Before\nAlready on this deal\nSend revised proposal · Dell · Nov 3\nAccepting adds this call's notes to that task.\nDue date changes from Nov 3 to Nov 5");
    const dates = await before.locator('time').evaluateAll(nodes => nodes.map(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      return { text: node.textContent, lines: range.getClientRects().length };
    }));
    assert.deepEqual(dates, [{ text: 'Nov 3', lines: 1 }, { text: 'Nov 3', lines: 1 }, { text: 'Nov 5', lines: 1 }]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const directory = process.env.UI_SCREENSHOT_DIR || 'out/test-artifacts/call-before';
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/exact-${width}-${theme}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Approve or fix this item' }).click();
    await page.getByRole('button', { name: 'Approve item', exact: true }).click();
    await page.getByText('No longer pending', { exact: true }).waitFor();
    const writes = await page.evaluate(() => window.comparisonWrites);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].candidate_id, 'assigned-1');
    assert.equal(writes[0].accept, true);
    assert.match(writes[0].idempotency_key, /^[a-f\d-]{36}$/);
  } finally { await closeCallFixture(page, browser, server); }
});

const unchangedComparison = due => ({ ...exactComparison(), exact_match: actionSnapshot('Send revised proposal', 'joe', due),
  date_effect: { current_due_on: due, proposed_due_on: null, resulting_due_on: due, changes_due_on: false, reason: 'unstated_date' } });
for (const scenario of [
  { name: 'other open tasks in server order with server remainder', comparison: relatedComparison(), expected: /Other open tasks on this deal[\s\S]*Recorded task 5[\s\S]*Dell[\s\S]*No due date[\s\S]*Recorded task 4[\s\S]*Joe[\s\S]*Recorded task 1[\s\S]*and 3 more/ },
  { name: 'all related tasks shown', comparison: { ...relatedComparison(), related_open_task_total: 5 }, expected: /Other open tasks on this deal/, listCount: 5 },
  { name: 'no other open tasks', comparison: { ...relatedComparison(), status: 'no_match', related_open_tasks: [], related_open_task_total: 0 }, expected: /No other open tasks on this deal/ },
  { name: 'missing comparison', expected: /Comparison unavailable/ },
  { name: 'unknown comparison version', comparison: { ...exactComparison(), schema_version: 'post-call-action-comparison.v1' }, expected: /Comparison unavailable/ },
  { name: 'unknown comparison status', comparison: { ...exactComparison(), status: 'possible_match' }, expected: /Comparison unavailable/ },
  { name: 'missing server count', comparison: { ...relatedComparison(), related_open_task_total: undefined }, expected: /Comparison unavailable/ },
  { name: 'noninteger server count', comparison: { ...relatedComparison(), related_open_task_total: 5.5 }, expected: /Comparison unavailable/ },
  { name: 'unknown assignee', comparison: { ...exactComparison(), status: 'assignee_unavailable' }, expected: /Comparison unavailable: task owner not recognised/ },
  { name: 'unchanged due date', comparison: unchangedComparison('2026-11-03'), expectedText: "Already on this deal\nSend revised proposal · Joe · Nov 3\nAccepting adds this call's notes to that task.\nDue date stays Nov 3" },
  { name: 'no due date', comparison: unchangedComparison(null), expectedText: "Already on this deal\nSend revised proposal · Joe · No due date\nAccepting adds this call's notes to that task.\nNo due date" },
  { name: 'date set on undated task', comparison: { ...exactComparison(), exact_match: actionSnapshot('Send revised proposal', 'dell', null), date_effect: { ...exactComparison().date_effect, current_due_on: null } }, expectedText: "Already on this deal\nSend revised proposal · Dell · No due date\nAccepting adds this call's notes to that task.\nDue date set to Nov 5" },
  { name: 'email draft proposal', kind: 'email_draft', expectedText: 'New email draft proposed' },
  { name: 'meeting summary proposal', kind: 'meeting_record', expectedText: 'New note proposed' },
  { name: 'new deal proposal', kind: 'new_deal', expectedText: 'New deal proposed' },
  { name: 'note proposal', kind: 'activity', expected: /New note proposed/ },
  { name: 'failed deal read preserves authoritative comparison', comparison: exactComparison(), failDeal: true, expected: /Already on this deal/ },
  { name: 'failed outcomes read', failRead: true, expectedText: 'Could not check this call. Refresh before continuing the review.' },
]) test(`Before handles ${scenario.name}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch(), page = await browser.newPage();
  try {
    await callDocument(page, server.origin);
    await mountComparison(page, scenario);
    const before = scenario.failRead ? page.getByRole('alert') : page.locator('dl > div').first().locator('dd');
    const content = await before.innerText();
    if (scenario.expectedText) assert.equal(content, scenario.expectedText);
    else assert.match(content, scenario.expected);
    if (scenario.kind) assert.doesNotMatch(content, /Comparison unavailable/);
    if (scenario.listCount) {
      assert.equal(await before.getByRole('listitem').count(), scenario.listCount);
      assert.doesNotMatch(content, /and \d+ more/);
    }
    assert.doesNotMatch(content, /Not yet added|possible duplicate|similar|New task/);
    if (scenario.failRead) assert.equal(await page.getByRole('button', { name: 'Approve or fix this item' }).count(), 0);
    else assert.equal(await page.getByRole('button', { name: 'Approve or fix this item' }).isEnabled(), true);
  } finally { await closeCallFixture(page, browser, server); }
});


test('same-day call reviews have distinct recorded Chicago times', () => {
  const call = synthetic()[0];
  const dom = new JSDOM(callOutcomesHtml([
    { ...call, started_at: '2026-10-26T14:00:00Z' },
    { ...call, session_id: 'session-2', started_at: '2026-10-26T20:00:00Z' },
  ]));
  const titles = [...dom.window.document.querySelectorAll('h4')].map(node => node.textContent);
  assert.notEqual(titles[0], titles[1]);
  assert.match(titles[0], /9:00 AM CDT/);
  assert.match(titles[1], /3:00 PM CDT/);
  dom.window.close();
});


test('identical start times still distinguish separate call reviews', () => {
  const call = { ...synthetic()[0], started_at: '2026-10-26T14:00:00Z' };
  const dom = new JSDOM(callOutcomesHtml([call, { ...call, session_id: 'second-session' }]));
  const titles = [...dom.window.document.querySelectorAll('h4')].map(node => node.textContent);
  assert.notEqual(titles[0], titles[1]);
  dom.window.close();
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark'])
test(`Home source calls at ${width} in ${theme}`, async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
  try {
    await page.clock.install({ time: new Date('2026-11-02T14:00:00Z') });
    await callDocument(page, server.origin);
    await page.evaluate(async ({ calls, theme }) => {
      document.documentElement.dataset.theme = theme;
      const { callOutcomesHtml } = await import('/js/call-outcomes.js');
      const { mountHomeCallTasks, readHomeCallFollowups } = await import('/js/home-call-tasks.js');
      const area = document.createElement('main');
      area.style.cssText = 'max-width:960px;margin:24px auto;padding:16px';
      area.innerHTML = `<h1>Home</h1><div>${callOutcomesHtml(calls)}</div><section id="source-tasks"></section>`;
      document.body.replaceChildren(area);
      const rows = calls.map((call, index) => ({
        id: `demo-card-${index}`, session_id: call.session_id, kind: 'assigned_action',
        source_call_started_at: call.started_at, source_call_label_key: call.session_id,
        deal_id: 'demo-deal', deal_name: 'Demo Bayside relocation', contact_name: 'Alex Example',
        created_at: '2026-10-31T14:00:00Z', evidence_quote: 'Joe will schedule the walkthrough.',
        payload: { deal_id: 'demo-deal', assignee: 'joe', action: 'Schedule the walkthrough', due_on: '2026-11-04' },
      }));
      const tasks = await readHomeCallFollowups({ getPostCallFollowups: async () => ({ schema_version: 'post-call-followups.v1', send: false, candidates: rows }) });
      window.sourceTasks = mountHomeCallTasks({ document, host: document.getElementById('source-tasks'), client: {}, onChanged: async () => {} });
      window.sourceTasks.update({ read: { state: 'read' }, tasks, actor: 'joe', scope: 'team' });
    }, { calls: [
      { ...synthetic()[0], started_at: '2026-10-26T14:00:00Z' },
      { ...synthetic()[0], session_id: 'session-2', started_at: '2026-10-26T20:00:00Z' },
    ], theme });
    const headings = await page.locator('.call-outcome h4').allTextContents();
    assert.notEqual(headings[0], headings[1]);
    assert.match(headings[0], /9:00 AM CDT/);
    assert.match(headings[1], /3:00 PM CDT/);
    assert.match(await page.locator('.home-call-source').first().innerText(), /Oct 26.*9:00 AM CDT.*7d ago/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const directory = process.env.CALL_LABEL_SCREENSHOT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/home-${width}-${theme}.png`, fullPage: true });
    }
  } finally { await closeCallFixture(page, browser, server); }
});

for (const outcome of ['success', 'stale', 'missing-version', 'changed-before-submit']) {
  test(`Home versioned completion ${outcome} through the live client`, async () => {
    const { readFile } = await import('node:fs/promises');
    const { default: Ajv } = await import('ajv');
    const { contract } = JSON.parse(await readFile(new URL('./fixtures/home-review-call-contract.json', import.meta.url)));
    const ajv = new Ajv({ strict: false });
    const requestValid = ajv.compile(contract.inputSchema), responseValid = ajv.compile(contract.responseSchema), refusalValid = ajv.compile(contract.refusalSchema);
    const server = await fixtureServer(), browser = await chromium.launch({ headless: true }), page = await browser.newPage();
    const rows = synthetic(); rows[0].session_id = '00000000-0000-4000-8000-000000000011'; rows[0].open_cards = []; rows[0].applied = [{ ...rows[0].applied[0], deal_id: null }];
    if (outcome === 'missing-version') delete rows[0].source_version;
    let writes = [], reads = 0, release;
    const hold = new Promise(resolve => { release = resolve; });
    await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      let payload, isError = false;
      if (name === 'read-call-outcomes') {
        reads++;
        if (outcome === 'changed-before-submit' && reads === 2) rows[0].source_version = 'b'.repeat(32);
        payload = { schema_version: 'call-outcomes.v1', calls: structuredClone(rows), send: false };
        if (outcome === 'missing-version') {
          assert.equal(readerValid(payload), false);
          assert.deepEqual(readerValid.errors.map(error => [error.keyword, error.params.missingProperty]), [['required', 'source_version']]);
        } else assert.equal(readerValid(payload), true, JSON.stringify(readerValid.errors));
      } else if (name === 'review-call-outcome') {
        assert.equal(requestValid(args), true, JSON.stringify(requestValid.errors));
        writes.push(args);
        await hold;
        if (outcome === 'stale') {
          rows[0].source_version = 'b'.repeat(32);
          rows[0].applied[0].evidence_quote = 'The outcome changed elsewhere';
          payload = { ...contract.refusal, correlation_id: '00000000-0000-4000-8000-000000000001' };
          assert.equal(refusalValid(payload), true); isError = true;
        } else {
          payload = { ...contract.receipt, session_id: args.session_id };
          assert.equal(responseValid(payload), true); rows.length = 0;
        }
      } else throw new Error(`Unexpected verb ${name}`);
      await route.fulfill({ json: { result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    });
    try {
      await componentDocument(page, server.origin, {
        html: '<!doctype html><html><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/call-review.css"></head><body><script type="module">import "/js/doc-context.js";</script></body></html>',
        dispose: page => page.evaluate(() => window.guide?.dispose()),
      });
      await page.evaluate(async sessionId => {
        const { mountCallReview } = await import('/js/ui-call.generated.js');
        const { createLiveClient } = await import('/js/live-client.js');
        const node = document.createElement('section'); document.body.replaceChildren(node);
        const client = createLiveClient({ docContext: false });
        window.guide = mountCallReview(node, { sessionId, client: () => client,
          describe: change => change.payload.value, undoRefusal: () => 'Could not undo' });
        await window.guide.refresh();
      }, rows[0].session_id);
      const complete = page.getByRole('button', { name: 'Complete call review' });
      await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
      if (outcome === 'missing-version') {
        assert.equal(await complete.isDisabled(), true);
        await page.getByText('This call cannot be completed until its current version is available. Refresh call review to check again.', { exact: true }).waitFor();
        assert.equal(writes.length, 0);
        return;
      }
      await complete.click();
      if (outcome !== 'changed-before-submit') {
        await page.waitForFunction(() => document.querySelector('.call-review progress') && document.querySelector('.call-review nav button.primary').disabled);
        await settles(() => assert.equal(writes.length, 1));
        assert.equal(writes[0].expected_source_version, 'a'.repeat(32));
      }
      release();
      if (outcome === 'success') await page.getByText('Call review complete.', { exact: true }).waitFor();
      else {
        await page.getByRole('alert').filter({ hasText: 'This call outcome changed elsewhere.' }).waitFor();
        await page.getByText('0 of 1 reviewed', { exact: true }).waitFor();
        assert.equal(await complete.isDisabled(), true);
        assert.equal(writes.length, outcome === 'stale' ? 1 : 0);
        if (outcome === 'stale') await page.getByText('The outcome changed elsewhere', { exact: true }).waitFor();
      }
      await page.screenshot({ path: `/tmp/J227-${outcome}.png` });
    } finally { release(); await closeCallFixture(page, browser, server); }
  });
}

for (const width of [390, 1440])
  for (const theme of ["light", "dark"])
    for (const accept of [false, true])
      test(`Home proposal resolution changes source_version ${accept ? "approve" : "skip"} ${width} ${theme}`, async () => {
        const server = await fixtureServer(),
          browser = await chromium.launch({ headless: true }),
          page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
        let row = {
          session_id: "00000000-0000-4000-8000-000000000011",
          recorder: "joe",
          started_at: "2026-11-01T00:00:00Z",
          call_date: "2026-11-01",
          source_version: "a".repeat(32),
          applied: [
            {
              candidate_id: "change-1",
              kind: "next_step",
              deal_id: null,
              payload: { text: "Synthetic applied step" },
              deal_version: 1,
              undone_at: null,
            },
          ],
          open_cards: [
            {
              candidate_id: "card-1",
              kind: "email_draft",
              resolver: "resolve-post-call-candidate",
              deal_id: null,
              payload: { subject: "Synthetic email" },
            },
          ],
        };
        const writes = [];
        await page.route("**/auth/session", (r) =>
          r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
        );
        await page.route("**/mcp", async (r) => {
          const { name, arguments: args } = r.request().postDataJSON().params;
          let payload,
            isError = false;
          if (name === "read-call-outcomes") {
            payload = { schema_version: "call-outcomes.v1", send: false, calls: row ? [structuredClone(row)] : [] };
            assert.equal(readerValid(payload), true, JSON.stringify(readerValid.errors));
          } else if (name === "resolve-post-call-candidate") {
            assert.equal(args.accept, accept);
            row.open_cards = [];
            row.source_version = "b".repeat(32);
            payload = { ok: true };
          } else if (name === "review-call-outcome") {
            writes.push(args);
            if (args.expected_source_version !== row.source_version) {
              payload = {
                error: "source_version_changed",
                correlation_id: "00000000-0000-4000-8000-000000000012",
                hint: "This call changed. Reopen the card and review the current outcome.",
              };
              isError = true;
            } else {
              payload = { ok: true, session_id: row.session_id, reviewed: true };
              row = null;
            }
          } else throw new Error(name);
          await r.fulfill({
            json: { result: { isError, content: [{ type: "text", text: JSON.stringify(payload) }] } },
          });
        });
        try {
          await componentDocument(page, server.origin, {
            html: '<!doctype html><html><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/call-review.css"></head><body><script type="module">import "/js/doc-context.js";</script></body></html>',
            dispose: (p) => p.evaluate(() => window.guide.dispose()),
          });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await page.evaluate(async (sessionId) => {
            const { mountCallReview } = await import("/js/ui-call.generated.js");
            const { createLiveClient } = await import("/js/live-client.js");
            const node = document.createElement("div");
            document.body.append(node);
            const client = createLiveClient({ docContext: false });
            window.guide = mountCallReview(node, {
              sessionId,
              client: () => client,
              describe: (c) => c.payload.subject,
              undoRefusal: () => "",
            });
            await window.guide.refresh();
          }, row.session_id);
          await page.getByRole("button", { name: "Next", exact: true }).click();
          await page.getByRole("button", { name: "Approve or fix this item", exact: true }).click();
          await page.getByRole("button", { name: accept ? "Approve item" : "Skip item", exact: true }).click();
          await page.getByText("1 of 2 reviewed", { exact: true }).waitFor();
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await page.getByRole("button", { name: "Reviewed", exact: true }).click();
          await page.getByText("2 of 2 reviewed", { exact: true }).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const complete = page.getByRole("button", { name: "Complete call review", exact: true });
          await complete.click();
          await page.getByText("Call review complete.", { exact: true }).waitFor({ timeout: 3000 });
          assert.equal(writes.length, 1);
          assert.equal(writes[0].expected_source_version, "b".repeat(32));
          await page.screenshot({ path: `/tmp/j262-resolved-${accept}-${width}-${theme}.png` });
        } finally {
          await closeCallFixture(page, browser, server);
        }
      });
