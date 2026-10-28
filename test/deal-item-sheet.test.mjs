import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDealItemSheet } from '../js/deal-item-sheet.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('an unconfirmed instruction stays frozen when the item is reopened', async () => {
  const { window } = new JSDOM('<body></body>');
  const { document } = window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const requests = [];
  const entries = {};
  const sheet = mountDealItemSheet({ document,
    read: async () => ({ items: [{ id: 'demo', title: 'Vendor Introductions', status: 'open', bullets: [] }] }),
    pending: key => entries[key],
    send: async (key, step) => { requests.push(step); entries[key] = { status: 'unknown', request: { ...step.args, idempotency_key: 'retained-demo' } }; return { status: 'unknown', message: 'Check outcome' }; }, refresh() {},
  });
  sheet.open('deal', 'demo'); await tick();
  const textarea = document.querySelector('textarea');
  textarea.value = 'Make the introduction.';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick();
  document.querySelector('dialog').close();
  sheet.open('deal', 'demo'); await tick();
  assert.equal(document.querySelector('textarea').value, 'Make the introduction.');
  assert.equal(document.querySelector('textarea').readOnly, true);
  assert.equal(document.querySelector('[type="submit"]').textContent, 'Check outcome');
  assert.equal(document.querySelector('[data-complete-item]').disabled, true);
  assert.equal(requests.length, 1);
});

test('a write finishing after the same item reopens settles the visible sheet', async () => {
  const { window } = new JSDOM('<body></body>');
  const { document } = window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const sheet = mountDealItemSheet({ document,
    read: async () => ({ items: [{ id: 'demo', title: 'Vendor Introductions', status: 'open', bullets: [] }] }),
    send: () => response, refresh() {},
  });
  sheet.open('deal', 'demo'); await tick();
  document.querySelector('textarea').value = 'Make the introduction.';
  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  document.querySelector('dialog').close();
  sheet.open('deal', 'demo'); await tick();
  finish({ status: 'ok' }); await tick(); await tick();
  assert.equal(document.querySelector('[data-item-status]').textContent, 'Instruction saved');
  assert.equal(document.querySelector('textarea').disabled, false);
});
