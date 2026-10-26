import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { callChangeText, callOutcomesHtml, callsFor, mountCallOutcomes } from '../js/call-outcomes.js';

// Synthetic read-call-outcomes rows (CARR call-outcomes.v1).
const synthetic = () => [{
  session_id: 'session-1', call_date: '2026-10-26', recorder: 'joe',
  applied: [
    { candidate_id: 'phase-1', kind: 'phase_move', deal_id: 'deal-a', deal_name: 'Demo Bayside relocation', deal_version: 7,
      payload: { deal: 'deal-a', field: 'phase', value: 'negotiation', started_on: '2026-10-20' },
      evidence_quote: 'Bayside moves to negotiation', applied_at: '2026-10-26T14:00:00Z', undone_at: null },
    { candidate_id: 'step-1', kind: 'next_step', deal_id: 'deal-b', deal_name: 'Demo Harbor expansion', deal_version: 3,
      payload: { deal: 'deal-b', text: 'Schedule the second walkthrough', next_date: '2026-11-03' },
      evidence_quote: 'schedule the second walkthrough on November 3', applied_at: '2026-10-26T14:00:00Z', undone_at: null },
  ],
  open_cards: [{ candidate_id: 'card-1', resolver: 'resolve-post-call-candidate', kind: 'email_draft', deal_id: 'deal-a' }],
}];

test('each applied change says what changed, quotes the call, and offers one Undo', () => {
  assert.equal(callChangeText(synthetic()[0].applied[0]), 'Phase moved to Negotiation, started 2026-10-20');
  assert.equal(callChangeText(synthetic()[0].applied[1]), 'Next step: Schedule the second walkthrough · due 2026-11-03');
  const html = callOutcomesHtml(synthetic());
  assert.match(html, /Applied from the 2026-10-26 pipeline call/);
  assert.match(html, /<q>Bayside moves to negotiation<\/q>/);
  assert.equal(html.match(/data-call-undo=/g).length, 2);
  assert.match(html, /data-call-undo="phase-1" data-base-version="7"/);
  assert.match(html, /1 item still needs Joe or Dell to decide/);
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
