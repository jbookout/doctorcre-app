import { readWithDeadline } from './auto-refresh.mjs';

// Literal import() would put the generated bundle on the shell and tour walks.
// The bundle is produced after those walks, and Home already loads it for the
// email follow-up island. Open the brief, then reuse that module.
const QUEUE_VIEW = './ui.generated.js';
const present = value => typeof value === 'string' && value.length > 0;
function validPage(value, sponsor, previousCursor) {
  return value?.sponsor === sponsor && value.state !== 'unavailable' && Array.isArray(value.items) && value.returned === value.items.length && Number.isInteger(value.total) && value.total >= value.items.length
    && typeof value.has_more === 'boolean' && (value.has_more ? typeof value.next_cursor === 'string' && value.next_cursor.length > 0 && value.next_cursor !== previousCursor : value.next_cursor === null);
}

export function mountBriefQueues({ menu, content, getClient, getSponsor, onOpen, onBack, onInvalidate, onChange }) {
  let active = null, items = [], page = null, busy = false, error = false, epoch = 0, viewer = null, observedAt = null;
  let labels = null, identity = null, title = null, view = null, ready = null;
  const prepare = () => ready ??= import(QUEUE_VIEW).then(module => {
    ({ briefQueueLabels: labels, briefQueueIdentity: identity, briefQueueTitle: title } = module);
    view = module.createBriefQueueView(menu, content);
  });
  const reset = () => { ++epoch; active = null; items = []; page = null; busy = false; error = false; viewer = null; observedAt = null; view?.clearList(); };
  const render = () => {
    onChange();
    if (active && view) view.renderList({ active, items, page, busy, error });
  };
  const load = async () => {
    if (!active || busy) return;
    const request = ++epoch, queue = active, sponsor = viewer, cursor = page?.next_cursor;
    busy = true; error = false; observedAt = null;
    await prepare();
    if (request !== epoch || sponsor !== getSponsor() || active !== queue) return;
    render();
    try {
      const client = await getClient();
      const value = await readWithDeadline(() => client.morningBriefQueue(queue, { ...(cursor ? { cursor } : {}) }));
      if (request !== epoch || sponsor !== getSponsor() || active !== queue) return;
      if (['joe', 'dell'].includes(value?.sponsor) && value.sponsor !== sponsor) { reset(); onInvalidate(); return; }
      if (!validPage(value, sponsor, cursor) || !value.items.every(row => present(identity(queue, row)) && present(title(queue, row)))) throw Error('Invalid queue page');
      if (new Set(value.items.map(row => identity(queue, row))).size !== value.items.length) throw Error('Duplicate queue identities');
      const seen = new Set(items.map(row => identity(queue, row)));
      const next = [...items, ...value.items.filter(row => !seen.has(identity(queue, row)))];
      if (next.length > value.total || value.has_more && (value.items.length === 0 || next.length >= value.total) || !value.has_more && next.length !== value.total) throw Error('Invalid queue coverage');
      items = next; page = value; observedAt = new Date().toISOString();
    } catch (failure) {
      if (request !== epoch || sponsor !== getSponsor() || active !== queue) return;
      if ([401, 403].includes(failure.status)) { reset(); onInvalidate(); return; }
      error = true;
    } finally {
      if (request === epoch && active === queue) { busy = false; render(); }
    }
  };
  menu.onclick = event => {
    const queue = event.target.closest('[data-brief-queue]')?.dataset.briefQueue;
    if (!labels || !Object.hasOwn(labels, queue) || !getSponsor()) return;
    reset(); active = queue; viewer = getSponsor(); onOpen(labels[queue]); load();
  };
  return {
    prepare,
    get active() { return active !== null; }, reset,
    get updated() { return { observedAt, error }; },
    refresh() {
      ++epoch; items = []; page = null; busy = false; error = false; observedAt = null;
      return load();
    },
    menu(facts) {
      if (!view) return;
      if (viewer && viewer !== getSponsor()) reset();
      view.renderMenu(facts);
    },
    click(event) {
      if (event.target.closest('[data-brief-queue-back]')) { reset(); onBack(); return true; }
      if (event.target.closest('[data-brief-queue-more]')) { load(); return true; }
      return active !== null;
    },
    dispose() { reset(); view?.dispose(); view = null; },
  };
}
