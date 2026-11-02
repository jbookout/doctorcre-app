import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { callChangeText, callOutcomesHtml, callsFor, mountCallOutcomes } from '../js/call-outcomes.js';

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

test('each applied change says what changed, quotes the call, and offers one Undo', () => {
  assert.equal(callChangeText(synthetic()[0].applied[0]), 'Phase moved to Negotiation, started Oct 20');
  assert.equal(callChangeText(synthetic()[0].applied[1]), 'Next step: Schedule the second walkthrough · due Nov 3');
  // Phase words match the board's, not a second vocabulary.
  assert.equal(callChangeText({ kind: 'phase_move', payload: { value: 'due_diligence' } }), 'Phase moved to Diligence');
  assert.equal(callChangeText({ kind: 'phase_move', payload: { value: 'pending' } }), 'Phase moved to On Deck');
  const html = callOutcomesHtml(synthetic());
  assert.match(html, /Applied from the Oct 26 pipeline call/);
  assert.match(html, /<q>Bayside moves to negotiation<\/q>/);
  assert.equal(html.match(/data-call-undo=/g).length, 2);
  assert.match(html, /data-call-undo="phase-1" data-base-version="7"/);
  assert.match(html, /1 item from this call still needs Joe or Dell to decide/);
  assert.deepEqual(callsFor(synthetic(), ['step-1']).length, 1);
  assert.deepEqual(callsFor(synthetic(), ['someone-else']).length, 0);
});

test('Undo reverts with the deal version and Looks right takes the call off Home', async () => {
  const dom = new JSDOM('<section id="outcomes" hidden></section>');
  const container = dom.window.document.getElementById('outcomes');
  const rows = synthetic();
  const calls = [];
  const spy = {
    readCallOutcomes: async () => ({ calls: structuredClone(rows.filter(call => !call.reviewed)) }),
    undoCallChange: async args => { calls.push(['undo', args]);
      rows[0].applied.find(change => change.candidate_id === args.candidate_id).undone_at = '2026-10-26T15:00:00Z'; },
    reviewCallOutcome: async args => { calls.push(['review', args]); rows[0].reviewed = true; },
  };
  const toasts = [];
  const view = mountCallOutcomes({ container, client: () => spy, toast: message => toasts.push(message) });
  await view.refresh();
  assert.equal(container.hidden, false);
  await view.click({ target: container.querySelector('[data-call-undo="phase-1"]') });
  assert.deepEqual(calls[0], ['undo', { candidate_id: 'phase-1', base_version: 7 }]);
  assert.match(container.innerHTML, /Undone/);
  assert.equal(container.querySelectorAll('[data-call-undo]').length, 1);
  await view.click({ target: container.querySelector('[data-call-reviewed]') });
  assert.deepEqual(calls[1], ['review', { session_id: 'session-1' }]);
  assert.equal(container.hidden, true);
  assert.deepEqual(toasts, ['Change undone.', 'Marked reviewed.']);
});

test('a card edited after the call refuses Undo with a plain instruction', async () => {
  const dom = new JSDOM('<section id="outcomes"></section>');
  const container = dom.window.document.getElementById('outcomes');
  const toasts = [];
  const view = mountCallOutcomes({ container, toast: message => toasts.push(message), client: () => ({
    readCallOutcomes: async () => ({ calls: synthetic() }),
    undoCallChange: async () => { throw Object.assign(new Error('refused'), { payload: { error: 'newer_change_exists' } }); },
  }) });
  await view.refresh();
  await view.click({ target: container.querySelector('[data-call-undo="step-1"]') });
  assert.deepEqual(toasts, ['That card changed again after the call. Edit it on the deal instead.']);
});

test('every Undo refusal reads as a plain sentence, never developer text', async () => {
  for (const [error, sentence] of [
    ['overdue_action_changed', "A task this call closed was changed afterward, so this change can't be undone. Edit the deal's next step and tasks directly instead."],
    ['version_conflict', 'That deal changed since this list loaded. Check it and press Undo again if it is still wrong.'],
    ['applied_change_not_found', 'That change is no longer on the deal. Open the deal to check it.'],
    ['partner_required', 'Only Joe or Dell can undo a change from the call.'],
    ['something_new', 'The change could not be undone. Open the deal to check it.'],
  ]) {
    const dom = new JSDOM('<section id="outcomes"></section>');
    const container = dom.window.document.getElementById('outcomes');
    const toasts = []; let sent = 0;
    const view = mountCallOutcomes({ container, toast: message => toasts.push(message), client: () => ({
      readCallOutcomes: async () => ({ calls: synthetic() }),
      undoCallChange: async () => { sent += 1; throw Object.assign(new Error(`live undo-call-change refused: ${error}`), { payload: { error } }); },
    }) });
    await view.refresh();
    await view.click({ target: container.querySelector('[data-call-undo="phase-1"]') });
    assert.deepEqual(toasts, [sentence], error);
    assert.equal(sent, 1, 'a refusal is shown, never retried');
  }
});

test("Home's count of undecided items opens the cards", async () => {
  const dom = new JSDOM('<section id="outcomes"></section>');
  const container = dom.window.document.getElementById('outcomes');
  const opened = [];
  const older = { ...synthetic()[0], session_id: 'older-call', call_date: '2026-10-19' };
  const view = mountCallOutcomes({ container, openCards: session => { opened.push(session); },
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
  const view = mountCallOutcomes({ container, listen: false, client: () => client });
  await view.refresh();
  const stale = container.querySelector('[data-call-undo]');
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
    await page.getByText('No call items to review.', { exact: true }).waitFor();
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
    assert.deepEqual(await page.evaluate(() => window.undoWrites.map(row => row.base_version)), [3, 8]);
  } finally { await page.close(); await browser.close(); await server.close(); }
});
