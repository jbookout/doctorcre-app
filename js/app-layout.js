import { mountSliceSections } from './slice-registration.js';
import { scopedDeals } from './home-dashboard-model.js';
import { localToday, toDay } from './calendar-model.js';
import { createClient } from './client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAutoRefresh, readWithDeadline } from './auto-refresh.mjs';
import { createFeedProgress, observeChangeBatch, ingestChangeEvents, receiptViews } from './change-receipts.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = value => { const date = new Date(value || ''); return Number.isFinite(date.valueOf()) ? date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }) : '—'; };

// Build validation and runtime use the same layout targets.
export function createAppLayout(root, title = '') {
  const layout = root.createElement('div');
  layout.id = 'appLayout';
  layout.className = 'app-layout';
  layout.innerHTML = `<aside id="appSidebar" class="app-layout-sidebar" aria-label="${escape(title)} workspace"><div class="app-layout-sidebar-head"><h2>${escape(title)}</h2><button type="button" data-layout-close="sidebar" aria-label="Close workspace">‹</button></div><div id="appSidebarSlot"></div><section class="app-layout-working"><h3>Needs attention</h3><div id="appWorkingList">Updating…</div></section></aside>
    <div class="app-layout-center"><div class="app-layout-tabbar"><button type="button" id="appSidebarToggle" aria-label="Workspace sidebar" aria-controls="appSidebar" aria-expanded="false" title="Workspace sidebar">☷</button><div id="appTabsSlot" class="app-layout-tabs" aria-label="${escape(title)} views"></div><button type="button" id="appTodayToggle" aria-label="Today sidebar" aria-controls="appToday" aria-expanded="true" title="Today">◷</button></div><div id="appMainSlot" class="app-layout-main"></div></div>
    <aside id="appToday" class="app-layout-today" aria-labelledby="appTodayTitle"><div class="app-layout-sidebar-head"><h2 id="appTodayTitle">Today</h2><button type="button" data-layout-close="today" aria-label="Close Today">›</button></div><section><h3>Needs you</h3><div id="appTodayNeeds">Updating…</div></section><section><h3>Next up</h3><div id="appTodayNext">Updating…</div></section><section><h3>Recent moves</h3><div id="appTodayMoves"><span class="app-layout-empty">—</span></div></section></aside>
    <button class="app-layout-scrim" id="appDrawerScrim" type="button" aria-label="Close sidebar" hidden></button>`;
  const status = root.createElement('footer');
  status.className = 'app-layout-status';
  status.innerHTML = '<span><time id="appSyncTime" title="Last sync">—</time><button type="button" id="appSyncRefresh" aria-label="Refresh workspace" title="Refresh">↻</button></span><span title="Last new-lead search">⌕ <time id="appLeadSearchTime">—</time></span><span id="appConnection" class="app-layout-health" data-state="unknown" role="img" aria-label="Connection unknown" title="Connection unknown"></span><div id="appStatusSlot"></div>';
  return { layout, status };
}

// Slots contain the page's original nodes, not copies. IDs, listeners, drafts and
// lazy tab reads therefore retain their existing owner across layout changes.
export function mountAppLayout(root, host, pathname, slices = []) {
  if (root.getElementById('appLayout')) return;
  const win = root.defaultView || globalThis.window;
  const pageKey = pathname === '/deals' ? '/deals' : pathname;
  const boardPage = ['/leads','/deals','/pipeline'].includes(pathname);
  const title = pathname === '/deals' ? 'Local Deals' : root.querySelector('main h1, .room-wordmark, .page-kicker')?.textContent.trim().replace(/Loading$/, '').trim() || root.title.split('·')[0].trim();
  const { layout, status } = createAppLayout(root, title);
  host.after(layout, status);
  mountSliceSections(root, pathname, slices);
  const main = layout.querySelector('#appMainSlot');
  // Modals and fixed feedback belong to the viewport, outside page regions.
  root.querySelectorAll('.record-backdrop, aside.record-panel, .room-toast').forEach(node => root.body.append(node));
  // Lift declarative page slots before putting the remaining page into main.
  for (const node of [...root.querySelectorAll('[data-layout-slot]')]) {
    const slot = node.dataset.layoutSlot;
    const target = slot === 'tabs' ? layout.querySelector('#appTabsSlot') : slot === 'sidebar' ? layout.querySelector('#appSidebarSlot') : slot === 'moves' ? layout.querySelector('#appTodayMoves') : status.querySelector('#appStatusSlot');
    if (slot === 'moves') target.replaceChildren();
    target.append(node);
  }
  for (const node of [...root.body.children]) {
    if (node === host || node === layout || node === status || ['SCRIPT','DIALOG'].includes(node.tagName) || node.matches('.skip, .doc-fab, .doc-chat, .toast, .receipt-dock, .record-backdrop, aside.record-panel, .room-toast')) continue;
    if (node.matches('footer')) status.querySelector('#appStatusSlot').append(node);
    else main.append(node);
  }
  root.body.classList.add('has-app-layout');
  const pageOwnsMoves = Boolean(layout.querySelector('#appTodayMoves [data-layout-slot="moves"]'));
  const phone = win.matchMedia('(max-width: 760px)');
  let sidebar = !boardPage, today = true, drawer = null;
  try { const saved = win.localStorage.getItem(`doctorcre:sidebar:${pageKey}`); if (saved !== null) sidebar = saved === 'open'; today = win.localStorage.getItem('doctorcre:today') !== 'closed'; } catch {}
  const sidebarToggle = layout.querySelector('#appSidebarToggle'), todayToggle = layout.querySelector('#appTodayToggle');
  const paint = () => {
    layout.dataset.sidebar = sidebar ? 'open' : 'closed'; layout.dataset.today = today ? 'open' : 'closed'; layout.dataset.drawer = drawer || '';
    const leftOpen = phone.matches ? drawer === 'sidebar' : sidebar;
    const rightOpen = phone.matches ? drawer === 'today' : today;
    layout.querySelector('#appSidebar').inert = !leftOpen;
    layout.querySelector('#appToday').inert = !rightOpen;
    sidebarToggle.setAttribute('aria-expanded', String(leftOpen)); todayToggle.setAttribute('aria-expanded', String(rightOpen));
    layout.querySelector('#appDrawerScrim').hidden = !phone.matches || !drawer;
  };
  const openDrawer = region => {
    drawer = region;
    paint();
    layout.querySelector(`#${region === 'sidebar' ? 'appSidebar' : 'appToday'} button`).focus();
  };
  const toggle = region => {
    if (phone.matches) { if (drawer === region) closeDrawer(); else openDrawer(region); return; }
    else if (region === 'sidebar') { sidebar = !sidebar; try { win.localStorage.setItem(`doctorcre:sidebar:${pageKey}`, sidebar ? 'open' : 'closed'); } catch {} }
    else { today = !today; try { win.localStorage.setItem('doctorcre:today', today ? 'open' : 'closed'); } catch {} }
    paint();
  };
  const closeDrawer = () => { const previous = drawer; drawer = null; paint(); if (previous) (previous === 'sidebar' ? sidebarToggle : todayToggle).focus(); };
  sidebarToggle.onclick = () => toggle('sidebar'); todayToggle.onclick = () => toggle('today');
  layout.querySelector('#appDrawerScrim').onclick = closeDrawer;
  layout.querySelectorAll('[data-layout-close]').forEach(button => button.onclick = () => phone.matches ? closeDrawer() : toggle(button.dataset.layoutClose));
  root.addEventListener('keydown', event => {
    if (!phone.matches || !drawer || root.querySelector('dialog:modal')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
    if (event.key === 'Tab') {
      const panel = layout.querySelector(drawer === 'sidebar' ? '#appSidebar' : '#appToday');
      const focusable = [...panel.querySelectorAll('a,button,input,select,textarea,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  phone.addEventListener('change', () => { drawer = null; paint(); });
  paint();
  root.addEventListener('doctorcre:open-today', () => { if (phone.matches) openDrawer('today'); else { today = true; paint(); } });
  // Page tab controllers retain selection and lazy reads. Give groups without
  // their own roving focus the same left/right keyboard affordance.
  const tabs = layout.querySelector('#appTabsSlot');
  const showSelectedTab = () => {
    const selected = tabs.querySelector('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]');
    if (!selected) return;
    const edge = selected.getBoundingClientRect(), viewport = tabs.getBoundingClientRect();
    if (edge.right > viewport.right) tabs.scrollLeft += edge.right - viewport.right;
    else if (edge.left < viewport.left) tabs.scrollLeft -= viewport.left - edge.left;
  };
  win.requestAnimationFrame(showSelectedTab);
  phone.addEventListener('change', showSelectedTab);
  tabs.addEventListener('keydown', event => {
    if (event.target.closest('[role="tablist"]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const items = [...tabs.querySelectorAll('a,button')].filter(n => !n.disabled && n.getClientRects().length);
    const i = items.indexOf(root.activeElement); if (i < 0) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });
  const boot = resolveDealroomBoot(globalThis.location);
  let client, feedActor = null, cursor = null, feed = createFeedProgress(), receipts = [];
  const resetFeed = () => { feedActor = null; cursor = null; feed = createFeedProgress(); receipts = []; if (!pageOwnsMoves) renderMoves(); };
  const row = (item, extra = '') => `<button type="button" class="app-layout-item" data-layout-deal="${escape(item.subject_id || item.id)}"><strong>${escape(item.subject_name || item.name)}</strong>${extra ? `<span>${escape(extra)}</span>` : ''}</button>`;
  const render = (target, html) => { const node = layout.querySelector(target); if (node.innerHTML !== html) { const id = node.contains(root.activeElement) ? root.activeElement.dataset.layoutDeal : null; node.innerHTML = html; if (id) [...node.querySelectorAll('button')].find(b => b.dataset.layoutDeal === id)?.focus(); } };
  const unavailable = '<span class="app-layout-empty">Unavailable</span>';
  const empty = '<span class="app-layout-empty">—</span>';
  const renderMoves = () => {
    const moves = feed.caught_up ? receiptViews(receipts).slice(0,6) : [];
    render('#appTodayMoves', moves.map(move => row({ id:move.deal_id, name:move.deal_name }, `${move.actor === 'doc' ? 'Doc · ' : ''}${move.action}${move.after ? ` → ${move.after}` : ''} · ${time(move.recorded_at)}`)).join('') || empty);
  };
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const optionalText = value => value == null || typeof value === 'string';
  const validBoard = value => scopedDeals(value, 'team') !== null
    && text(value.actor) && value.deals.every(d => text(d.name)
      && ['phase','operating_state','owner','next_step','next_date'].every(k => optionalText(d[k]))
      && (d.attention == null || typeof d.attention === 'boolean')
      && (!d.next_date || toDay(d.next_date)));
  const validTriage = value => Array.isArray(value?.items) && value.items.every(i => i
    && text(i.subject_type) && text(i.subject_id) && text(i.subject_name)
    && optionalText(i.what) && optionalText(i.due_on) && (!i.due_on || toDay(i.due_on)));
  const connection = connected => {
    const dot = status.querySelector('#appConnection'); dot.dataset.state = connected ? 'healthy' : 'unknown';
    dot.setAttribute('aria-label', connected ? 'Connection available' : 'Connection unavailable'); dot.title = dot.getAttribute('aria-label');
  };
  const refresh = async ({ signal } = {}) => {
    try { client ||= await createClient(boot.mode, boot.options); }
    catch { resetFeed(); connection(false); render('#appTodayNeeds', unavailable); render('#appTodayNext', unavailable); render('#appWorkingList', unavailable); if (!pageOwnsMoves) render('#appTodayMoves', unavailable); return; }
    const [board, triage] = await Promise.allSettled([
      readWithDeadline(() => client.getBoard({ workspace:'all' }), { signal }),
      readWithDeadline(() => client.todayTriage(), { signal }),
    ]);
    if (signal?.aborted) return;
    const connected = board.status === 'fulfilled' && validBoard(board.value);
    const triageValid = triage.status === 'fulfilled' && validTriage(triage.value);
    connection(connected && triageValid);
    const items = triageValid ? triage.value.items : null;
    render('#appTodayNext', items ? items.filter(i => i.subject_type === 'deal').slice(0,6).map(i => row(i,`${i.what || 'Due'} · ${i.due_on || ''}`)).join('') || empty : unavailable);
    if (connected) {
      const value = board.value;
      if (feedActor !== value.actor) resetFeed();
      feedActor = value.actor;
      // Retained receipts have the same authorization scope as newly read ones.
      const authorized = new Map(value.deals.map(deal => [deal.id, deal.name]));
      receipts = receipts.filter(receipt => authorized.has(receipt.deal_id))
        .map(receipt => ({ ...receipt, deal_name: authorized.get(receipt.deal_id) }));
      if (!pageOwnsMoves) renderMoves();
      if (triageValid) {
        const observed = new Date().toISOString();
        status.querySelector('#appSyncTime').textContent = time(observed);
        status.querySelector('#appSyncTime').dateTime = observed;
      }
      const active = scopedDeals(value, 'team');
      const needs = scopedDeals(value, 'mine').filter(d => d.attention || d.next_date && toDay(d.next_date) <= localToday());
      render('#appTodayNeeds', needs.slice(0,6).map(d => row(d,d.next_step)).join('') || empty);
      render('#appWorkingList', active.filter(d => d.attention).slice(0,8).map(d => row(d,d.next_step)).join('') || empty);
      if (!pageOwnsMoves) {
        try {
          // The existing feed starts with history. Never present its oldest
          // page as recent; advance bounded pages until it reaches the present.
          for (let page = 0; page < 4; page++) {
            const changes = await readWithDeadline(() => client.getChanges(cursor), { signal });
            if (signal?.aborted) return;
            if (!Array.isArray(changes?.events)) throw new Error('Invalid change response');
            const batch = changes.events;
            feed = observeChangeBatch(feed, batch);
            receipts = ingestChangeEvents(receipts, batch, { dealName:id => value.deals.find(d => d.id === id)?.name });
            cursor = changes.cursor ?? cursor;
            if (feed.caught_up) break;
          }
          renderMoves();
        } catch { render('#appTodayMoves', unavailable); }
      }
    } else { resetFeed(); render('#appTodayNeeds', unavailable); render('#appWorkingList', unavailable); if (!pageOwnsMoves) render('#appTodayMoves', unavailable); }
  };
  layout.addEventListener('click', event => {
    const item = event.target.closest('[data-layout-deal]'); if (!item) return;
    const id = item.dataset.layoutDeal;
    const existing = [...root.querySelectorAll('.deal-link, .kanban-card')].find(n => n.dataset.id === id || n.dataset.openDeal === id || n.dataset.deal === id);
    if (existing) { closeDrawer(); existing.click(); }
    else globalThis.location.assign(`/deals?deal=${encodeURIComponent(id)}`);
  });
  const auto = mountAutoRefresh({ document:root, window:win, refresh, intervalMs:30_000 });
  status.querySelector('#appSyncRefresh').onclick = () => { auto.refresh(); root.querySelectorAll('[data-layout-refresh]').forEach(button => button.click()); };
  auto.refresh();
  win.addEventListener('pagehide', event => { if (!event.persisted) auto.dispose(); });
}
