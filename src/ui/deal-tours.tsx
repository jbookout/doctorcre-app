import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Tour = { id: string; deal_id: string | null; name: string; status: string };
type Detail = Tour & { stops: string[] };
type Library = { kind: 'loading' } | { kind: 'ready'; tours: Tour[] } | { kind: 'unavailable' };
type Selection = { kind: 'none' } | { kind: 'loading'; id: string } | { kind: 'ready'; tour: Detail } | { kind: 'unavailable'; id: string };
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
  const editor = (id?: string) => `/tours/route-editor.html?${id ? `tour=${encodeURIComponent(id)}&` : ''}deal=${encodeURIComponent(dealId)}`;
  function render() {
    if (disposed) return;
    flushSync(() => root.render(<section className="deal-tours" aria-label="Deal tours">
      <h2>Properties &amp; tours</h2>
      <p>Plan and review the shortlist, route and packet for this deal.</p>
      <div className="deal-tour-actions"><a className="btn" data-start-tour href={editor()}>Start a tour</a>
        <button type="button" className="btn btn-quiet" data-refresh-tours onClick={() => void refresh()}>Refresh tours</button></div>
      <div aria-live="polite">
        {library.kind === 'loading' && <p>Loading tours…</p>}
        {library.kind === 'unavailable' && <p>Tours unavailable. Refresh to try again.</p>}
        {library.kind === 'ready' && (library.tours.length ? <ul className="deal-tour-list">{library.tours.map(tour => <li key={tour.id}>
          <button type="button" className="btn btn-quiet" data-open-tour={tour.id} onClick={() => void open(tour.id)}>{tour.name}</button><span>{tour.status}</span>
        </li>)}</ul> : <p>No tours for this deal. Start a tour to select properties.</p>)}
        {selection.kind === 'loading' && <p>Opening tour…</p>}
        {selection.kind === 'unavailable' && <p>Tour not available. <button type="button" className="btn btn-quiet" onClick={() => { if (selection.kind === 'unavailable') void open(selection.id); }}>Retry tour</button></p>}
        {selection.kind === 'ready' && <section aria-label="Selected tour"><h3>{selection.tour.name}</h3>
          {selection.tour.stops.length ? <ol>{selection.tour.stops.map((stop, index) => <li key={index}>{stop}</li>)}</ol> : <p>No properties selected.</p>}
          <a className="btn" data-edit-tour href={editor(selection.tour.id)}>Edit shortlist, route and packet</a>
        </section>}
      </div>
    </section>));
  }
  async function refresh() {
    const selected = selection.kind === 'ready' ? selection.tour.id : selection.kind === 'unavailable' ? selection.id : null;
    const ticket = ++generation; ++detailGeneration; controller.abort(); controller = new AbortController();
    library = { kind: 'loading' }; selection = { kind: 'none' }; render();
    try {
      const rows = await client.library({ signal: controller.signal });
      if (disposed || ticket !== generation) return;
      if (!Array.isArray(rows)) throw Error('Invalid library');
      library = { kind: 'ready', tours: rows.map(parseTour).filter(tour => tour.deal_id === dealId) };
    } catch { if (disposed || ticket !== generation) return; library = { kind: 'unavailable' }; }
    render();
    if (library.kind === 'ready' && (requested || selected)) {
      const id = requested || selected; requested = null;
      if (!id) return;
      if (uuid.test(id)) await open(id);
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
      const stops = value.stops.filter(stop => record(stop) && stop.stop_state !== 'excluded').map(stop => {
        if (!record(stop)) throw Error('Invalid stop');
        return typeof stop.property_name === 'string' ? stop.property_name : typeof stop.name === 'string' ? stop.name : 'Selected property';
      });
      selection = { kind: 'ready', tour: { ...tour, stops } };
    } catch { if (disposed || ticket !== detailGeneration) return; selection = { kind: 'unavailable', id }; }
    render();
  }
  void refresh();
  return { refresh, dispose() { disposed = true; ++generation; ++detailGeneration; controller.abort(); unsubscribe?.(); view?.removeEventListener('doctorcre-session-invalidated', invalidate); root.unmount(); } };
}
