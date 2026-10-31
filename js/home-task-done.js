const hosts = new WeakMap();
function state(host) {
  if (!hosts.has(host)) hosts.set(host, { requests: new Map(), note: '', unavailable: false });
  return hosts.get(host);
}

export function paint(host) {
  const view = state(host);
  for (const button of host.querySelectorAll('[data-task-done]')) {
    if (view.unavailable) {
      if (host.ownerDocument.activeElement === button) button.closest('article').querySelector('a')?.focus();
      button.remove();
      continue;
    }
    const request = view.requests.get(button.dataset.taskDone);
    button.disabled = Boolean(request?.busy);
    button.textContent = request?.busy ? 'Checking…' : 'Done';
  }
  let notice = host.querySelector('[data-task-notice]');
  if (!notice) {
    notice = host.ownerDocument.createElement('p');
    notice.dataset.taskNotice = '';
    notice.className = 'home-empty';
    notice.setAttribute('role', 'status');
    host.append(notice);
  }
  notice.textContent = view.note;
  notice.hidden = !view.note;
}

export function retain(host, snapshot) {
  for (const request of state(host).requests.values()) {
    const rows = snapshot?.details.get(request.deal)?.next_actions;
    if (Array.isArray(rows) && request.row && !rows.some(row => row.id === request.row.id)) rows.push(request.row);
  }
}

export async function complete(host, button, client, update, current, snapshot) {
  const view = state(host), id = button.dataset.taskDone;
  if (view.unavailable || view.requests.get(id)?.busy) return;
  let request = view.requests.get(id);
  if (!request) {
    request = { deal: button.dataset.deal, row: snapshot?.details.get(button.dataset.deal)?.next_actions.find(row => row.id === id), args: { action_id: id, base_version: Number(button.dataset.version), idempotency_key: crypto.randomUUID() }, busy: false };
    view.requests.set(id, request);
  }
  request.busy = true;
  view.note = '';
  paint(host);
  try {
    let refusal;
    try { await client.completeOneAction(request.args); }
    catch (error) {
      refusal = error.payload?.error;
      if (!['version_conflict', 'action_not_open'].includes(refusal)) throw error;
    }
    const detail = await client.getDeal(button.dataset.deal);
    if (!current()) return;
    const row = detail.next_actions?.find(row => row.id === id);
    if (!row || (refusal !== 'version_conflict' && row.status !== 'done' && !(refusal === 'action_not_open' && row.status !== 'open'))) throw Error('Readback incomplete');
    view.note = refusal === 'version_conflict' ? 'This task changed. Review it before choosing Done again.' : refusal === 'action_not_open' ? 'This task was already done.' : '';
    view.requests.delete(id);
    update(row);
  } catch (error) {
    if (!current()) return;
    view.unavailable = error.rpcCode === -32601 || ['unknown_tool', 'tool_not_found', 'unknown_operation', 'method_not_found'].includes(error.payload?.error);
    if (view.unavailable) view.requests.clear();
    view.note = view.unavailable ? '' : 'Could not confirm this task is done. Try Done again.';
  } finally {
    request.busy = false;
    if (current()) paint(host);
  }
}
