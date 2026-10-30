import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { workCard } from '../js/work-card.js';

test('a card without additional state or content omits the chip and empty body', () => {
  const dom = new JSDOM(workCard({ title: 'Demo clinic', meta: 'Joe', body: '   ' }));
  assert.equal(dom.window.document.querySelector('.work-card-status'), null);
  assert.equal(dom.window.document.querySelector('.work-card-body'), null);
  dom.window.close();
});

test('layout variants preserve the shared slots and escape state text', () => {
  for (const variant of ['tile', 'row', 'stack']) {
    const dom = new JSDOM(workCard({ variant, title: 'Demo clinic', meta: 'Joe', status: '<waiting>', body: 'Next step', actions: '<button>Open</button>' }));
    const card = dom.window.document.querySelector('article');
    assert.ok(card.classList.contains(`work-card--${variant}`));
    assert.equal(card.querySelector('.work-card-status').textContent, '<waiting>');
    assert.equal(card.querySelectorAll('button').length, 1);
    dom.window.close();
  }
});
