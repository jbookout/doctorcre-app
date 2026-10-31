import { renderDealItemDetail } from './deal-items.js';

export function mountDealItemSheet({ document, read, send, refresh, pending = () => null, today = () => '' }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog deal-item-sheet';
  dialog.setAttribute('aria-labelledby', 'dealItemTitle');
  dialog.innerHTML = '<header><h2 id="dealItemTitle"></h2><button class="btn icon-btn" type="button" aria-label="Close item" data-close-item>×</button></header><div class="dialog-body" data-item-body></div>';
  document.body.append(dialog);
  const body = dialog.querySelector('[data-item-body]');
  const drafts = new Map();
  let selected = null, sequence = 0, trigger = null;
  const same = selection => selected === selection && dialog.open;
  const operationKey = (verb, selection) => `${verb}:${selection.deal}:${selection.item}`;
  function syncPending() {
    const completion = pending(operationKey('complete-deal-item', selected));
    const textarea = body.querySelector('textarea');
    const submit = body.querySelector('[type="submit"]');
    const done = body.querySelector('[data-complete-item]');
    if (completion) {
      textarea.readOnly = true;
      submit.disabled = true;
      done.textContent = 'Check outcome';
      done.disabled = completion.status === 'pending';
    }
  }
  function paint(item, message = '') {
    dialog.querySelector('h2').textContent = item.title;
    body.innerHTML = renderDealItemDetail(item,{today:today()});
    body.querySelector('textarea').value = drafts.get(selected.item) || '';
    body.querySelector('[data-item-status]').textContent = message;
    syncPending();
  }
  async function load(selection, message = '') {
    const ticket = ++sequence;
    try {
      const detail = await read(selection.deal);
      if (!same(selection) || ticket !== sequence) return;
      const item = (detail.items || detail.deal.items || []).find(row => row.id === selection.item);
      if (!item) throw new Error('Item unavailable');
      paint(item, message);
    } catch {
      if (same(selection) && ticket === sequence) {
        body.innerHTML = '<p role="status">Item unavailable.</p><button type="button" class="btn" data-retry-item>Retry</button>';
      }
    }
  }
  dialog.addEventListener('input', event => {
    if (selected && event.target.matches('textarea')) drafts.set(selected.item, event.target.value);
  });
  async function save() {
    const verb = 'complete-deal-item';
    const selection = selected;
    if (!selection || body.getAttribute('aria-busy') === 'true') return;
    body.setAttribute('aria-busy', 'true');
    body.querySelectorAll('button,textarea').forEach(node => { node.disabled = true; });
    let result;
    try {
      result = await send(operationKey(verb, selection), { verb,
        args: { deal: selection.deal, item_id: selection.item },
        summary: 'Complete item' });
    } catch { result = { message: 'Change not confirmed. Check outcome before trying again.' }; }
    if (result?.status === 'ok') {
      refresh();
    }
    const visible = selected;
    if (!visible || !dialog.open || visible.deal !== selection.deal || visible.item !== selection.item) return;
    body.removeAttribute('aria-busy');
    if (result?.status === 'ok') await load(visible, 'Item marked done');
    else {
      body.querySelectorAll('button,textarea').forEach(node => { node.disabled = false; });
      body.querySelector('[type="submit"]').disabled = true;
      body.querySelector('[data-item-status]').textContent = result?.message || 'Change not confirmed';
      syncPending();
      if (result?.status !== 'failed') {
        body.querySelector('textarea').readOnly = true;
        const button = body.querySelector('[data-complete-item]');
        button.textContent = 'Check outcome';
      }
    }
  }
  dialog.addEventListener('submit', event => { event.preventDefault(); });
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close-item]')) dialog.close();
    if (event.target.closest('[data-complete-item]')) save();
    if (event.target.closest('[data-retry-item]')) load(selected);
  });
  dialog.addEventListener('close', () => {
    const deal = selected?.deal;
    selected = null; ++sequence;
    const fallback = [...document.querySelectorAll('.kanban-card')].find(card => card.dataset.id === deal)?.querySelector('.card-open');
    (trigger?.isConnected ? trigger : fallback)?.focus();
  });
  return { open(deal, item, element = null) {
    selected = { deal, item }; trigger = element;
    body.removeAttribute('aria-busy');
    body.innerHTML = '<p role="status">Updating…</p>';
    dialog.querySelector('h2').textContent = 'Deal item';
    if (!dialog.open) dialog.showModal();
    load(selected);
  } };
}
