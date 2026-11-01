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
  let labels = null, identity = null, title = null, view = null, ready = null, menuFacts = null, chunkFailed = false, loadAttempt = 0;
  // A failed module stays in the document module map. The next attempt uses a
  // new query so the import actually runs again; the first attempt stays the
  // plain specifier Home may already have loaded.
  const queueModule = () => loadAttempt ? `${QUEUE_VIEW}?attempt=${loadAttempt}` : QUEUE_VIEW;
  const paintMenu = () => {
    if (!view) return;
    if (viewer && viewer !== getSponsor()) reset();
    view.renderMenu(menuFacts, active);
  };
  const showChunkFailure = () => {
    const doc = menu.ownerDocument;
    menu.replaceChildren();
    const note = doc.createElement('p');
    note.textContent = 'Work queues did not load.';
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.briefQueueRetry = '';
    button.textContent = 'Retry';
    menu.append(note, button);
  };
  const adopt = module => {
    ({ briefQueueLabels: labels, briefQueueIdentity: identity, briefQueueTitle: title } = module);
    if (!view) {
      menu.replaceChildren();
      view = module.createBriefQueueView(menu, content);
    }
    chunkFailed = false;
    paintMenu();
  };
  const prepare = () => {
    if (ready) return ready;
    if (chunkFailed) return Promise.resolve();
    let attempt;
    attempt = import(queueModule()).then(adopt).catch(failure => {
      if (ready !== attempt) throw failure;
      ready = null;
      chunkFailed = true;
      if (view) { view.dispose(); view = null; labels = null; identity = null; title = null; }
      showChunkFailure();
      throw failure;
    });
    ready = attempt;
    return attempt;
  };
  const reset = () => { ++epoch; active = null; items = []; page = null; busy = false; error = false; viewer = null; observedAt = null; view?.clearList(); };
  const render = () => {
    onChange();
    if (active && view) view.renderList({ active, items, page, busy, error });
  };
  const load = async () => {
    if (!active || busy) return;
    const request = ++epoch, queue = active, sponsor = viewer, cursor = page?.next_cursor;
    busy = true; error = false; observedAt = null;
    try { await prepare(); } catch { if (request === epoch && active === queue) { busy = false; render(); } return; }
    if (!view || request !== epoch || sponsor !== getSponsor() || active !== queue) {
      if (request === epoch && active === queue) { busy = false; render(); }
      return;
    }
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
  const openQueue = queue => {
    if (!labels || !Object.hasOwn(labels, queue) || !getSponsor()) return;
    reset(); active = queue; viewer = getSponsor(); onOpen(labels[queue]); load();
  };
  menu.onclick = event => {
    if (event.target.closest('[data-brief-queue-retry]')) {
      if (ready) return;
      loadAttempt += 1;
      chunkFailed = false;
      const note = menu.querySelector('p');
      if (note) note.textContent = 'Loading work queues…';
      prepare().catch(() => {});
      return;
    }
    const queue = event.target.closest('[data-brief-queue]')?.dataset.briefQueue;
    if (queue) openQueue(queue);
  };
  menu.onchange = event => {
    const queue = event.target.closest('[data-brief-queue-switch]')?.value;
    if (!queue || queue === active) return;
    openQueue(queue);
  };
  return {
    prepare,
    get active() { return active !== null; },
    get label() { return active && labels ? labels[active] || '' : ''; },
    get countLine() { return page ? `${items.length} of ${page.total}${page.total_scope === 'available_sources' ? ' from available sources' : ''}` : ''; },
    reset,
    get updated() { return { observedAt, error }; },
    refresh() {
      ++epoch; items = []; page = null; busy = false; error = false; observedAt = null;
      return load();
    },
    menu(facts) { menuFacts = facts; paintMenu(); },
    click(event) {
      if (event.target.closest('[data-brief-queue-back]')) { reset(); onBack(); return true; }
      if (event.target.closest('[data-brief-queue-more]')) { load(); return true; }
      return active !== null;
    },
    dispose() { reset(); view?.dispose(); view = null; ready = null; },
  };
}
