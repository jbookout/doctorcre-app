import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Tour = { id: string; deal_id: string | null; name: string; status: string };
type Library = { kind: 'loading' } | { kind: 'ready'; tours: Tour[] } | { kind: 'unavailable' };
type Selection = { kind: 'none' } | { kind: 'loading'; id: string } | { kind: 'ready'; tour: Tour } | { kind: 'creating' } | { kind: 'unavailable'; id: string };
type Client = {
  library(options: { signal: AbortSignal }): Promise<unknown>;
  tour(id: string, options: { signal: AbortSignal }): Promise<unknown>;
  readonly scope?: string | null;
  onScopeChange?(listener: () => void): () => void;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function parseTour(value: unknown): Tour {
  if (!record(value) || typeof value.id !== 'string' || !uuid.test(value.id) ||
      (value.deal_id != null && (typeof value.deal_id !== 'string' || !uuid.test(value.deal_id)))) throw Error('Invalid tour');
  return { id: value.id, deal_id: typeof value.deal_id === 'string' ? value.deal_id : null,
    name: typeof value.name === 'string' && value.name ? value.name : 'Untitled tour',
    status: typeof value.status === 'string' ? value.status.replaceAll('_', ' ') : 'draft' };
}

export function mountDealTours(element: Element, { dealId, client, initialTourId }: { dealId: string; client: Client; initialTourId?: string | null }) {
  if (!uuid.test(dealId)) throw Error('Invalid deal');
  const root = createRoot(element);
  let library: Library = { kind: 'loading' }, selection: Selection = { kind: 'none' };
  let disposed = false, generation = 0, detailGeneration = 0;
  let controller = new AbortController();
  let requested = initialTourId;
  let scope = client.scope;
  function invalidate() {
    departure?.finish(false);
    ++generation; ++detailGeneration; controller.abort();
    library = { kind: 'unavailable' }; selection = { kind: 'none' }; render();
  }
  const view = element.ownerDocument.defaultView;
  view?.addEventListener('doctorcre-session-invalidated', invalidate);
  const unsubscribe = client.onScopeChange?.(() => {
    const next = client.scope;
    if (scope != null && next !== scope) {
      invalidate();
    }
    scope = next;
  });
  function setUrl(id?: string, push = false) {
    if (!view || view.location.pathname !== '/deals') return;
    const url = new URL(view.location.href);
    url.searchParams.set('tab', 'tours');
    if (push && !url.searchParams.has('tour')) {
      view.history.replaceState(view.history.state, '', url);
      url.searchParams.set('tour', id || 'new');
      view.history.pushState({...view.history.state,doctorcreTourWorkspace:dealId}, '', url); return;
    }
    if (id) url.searchParams.set('tour', id); else url.searchParams.delete('tour');
    view.history.replaceState(view.history.state, '', url);
  }
  let departureApproved = false;
  function hasUnsavedChanges() {
    if (departureApproved) return false;
    const frame = element.querySelector('iframe');
    if (frame?.contentWindow) {
      const leaving = element.ownerDocument.createEvent('Event');
      leaving.initEvent('beforeunload', false, true);
      return !frame.contentWindow.dispatchEvent(leaving);
    }
    return false;
  }
  let departure: { promise: Promise<boolean>; finish(leave: boolean): void } | null = null;
  function confirmLeave(): Promise<boolean> {
    if (departure) return departure.promise;
    if (!hasUnsavedChanges()) return Promise.resolve(true);
    const dialog = element.ownerDocument.createElement('dialog');
    dialog.setAttribute('aria-label', 'Leave this tour?');
    dialog.className = 'dialog deal-tour-departure';
    const title = element.ownerDocument.createElement('h2'); title.textContent = 'Leave this tour?';
    const copy = element.ownerDocument.createElement('p'); copy.textContent = 'Your shortlist, route or form has unsaved changes. Keep editing to save them, or leave and discard these edits.';
    let resolve!: (leave: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    function finish(leave: boolean) { departureApproved = leave; dialog.close(); dialog.remove(); departure = null; resolve(leave); }
    departure = { promise, finish };
    for (const [label, leave] of [['Keep editing', false], ['Leave tour', true]] as const) {
      const button = element.ownerDocument.createElement('button');
      button.type = 'button'; button.className = 'btn'; button.textContent = label;
      button.addEventListener('click', () => finish(leave)); dialog.append(button);
    }
    dialog.prepend(title, copy);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    element.ownerDocument.body.append(dialog); dialog.showModal();
    return promise;
  }
  async function back() {
    if (!await confirmLeave() || disposed) return;
    if (view?.history.state?.doctorcreTourWorkspace === dealId) { view.history.back(); return; }
    departureApproved = false; ++detailGeneration; selection = { kind: 'none' }; setUrl(); render(); void refresh();
  }
  function receive(event: MessageEvent) {
    const frame = element.querySelector('iframe');
    if (!view || event.origin !== view.location.origin || !frame || event.source !== frame.contentWindow || !record(event.data) || event.data.generation !== detailGeneration) return;
    if (event.data.type === 'deal-tour-size' && typeof event.data.height === 'number' && Number.isFinite(event.data.height)) {
      frame.style.height = `${Math.max(700, Math.min(30000, event.data.height))}px`;
    }
    if (event.data.type === 'deal-tour-opened' && typeof event.data.id === 'string' && uuid.test(event.data.id)) setUrl(event.data.id);
    if (event.data.type === 'deal-tour-invalidated') invalidate();
  }
  view?.addEventListener('message', receive);
  function render() {
    if (disposed) return;
    flushSync(() => root.render(<section className="deal-tours" aria-label="Deal tours">
      <h2>Properties &amp; tours</h2>
      <p>Plan and review the shortlist, route and packet for this deal.</p>
      {(selection.kind === 'ready' || selection.kind === 'creating') ? <>
        <button type="button" className="btn btn-quiet" data-back-tours onClick={back}>Back to deal tours</button>
        <iframe title="Tour shortlist, route and packet" src={`/tours/route-editor.html?embedded=1&deal=${encodeURIComponent(dealId)}&generation=${detailGeneration}${selection.kind === 'ready' ? `&tour=${encodeURIComponent(selection.tour.id)}` : ''}`}
          style={{ width: '100%', minHeight: 700, border: 0, display: 'block' }} />
      </> : <><div className="deal-tour-actions"><button type="button" className="btn" data-start-tour onClick={startCreation}>Start a tour</button>
        <button type="button" className="btn btn-quiet" data-refresh-tours onClick={() => void refresh()}>Refresh tours</button></div>
      <div aria-live="polite">
        {library.kind === 'loading' && <p>Loading tours…</p>}
        {library.kind === 'unavailable' && <p>Tours unavailable. Refresh to try again.</p>}
        {library.kind === 'ready' && (library.tours.length ? <ul className="deal-tour-list">{library.tours.map(tour => <li key={tour.id}>
          <button type="button" className="btn btn-quiet" data-open-tour={tour.id} onClick={() => void open(tour.id)}>{tour.name}</button><span>{tour.status}</span>
        </li>)}</ul> : <p>No tours for this deal. Start a tour to select properties.</p>)}
        {selection.kind === 'loading' && <p>Opening tour…</p>}
        {selection.kind === 'unavailable' && <p>Tour not available. <button type="button" className="btn btn-quiet" onClick={() => { if (selection.kind === 'unavailable') void open(selection.id); }}>Retry tour</button></p>}
      </div></>}
    </section>));
  }
  function startCreation() {
    departureApproved = false; ++detailGeneration; requested = null; selection = { kind: 'creating' }; setUrl('new',true); render();
  }
  async function refresh() {
    if (selection.kind === 'ready' || selection.kind === 'creating') return;
    const ticket = ++generation; ++detailGeneration; controller.abort(); controller = new AbortController();
    library = { kind: 'loading' }; selection = { kind: 'none' }; render();
    try {
      const rows = await client.library({ signal: controller.signal });
      if (disposed || ticket !== generation) return;
      if (!Array.isArray(rows)) throw Error('Invalid library');
      library = { kind: 'ready', tours: rows.map(parseTour).filter(tour => tour.deal_id === dealId) };
    } catch { if (disposed || ticket !== generation) return; library = { kind: 'unavailable' }; }
    render();
    if (library.kind === 'ready' && requested) {
      const id = requested; requested = null;
      if (!id) return;
      if (id === 'new') startCreation();
      else if (uuid.test(id)) await open(id);
    }
  }
  async function open(id: string) {
    const ticket = ++detailGeneration;
    selection = { kind: 'loading', id }; render();
    try {
      const value = await client.tour(id, { signal: controller.signal });
      if (disposed || ticket !== detailGeneration) return;
      const tour = parseTour(value);
      if (tour.id !== id || tour.deal_id !== dealId || !record(value) || !Array.isArray(value.stops)) throw Error('Unavailable tour');
      selection = { kind: 'ready', tour }; setUrl(id,true);
    } catch { if (disposed || ticket !== detailGeneration) return; selection = { kind: 'unavailable', id }; }
    render();
  }
  void refresh();
  return { refresh, hasUnsavedChanges, confirmLeave, dispose() { departure?.finish(false); disposed = true; ++generation; ++detailGeneration; controller.abort(); unsubscribe?.(); view?.removeEventListener('message', receive); view?.removeEventListener('doctorcre-session-invalidated', invalidate); root.unmount(); } };
}
