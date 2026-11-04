import { onDialogClosed } from '../js/dialog-lifecycle.js';
import { mountAutoRefresh, updatedLabel } from '../js/auto-refresh.mjs';
import { createPlannerClient, validateTourList, validateTourDetail } from './planner-client.js';
import { tourGroups } from './planner-model.js';
import { cheatSheetText, tourDisplayName } from './tour-format.js';
import { pageDocContext, publishDocRead, selectDocRecord, setDocFilters } from '../js/doc-context.js';

export function mountPlanner({ document, window, api = createPlannerClient() }) {
  const $ = selector => document.querySelector(selector);
  let tours = [], generation = 0, detailGeneration = 0, disposed = false, scope = api.scope, opener, activeTourId;
  const node = (tag, text) => { const value = document.createElement(tag); value.textContent = text; return value; };
  const workspace = tour => `/deals?deal=${encodeURIComponent(tour.deal_id)}&tab=tours&tour=${encodeURIComponent(tour.id)}`;
  function render() {
    const groups = tourGroups(tours, $('#tour-filter').value);
    publishDocRead('tourLibrary', { tours: [...groups.upcoming, ...groups.history] });
    for (const group of ['upcoming', 'history']) {
      const list = $(`#${group}-tours`); list.replaceChildren();
      for (const tour of groups[group]) {
        const row = node('li', '');
        const link = node('a', tourDisplayName(tour.name)); link.className = 'tour-button'; link.dataset.tourId = tour.id;
        link.href = tour.deal_id ? workspace(tour) : `/tours/route-editor.html?tour=${encodeURIComponent(tour.id)}`;
        if (!tour.deal_id) link.addEventListener('click', event => { event.preventDefault(); void openTour(tour.id, link); });
        row.append(link, node('span', tour.deal_name || (tour.deal_id ? 'Open deal workspace' : 'Legacy tour')));
        list.append(row);
      }
      if (!groups[group].length) list.append(node('li', $('#tour-filter').value ? 'No matching tours' : group === 'upcoming' ? 'No upcoming tours' : 'No past tours'));
    }
  }
  function clear() {
    pageDocContext?.clear();
    ++generation; ++detailGeneration; tours = []; render();
    $('#detail-content').replaceChildren(); $('#detail-title').textContent = 'Tour'; $('#tour-dialog').close();
    $('#tour-library-state').textContent = 'Sign in to continue.';
  }
  const unsubscribe = api.onScopeChange?.(() => { if (scope != null && api.scope !== scope) clear(); scope = api.scope; });
  window.addEventListener('doctorcre-session-invalidated', clear);
  async function openTour(id, trigger) {
    activeTourId = id;
    selectDocRecord('tour', id);
    const docTicket = pageDocContext?.begin('tourDetail', [id]);
    opener = trigger; const ticket = ++detailGeneration;
    $('#detail-content').replaceChildren(); $('#detail-title').textContent = 'Tour'; $('#detail-message').textContent = 'Opening tour…';
    if (!$('#tour-dialog').open) $('#tour-dialog').showModal();
    try {
      const tour = validateTourDetail(await api.tour(id), id);
      if (disposed || ticket !== detailGeneration) return;
      if (tour.deal_id) { window.location.assign(workspace(tour)); return; }
      $('#detail-title').textContent = tourDisplayName(tour.name);
      pageDocContext?.finish(docTicket, tour);
      const list = node('ol', '');
      for (const stop of tour.stops) if (stop.stop_state !== 'excluded') list.append(node('li', stop.property_name || stop.name || 'Property'));
      $('#detail-content').append(list, node('p', cheatSheetText(tour.cheat_sheet?.content)));
      const link = node('a', 'Open legacy itinerary'); link.href = `/tours/route-editor.html?tour=${encodeURIComponent(id)}`;
      $('#detail-content').append(link); $('#detail-message').textContent = '';
    } catch (error) { if (!disposed && ticket === detailGeneration) { pageDocContext?.fail(docTicket,error); if (error.code === 'authentication_required') pageDocContext?.clear(); $('#detail-message').textContent = 'Tour temporarily unavailable. Close and try again.'; } }
  }
  async function refresh({ signal } = {}) {
    const ticket = ++generation; $('#planner-updated').textContent = 'Updating…';
    const docTicket = pageDocContext?.begin('tourLibrary');
    try {
      const rows = validateTourList(await api.library({ signal }));
      if (disposed || signal?.aborted || ticket !== generation) return;
      tours = rows; pageDocContext?.finish(docTicket,{tours}); render(); $('#tour-library-state').textContent = ''; $('#planner-updated').textContent = updatedLabel(new Date());
      if (activeTourId && $('#tour-dialog').open) await openTour(activeTourId,opener);
    } catch (error) {
      if (!disposed && ticket === generation) { tours = []; render(); pageDocContext?.fail(docTicket,error); if (error.code === 'authentication_required') pageDocContext?.clear(); $('#planner-updated').textContent = 'Unavailable'; $('#tour-library-state').textContent = 'Tours unavailable. Refresh to try again.'; }
    }
  }
  const close = () => { ++detailGeneration; activeTourId = null; selectDocRecord(null, null); $('#tour-dialog').close(); opener?.focus(); };
  $('#detail-close').addEventListener('click', close);
  $('#tour-dialog').addEventListener('cancel', event => { event.preventDefault(); close(); });
  const closed = onDialogClosed($('#tour-dialog'), () => { ++detailGeneration; selectDocRecord(null, null); pageDocContext?.release('tourDetail'); });
  $('#tour-filter').addEventListener('input', () => { setDocFilters({query:$('#tour-filter').value}); render(); });
  const auto = mountAutoRefresh({ document, window, refresh });
  $('#planner-refresh').addEventListener('click', () => void auto.refresh());
  const ready = refresh().then(() => {
    const id = new URLSearchParams(window.location.search).get('tour'), tour = tours.find(tour => tour.id === id);
    if (tour?.deal_id) window.location.replace(workspace(tour));
    else if (id) return openTour(id);
  });
  return { ready, refresh, dispose() { disposed = true; ++generation; ++detailGeneration; unsubscribe?.(); closed?.(); auto.dispose(); window.removeEventListener('doctorcre-session-invalidated', clear); } };
}

if (typeof document !== 'undefined' && document.querySelector('#tour-filter')) mountPlanner({ document, window });
