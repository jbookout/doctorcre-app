import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveBoardFocus } from '../js/board-focus.mjs';

function scene() {
  const document = { activeElement: null, body: { id: 'body' } };
  const board = {
    cards: new Map(),
    contains(node) { return node?.board === this; },
    querySelectorAll() { return [...this.cards.values()]; },
    focus() { document.activeElement = this; },
  };
  function card(id) {
    const item = {
      board,
      dataset: { id },
      open: { board, dataset: { open: id }, focus() { document.activeElement = this; } },
      move: { board, dataset: { move: id }, focus() { document.activeElement = this; } },
      focus() { document.activeElement = this; },
      querySelector(selector) { return selector === '[data-open]' ? this.open : selector === '[data-move]' ? this.move : null; },
    };
    for (const control of [item.open, item.move]) control.closest = () => item;
    board.cards.set(id, item);
    return item;
  }
  return { board, card, document };
}

test('a board refresh restores the focused Move control on the same canonical card', () => {
  const { board, card, document } = scene();
  const old = card('deal-1');
  old.move.focus();
  preserveBoardFocus({ board, document, paint() {
    board.cards.clear();
    card('deal-1');
    document.activeElement = document.body;
  } });
  assert.equal(document.activeElement, board.cards.get('deal-1').move);
});

test('a refresh never steals focus intentionally moved outside the board', () => {
  const { board, card, document } = scene();
  card('deal-1').open.focus();
  const dialog = { id: 'completion-dialog' };
  preserveBoardFocus({ board, document, paint() {
    board.cards.clear();
    card('deal-1');
    document.activeElement = dialog;
  } });
  assert.equal(document.activeElement, dialog);
});

test('a filtered-out card moves focus to the stable board and announces why', () => {
  const { board, card, document } = scene();
  card('deal-1').move.focus();
  const messages = [];
  preserveBoardFocus({ board, document, announce: (message) => messages.push(message), paint() {
    board.cards.clear();
    document.activeElement = document.body;
  } });
  assert.equal(document.activeElement, board);
  assert.match(messages[0], /no longer in this board view/i);
});
