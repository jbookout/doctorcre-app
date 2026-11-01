import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';

const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const { createBriefQueueView } = await import('data:text/javascript;base64,' + bundle.toString('base64'));

function host(t) {
  const dom = new JSDOM('<nav id="menu"></nav><div id="content"><p>Classic brief</p></div>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const document = dom.window.document;
  const view = createBriefQueueView(document.getElementById('menu'), document.getElementById('content'));
  t.after(() => view.dispose());
  return { document, view };
}

const sections = () => ({
  today: { state: 'empty', items: [], total: 0 },
  loops: { state: 'empty', items: [], total: 2 },
  needs_joe: { state: 'partial', items: [{}], total: 1, total_scope: 'available_sources' },
  assurance_cadence: { state: 'unavailable', items: [], total: 0, total_scope: 'available_sources' },
});

test('queue menu names the four queues for Joe and hides Needs Joe from Dell', t => {
  const { document, view } = host(t);
  view.renderMenu({ sponsor: 'joe', sections: sections() });
  const buttons = [...document.querySelectorAll('[data-brief-queue]')];
  assert.deepEqual(buttons.map(node => node.dataset.briefQueue), ['today', 'loops', 'needs_joe', 'assurance_cadence']);
  assert.match(document.getElementById('menu').textContent, /Selected priorities\. Open a queue for all eligible work\./);
  assert.match(buttons[2].textContent, /Needs Joe · 1 of 1 from available sources · Some sources are unavailable/);
  assert.match(buttons[3].textContent, /Assurance alerts · 0 of 0 from available sources · Unavailable/);
  const loops = document.querySelector('[data-brief-queue="loops"]');
  loops.focus();
  view.renderMenu({ sponsor: 'joe', sections: sections() });
  assert.equal(document.activeElement, loops, 'an unchanged menu keeps the focused queue control');
  view.renderMenu({ sponsor: 'dell', sections: sections() });
  assert.equal(document.querySelector('[data-brief-queue="needs_joe"]'), null);
  assert.equal(document.querySelectorAll('[data-brief-queue]').length, 3);
  view.renderMenu(null);
  assert.equal(document.querySelectorAll('[data-brief-queue]').length, 0);
});

test('an open queue collapses the chooser to one switch', t => {
  const { document, view } = host(t);
  view.renderMenu({ sponsor: 'joe', sections: sections() }, 'loops');
  assert.equal(document.querySelectorAll('[data-brief-queue]').length, 0);
  const select = document.querySelector('[data-brief-queue-switch]');
  assert.equal(select.value, 'loops');
  assert.equal(select.getAttribute('aria-label'), 'Work queue');
  assert.deepEqual([...select.options].map(option => option.value), ['today', 'loops', 'needs_joe', 'assurance_cadence']);
  assert.doesNotMatch(document.getElementById('menu').textContent, /Selected priorities/);
  view.renderMenu({ sponsor: 'dell', sections: sections() }, 'loops');
  assert.deepEqual([...document.querySelector('[data-brief-queue-switch]').options].map(option => option.value), ['today', 'loops', 'assurance_cadence']);
  view.renderMenu({ sponsor: 'joe', sections: sections() });
  assert.equal(document.querySelector('[data-brief-queue-switch]'), null);
  assert.ok(document.querySelector('[data-brief-queue="today"]'));
});

test('queue list replaces the classic brief and keeps the row contract', t => {
  const { document, view } = host(t);
  const row = { number: '7', kind: 'open_loop', title: 'Synthetic loop 7', due_on: '2026-01-01', owner_partner: 'joe' };
  view.renderList({ active: 'loops', items: [row], page: { total: 2, has_more: true, state: 'partial', total_scope: 'available_sources' }, busy: false, error: false });
  const content = document.getElementById('content');
  assert.equal(content.querySelector('#classic'), null);
  assert.equal(content.querySelector('h3'), null);
  assert.equal(content.querySelector('[role=status]'), null);
  assert.doesNotMatch(content.textContent, /1 of 2/);
  assert.match(content.textContent, /Some sources are unavailable\. This list may be incomplete\./);
  assert.match(content.textContent, /Urgency order\. Refresh for a new list\./);
  assert.equal(content.querySelector('[data-queue-item]').getAttribute('data-queue-item'), 'open_loop:7');
  assert.match(content.querySelector('summary').textContent, /^Synthetic loop 7$/);
  assert.match(content.textContent, /Due/);
  assert.equal(content.querySelector('[data-brief-queue-more]').textContent, 'Load more');
  assert.equal(content.querySelector('[data-brief-queue-back]').textContent, 'Back to priorities');
  view.renderList({ active: 'loops', items: [row], page: { total: 2, has_more: true }, busy: true, error: true });
  assert.match(content.querySelector('[role=status]').textContent, /^Updating… · Queue update unavailable; retry to continue\.$/);
  assert.equal(content.querySelector('[data-brief-queue-more]').textContent, 'Retry queue');
  assert.equal(content.querySelector('[data-brief-queue-more]').disabled, true);
  view.renderList({ active: 'loops', items: [row, { number: '8', kind: 'open_loop', title: 'Synthetic <loop> & "8"', due_on: '2026-01-02' }], page: { total: 2, has_more: false }, busy: false, error: false });
  assert.equal(content.querySelector('[data-brief-queue-more]'), null);
  assert.equal(content.querySelectorAll('[data-queue-item]').length, 2);
  assert.match(content.textContent, /Synthetic <loop> & "8"/);
  assert.doesNotMatch(content.innerHTML, /&amp;amp;|&lt;loop&gt;amp/);
  view.clearList();
  assert.equal(content.querySelector('.morning-queue'), null);
  content.innerHTML = '<p>Classic brief</p>';
  assert.equal(content.textContent, 'Classic brief');
});
