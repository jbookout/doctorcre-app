/** Keep a keyboard user's place while a newer authoritative board replaces its cards. */
export function preserveBoardFocus({ board, document, paint, announce = () => {} }) {
  const active = document.activeElement;
  const card = board.contains(active) ? active.closest?.('.kanban-card') : null;
  const id = card?.dataset.id;
  const control = active?.dataset?.open === id ? 'open'
    : active?.dataset?.move === id ? 'move' : 'card';

  paint();
  if (!id) return;

  // A dialog or another control can take focus while painting. That choice wins.
  const focused = document.activeElement;
  if (focused !== document.body && focused !== active) return;

  const current = [...board.querySelectorAll('.kanban-card')]
    .find((item) => item.dataset.id === id);
  if (!current) {
    board.focus();
    announce('That deal is no longer in this board view. Focus moved to the board.');
    return;
  }
  const target = control === 'card' ? current : current.querySelector(`[data-${control}]`);
  (target || current).focus();
}
