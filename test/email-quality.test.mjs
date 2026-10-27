import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountEmailQuality } from '../js/email-quality.js';

const kind = (name, values = {}) => ({ kind: name, proposed: 0, pending: 0, confirmed: 0, dismissed: 0,
  dismiss_rate: null, confirmed_confidence: null, dismissed_confidence: null, over_threshold: false, ...values });
const report = () => ({ schema_version: 'email-proposal-quality.v1', days: 7, send: false,
  kinds: [kind('phase_move', { proposed: 11, pending: 1, confirmed: 9, dismissed: 1, dismiss_rate: 0.1,
    confirmed_confidence: 0.9, dismissed_confidence: 0.5, over_threshold: true }), kind('next_step')],
  corrections: [{ id: 'demo-correction', kind: 'phase_move', deal_name: 'Demo Harbor', reason: 'Already handled', resolved_at: '2026-10-27T12:00:00Z' }] });
function setup(t, client) {
  const dom = new JSDOM('<section></section>');
  const container = dom.window.document.querySelector('section');
  const view = mountEmailQuality({ container, client });
  t.after(() => { view.dispose(); dom.window.close(); });
  return { dom, container, view };
}

test('Home reports weekly proposal outcomes, confidence, advisory threshold and correction reasons', async t => {
  const { container, view } = setup(t, { getEmailProposalQuality: async () => report() });
  await view.refresh();
  assert.match(container.textContent, /Email proposal quality/);
  assert.match(container.textContent, /last 7 days/);
  assert.match(container.textContent, /created/);
  const phase = container.querySelector('[data-quality-kind="phase_move"]');
  assert.match(phase.textContent, /Proposed: 11/);
  assert.match(phase.textContent, /Pending: 1/);
  assert.match(phase.textContent, /Confirmed: 9/);
  assert.match(phase.textContent, /Dismissed: 1/);
  assert.match(phase.textContent, /Dismissal rate: 10%/);
  assert.match(phase.textContent, /Confirmed confidence: 90%/);
  assert.match(phase.textContent, /Dismissed confidence: 50%/);
  assert.match(phase.textContent, /advisory/i);
  assert.match(container.textContent, /does not change/i);
  assert.match(container.textContent, /Demo Harbor/);
  assert.match(container.textContent, /Already handled/);
  assert.equal(container.getAttribute('aria-busy'), 'false');
});

test('a successful empty report distinguishes unavailable confidence and unresolved rate from zero', async t => {
  const value = report(); value.kinds = [kind('phase_move'), kind('next_step', { proposed: 2, confirmed: 2, dismiss_rate: 0, confirmed_confidence: 0 })]; value.corrections = [];
  const { container, view } = setup(t, { getEmailProposalQuality: async () => value });
  await view.refresh();
  assert.match(container.querySelector('[data-quality-kind="phase_move"]').textContent, /Dismissal rate: No resolved proposals/);
  assert.match(container.querySelector('[data-quality-kind="phase_move"]').textContent, /Confirmed confidence: Unavailable/);
  assert.match(container.querySelector('[data-quality-kind="next_step"]').textContent, /Dismissal rate: 0%/);
  assert.match(container.querySelector('[data-quality-kind="next_step"]').textContent, /Confirmed confidence: 0%/);
  assert.match(container.textContent, /No corrections in this window/);
  value.kinds = [kind('phase_move'), kind('next_step')]; await view.refresh();
  assert.match(container.textContent, /No email proposals created in this window/);
});

test('failed reads keep the last report with retry and never claim an empty window', async t => {
  let value = new Error('offline');
  const { container, view, dom } = setup(t, { getEmailProposalQuality: async () => { if (value instanceof Error) throw value; return value; } });
  await view.refresh();
  assert.match(container.textContent, /Could not load email proposal quality/);
  assert.doesNotMatch(container.textContent, /No email proposals/);
  value = report();
  const button = container.querySelector('button'); button.focus(); button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(container.textContent, /Demo Harbor/);
  assert.equal(dom.window.document.activeElement.tagName, 'H2');
  value = new Error('offline'); await view.refresh();
  assert.match(container.textContent, /Showing the last successful read/);
  assert.match(container.textContent, /Demo Harbor/);
  assert.equal(container.getAttribute('aria-busy'), 'false');
});

test('malformed reports remain unavailable instead of inventing counts or a zero rate', async t => {
  const invalid = [null, {}, { ...report(), kinds: [] }, { ...report(), send: true },
    { ...report(), kinds: [kind('phase_move', { proposed: -1 }), kind('next_step')] },
    { ...report(), kinds: [kind('phase_move', { dismiss_rate: 4 }), kind('next_step')] },
    { ...report(), kinds: [kind('phase_move'), kind('phase_move')] },
    { ...report(), kinds: [kind('phase_move', { proposed: 2, pending: 1 }), kind('next_step')] },
    { ...report(), kinds: [kind('phase_move', { proposed: 1, confirmed: 1, dismiss_rate: null }), kind('next_step')] }];
  for (const value of invalid) {
    const { container, view } = setup(t, { getEmailProposalQuality: async () => value });
    await view.refresh();
    assert.match(container.textContent, /Could not load email proposal quality/);
    assert.equal(container.querySelectorAll('[data-quality-kind]').length, 0);
  }
});

test('corrections are untrusted text and never become HTML', async t => {
  const value = report(); value.corrections[0].deal_name = '<img src=x onerror="alert(1)">'; value.corrections[0].reason = '<script>bad()</script> & "quote"';
  const { container, view } = setup(t, { getEmailProposalQuality: async () => value });
  await view.refresh();
  assert.equal(container.querySelector('img, script'), null);
  assert.match(container.textContent, /<script>bad\(\)<\/script> & "quote"/);
});

test('authorization loss clears the retained report and stops later refreshes', async t => {
  for (const error of [Object.assign(Error('denied'), { status: 401 }), Object.assign(Error('denied'), { status: 403 }), Object.assign(Error('changed'), { code: 'session_changed' })]) {
    let denied = false, reads = 0;
    const { container, view } = setup(t, { getEmailProposalQuality: async () => { reads++; if (denied) throw error; return report(); } });
    await view.refresh(); denied = true; await view.refresh(); await view.refresh();
    assert.equal(reads, 2);
    assert.match(container.textContent, /Sign in/);
    assert.doesNotMatch(container.textContent, /Demo Harbor|Already handled|Phase changes/);
  }
});

test('session invalidation clears data and fences a late successful read', async t => {
  let resolve;
  const { container, view, dom } = setup(t, { getEmailProposalQuality: () => new Promise(done => { resolve = done; }) });
  const pending = view.refresh();
  assert.equal(container.getAttribute('aria-busy'), 'true');
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  resolve(report()); await pending;
  assert.match(container.textContent, /Sign in/);
  assert.doesNotMatch(container.textContent, /Demo Harbor|Already handled/);
});
