import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadEvidence, renderEvidence } from '../js/correspondence.js';

test('latest email threads keep email classification and message times in newest-first order', async () => {
  const view = await loadEvidence({ email_threads: [
    { subject: 'Older email', latest_message_at: '2026-12-01T12:00:00Z' },
    { subject: 'Newer email', latest_message_at: '2026-12-02T12:00:00Z' },
  ] });
  assert.deepEqual(view.threads.items.map(item => item.title), ['Newer email', 'Older email']);
  const doc = new JSDOM(renderEvidence(view)).window.document;
  const rows = [...doc.querySelectorAll('[data-kind="thread"]')];
  assert.deepEqual(rows.map(row => row.querySelector('summary span').textContent), ['Newer email', 'Older email']);
  assert.ok(rows.every(row => row.querySelector('p').textContent === 'Email'));
  assert.equal(rows[0].querySelector('time').textContent, 'Dec 2, 6:00 AM CST');
});

test('missing email thread coverage stays unavailable without reading a mailbox', async () => {
  const view = await loadEvidence({});
  assert.equal(view.threads.state, 'unavailable');
  assert.equal(view.threads.count, null);
});

test('email snapshots distinguish empty coverage and escape missing or untrusted subjects', async () => {
  const empty = await loadEvidence({ email_threads: [] });
  assert.equal(empty.threads.count, 0);
  assert.match(renderEvidence(empty), /No linked evidence/);
  const view = await loadEvidence({ email_threads: [
    { subject: '<img src=x onerror=alert(1)>', latest_message_at: '2026-12-01T12:00:00Z' },
    { subject: '', latest_message_at: '2026-12-02T12:00:00Z' },
  ] });
  const html = renderEvidence(view);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.equal(view.threads.items[0].title, '(No subject)');
});

test('email snapshots preserve meeting ordering, provenance checks and escaping', async () => {
  const meeting = { id:'demo-meeting', source:'Demo calendar', kind:'meeting', summary:'<b>Demo meeting</b>', occurred_at:'2026-12-01T12:00:00Z' };
  const view = await loadEvidence({ email_threads: [], activities:[meeting, {...meeting, id:'demo-newer', occurred_at:'2026-12-02T12:00:00Z'}] });
  assert.deepEqual(view.meetings.items.map(item => item.id), ['demo-newer', 'demo-meeting']);
  assert.doesNotMatch(renderEvidence(view), /<b>/);
  assert.match(renderEvidence(view), /&lt;b&gt;/);
  assert.equal((await loadEvidence({activities:[{...meeting,source:null}]})).meetings.state, 'unavailable');
});
