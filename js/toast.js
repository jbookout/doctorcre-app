const SUCCESS_HOLD_MS = 2_000;
const UNDO_HOLD_MS = 5_000;
const FADE_MS = 800;

let active = null;

function timer(callback, delay, state) {
  const handle = setTimeout(callback, delay);
  handle?.unref?.();
  state.timers.push(handle);
  return handle;
}

function clear(state) {
  for (const handle of state?.timers || []) clearTimeout(handle);
  if (state) state.timers.length = 0;
}

function remove(state) {
  clear(state);
  state?.node.remove();
  if (active === state) active = null;
}

export function showToast(message, { eventId = null, error = false } = {}) {
  const doc = globalThis.document;
  if (!doc?.body) return null;
  if (active) remove(active);
  doc.querySelectorAll('.toast').forEach((node) => node.remove());

  const state = { node: doc.createElement('div'), timers: [] };
  const node = state.node;
  active = state;
  node.id = 'toast';
  node.dataset.transient = '';
  node.className = 'toast show';
  node.setAttribute('role', error ? 'alert' : 'status');
  node.setAttribute('aria-atomic', 'true');
  const text = doc.createElement('span');
  text.textContent = String(message ?? '');
  node.append(text);

  let undo = null;
  if (eventId !== null && eventId !== undefined && String(eventId)) {
    undo = doc.createElement('button');
    undo.type = 'button';
    undo.className = 'receipt-undo';
    undo.dataset.undo = String(eventId);
    undo.textContent = 'Undo';
    node.append(undo);
  }

  if (error) {
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'receipt-undo';
    close.dataset.toastClose = '';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = 'Close';
    close.addEventListener('click', () => remove(state), { once: true });
    node.append(close);
  }

  doc.body.append(node);
  if (!error) {
    const hold = undo ? UNDO_HOLD_MS : SUCCESS_HOLD_MS;
    timer(() => {
      if (active !== state) return;
      if (undo) undo.disabled = true;
      node.classList.add('is-leaving');
      timer(() => remove(state), FADE_MS, state);
    }, hold, state);
  } else if (undo) timer(() => { if (active === state) undo.disabled = true; }, UNDO_HOLD_MS, state);
  return node;
}
