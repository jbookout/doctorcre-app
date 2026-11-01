import { createPageBudget } from './read-budget.mjs';
import { mountLocalTicker } from './visibility-poll.mjs';
import { todayMove } from './today-moves.mjs';
import { briefOwnerLabel, filterBriefOwners, mountBriefOwnerFilter } from './brief-owner-filter.js';
import { normalizeBrief } from './morning-brief-model.js';
import { TOUCH_LAYOUT } from './touch-layout.js';
import { mostOverdueFirst, needsAttention, overdueActionRows, overdueLabel, overdueSince, scopedDeals } from './deal-review-model.js';
import { businessDay } from './business-date.js';
import { createClient } from './client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAutoRefresh, readWithDeadline } from './auto-refresh.mjs';
import { createFeedProgress, observeChangeBatch, ingestChangeEvents, receiptViews, escapeText as escape } from './change-receipts.mjs';

import { localToday, shortDay, toDay } from './calendar-model.js';
const time = value => { const date = new Date(value || ''); return Number.isFinite(date.valueOf()) ? date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }) : '—'; };

export function createAppLayout(root, title = '') {
  const layout = root.createElement('div');
  layout.id = 'appLayout';
  layout.className = 'app-layout';
  layout.innerHTML = `<aside id="appSidebar" class="app-layout-sidebar" aria-label="${escape(title)} workspace"><div class="app-layout-sidebar-head"><h2>${escape(title)}</h2><button type="button" data-layout-close="sidebar" aria-label="Close workspace">‹</button></div><div id="appSidebarSlot"></div><section class="app-layout-working"><h3>Overdue</h3><div id="appWorkingList">Updating…</div></section></aside>
    <div class="app-layout-center"><div class="app-layout-tabbar"><button type="button" id="appSidebarToggle" aria-label="Workspace sidebar" aria-controls="appSidebar" aria-expanded="false" title="Workspace sidebar">☷</button><div id="appTabsSlot" class="app-layout-tabs" role="group" aria-label="${escape(title)} views"></div><button type="button" id="appTodayToggle" aria-label="Today sidebar" aria-controls="appToday" aria-expanded="true" title="Today">◷</button></div><div id="appMainSlot" class="app-layout-main"></div></div>
    <aside id="appToday" class="app-layout-today" aria-labelledby="appTodayTitle"><div class="app-layout-sidebar-head"><h2 id="appTodayTitle">Today</h2><button type="button" data-layout-close="today" aria-label="Close Today">›</button></div><div id="appTodayOwners"></div><p id="appTodayReadStatus" class="app-layout-empty" role="status" hidden></p><button type="button" id="appTodayRetry" class="app-layout-item" hidden>Retry Today</button><section><h3>Overdue</h3><div id="appTodayNeeds">Updating…</div></section><section><h3>Next up</h3><div id="appTodayNext">Updating…</div><button type="button" id="appTodayShowAll" class="app-layout-item app-layout-show-all" aria-controls="appTodayNext" hidden>Show all</button></section><section><h3>Recent moves</h3><div id="appTodayMoves"><span class="app-layout-empty">—</span></div></section></aside>
    <button class="app-layout-scrim" id="appDrawerScrim" type="button" aria-label="Close sidebar" hidden></button>`;
  const status = root.createElement('footer');
  status.className = 'app-layout-status';
  status.innerHTML = '<span><time id="appSyncTime" title="Last sync">—</time><button type="button" id="appSyncRefresh" aria-label="Refresh workspace" title="Refresh">↻</button></span><span title="Last new-lead search">⌕ <time id="appLeadSearchTime">—</time></span><span id="appConnection" class="app-layout-health" data-state="unknown" role="img" aria-label="Connection unknown" title="Connection unknown"></span><div id="appStatusSlot"></div>';
  return { layout, status };
}

// Slots contain the page's original nodes, not copies. IDs, listeners, drafts and
// lazy tab reads therefore retain their existing owner across layout changes.
export function mountAppLayout(root, host, pathname) {
  if (root.getElementById('appLayout')) return;
  const win = root.defaultView || globalThis.window;
  const pageKey = pathname === '/deals' ? '/deals' : pathname;
  const boardPage = ['/leads','/deals','/pipeline'].includes(pathname);
  const vendorDirectory = pathname === '/vendors';
  const progressPage = pathname === '/control-room/progress' || pathname.startsWith('/control-room/progress/board/');
  const title = progressPage ? 'Progress' : pathname.startsWith('/control-room') ? 'Control Room' : pathname === '/vendors' ? 'Vendors' : pathname === '/clients' ? 'Clients' : pathname === '/deals' ? 'Local Deals' : root.querySelector('main h1, .room-wordmark, .page-kicker')?.textContent.trim().replace(/Loading$/, '').trim() || root.title.split('·')[0].trim();
  const { layout, status } = createAppLayout(root, title);
  if (vendorDirectory) layout.querySelector('.app-layout-working').remove();
  host.after(layout, status);
  if (pathname === '/') layout.querySelector('.app-layout-working').hidden = true;
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
    if (node === host || node === layout || node === status || ['SCRIPT','DIALOG'].includes(node.tagName) || node.matches('.app-shell-account-menu, .skip, .toast, .receipt-dock, .record-backdrop, aside.record-panel, .room-toast')) continue;
    if (node.matches('footer')) status.querySelector('#appStatusSlot').append(node);
    else main.append(node);
  }
  root.body.classList.add('has-app-layout');
  // A page that brings its own freshness and refresh owns the band's one clock and one refresh.
  const pageRefresh = status.querySelector('#appStatusSlot [data-layout-refresh]');
  status.toggleAttribute('data-page-freshness', Boolean(pageRefresh));
  const pageOwnsMoves = Boolean(layout.querySelector('#appTodayMoves [data-layout-slot="moves"]'));
  const phone = win.matchMedia(pathname === "/leads" ? "(max-width:1023px)" : TOUCH_LAYOUT);
  const itineraryPage = Boolean(root.getElementById('accepted-itinerary'));
  const dealBoard = pathname === '/deals' && root.body.classList.contains('dealroom-page');
  let sidebar = !boardPage && !itineraryPage && !vendorDirectory, today = !dealBoard && !itineraryPage, drawer = null;
  let drawerOpener = null;
  const background = new Map();
  try { const saved = win.localStorage.getItem(`doctorcre:sidebar:${pageKey}`); if (saved !== null) sidebar = saved === 'open'; const savedToday = win.localStorage.getItem(dealBoard ? 'doctorcre:today:/deals' : 'doctorcre:today'); if (savedToday !== null) today = savedToday !== 'closed'; } catch {}
  const sidebarToggle = layout.querySelector('#appSidebarToggle'), todayToggle = layout.querySelector('#appTodayToggle');
  const paint = () => {
    layout.dataset.sidebar = sidebar ? 'open' : 'closed'; layout.dataset.today = today ? 'open' : 'closed'; layout.dataset.drawer = drawer || '';
    const leftOpen = phone.matches ? drawer === 'sidebar' : sidebar;
    const rightOpen = phone.matches ? drawer === 'today' : today;
    layout.querySelector('#appSidebar').inert = !leftOpen;
    layout.querySelector('#appToday').inert = !rightOpen;
    sidebarToggle.setAttribute('aria-expanded', String(leftOpen)); todayToggle.setAttribute('aria-expanded', String(rightOpen));
    layout.querySelector('#appDrawerScrim').hidden = !phone.matches || !drawer;
    if (phone.matches && drawer) {
      for (const node of [layout.querySelector('.app-layout-center'), ...root.body.children]) {
        if (node === layout || node.tagName === 'DIALOG') continue;
        if (!background.has(node)) background.set(node, node.inert);
        node.inert = true;
      }
    } else {
      for (const [node, inert] of background) node.inert = inert;
      background.clear();
    }
  };
  const openRegion = (region, opener = root.activeElement) => {
    if (phone.matches) {
      drawerOpener = opener;
      drawer = region;
    } else if (region === 'sidebar') sidebar = true;
    else today = true;
    paint();
    if (phone.matches) layout.querySelector(`#${region === 'sidebar' ? 'appSidebar' : 'appToday'} button`).focus();
  };
  const toggle = region => {
    if (phone.matches) { if (drawer === region) closeDrawer(); else openRegion(region); return; }
    else if (region === 'sidebar') { sidebar = !sidebar; try { win.localStorage.setItem(`doctorcre:sidebar:${pageKey}`, sidebar ? 'open' : 'closed'); } catch {} }
    else { today = !today; try { win.localStorage.setItem(dealBoard ? 'doctorcre:today:/deals' : 'doctorcre:today', today ? 'open' : 'closed'); } catch {} }
    paint();
  };
  const closeDrawer = () => {
    const previous = drawer; drawer = null; paint();
    if (previous) (drawerOpener?.isConnected && !drawerOpener.closest("[inert]") ? drawerOpener : previous === 'sidebar' ? sidebarToggle : todayToggle).focus();
    drawerOpener = null;
  };
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
      if (!panel.contains(root.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  phone.addEventListener('change', () => { drawer = null; paint(); });
  paint();
  root.addEventListener('doctorcre:open-today', () => openRegion('today'));
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
  // eslint-disable-next-line no-restricted-syntax -- A single initial frame scrolls the selected tab into view; it performs no reads.
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
  let todayItems = null, todayNeeds = null, nextExpanded = false, failedReads = [];
  const row = (item, extra = '', overdue = '') => `<button type="button" class="app-layout-item" data-layout-deal="${escape(item.subject_id || item.id)}"><strong>${escape(item.subject_name || item.name)}</strong>${briefOwnerLabel(item) ? `<small class="morning-owner">${briefOwnerLabel(item)}</small>` : ''}${extra || overdue ? `<span>${escape(extra)}${extra && overdue ? ' ' : ''}${overdue ? `<span class="app-layout-age">${escape(overdue)}</span>` : ''}</span>` : ''}</button>`;
  const render = (target, html) => { const node = layout.querySelector(target); if (node.innerHTML !== html) { const id = node.contains(root.activeElement) ? root.activeElement.dataset.layoutDeal : null; node.innerHTML = html; if (id) [...node.querySelectorAll('button')].find(b => b.dataset.layoutDeal === id)?.focus(); } };
  const overdueRows = deals => {
    const today = businessDay();
    return mostOverdueFirst(deals, today).map(d => row(d, d.next_step || '', overdueLabel(overdueSince(d, today), today)));
  };
  const unavailable = '<span class="app-layout-empty">Unavailable</span>';
  const empty = '<span class="app-layout-empty">—</span>';
  const renderToday = () => {
    if (pathname === '/') {
      const day = businessDay();
      render('#appTodayNext', `<a class="app-layout-item" href="/calendar?day=${day}&d=${day}"><time datetime="${day}">${escape(new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</time><span>Open Calendar</span></a>`);
      layout.querySelector('#appTodayNext').previousElementSibling.textContent = 'Calendar day';
      layout.querySelector('#appTodayNeeds').closest('section').hidden = true;
      layout.querySelector('#appTodayOwners').hidden = true;
      layout.querySelector('#appTodayShowAll').hidden = true;
      return;
    }
    const next = todayItems && filterBriefOwners(todayItems, owners.current()).filter(i => i.subject_type === 'deal');
    render('#appTodayNext', next ? (nextExpanded ? next : next.slice(0,6)).map(i => row(i,`${i.what || 'Due'} · ${shortDay(i.due_on || '', localToday())}`)).join('') || empty : unavailable);
    const showAll = layout.querySelector('#appTodayShowAll');
    showAll.hidden = !next || next.length <= 6 || nextExpanded;
    showAll.textContent = `Show all ${next?.length || 0}`;
    render('#appTodayNeeds', todayNeeds ? overdueRows(filterBriefOwners(todayNeeds, owners.current())).slice(0,6).join('') || empty : unavailable);
  };
  const owners = mountBriefOwnerFilter(root, layout.querySelector('#appTodayOwners'), () => { nextExpanded = false; renderToday(); });
  layout.querySelector('#appTodayShowAll').onclick = () => {
    nextExpanded = true; renderToday();
    layout.querySelectorAll('#appTodayNext [data-layout-deal]')[6]?.focus();
  };
  const renderMoves = () => {
    const moves = feed.caught_up ? receiptViews(receipts).slice(0,6) : [];
    render('#appTodayMoves', moves.map(move => {
      const { name, action, by, age } = todayMove(move);
      const detail = `${by ? `${escape(by)} ${escape(action.charAt(0).toLowerCase() + action.slice(1))}` : escape(action)}${age ? `<span class="app-layout-move-age"><span class="sr-only"> · </span>${escape(age)}</span>` : ''}`;
      return `<button type="button" class="app-layout-item" data-layout-deal="${escape(move.deal_id)}"><strong>${escape(name)}</strong><span class="app-layout-move-detail">${detail}</span></button>`;
    }).join('') || empty);
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
    connected = connected && win.navigator.onLine !== false;
    const dot = root.getElementById('appConnection'); dot.dataset.state = connected ? 'healthy' : 'unknown';
    dot.setAttribute('aria-label', connected ? 'Connection available' : 'Connection unavailable'); dot.title = dot.getAttribute('aria-label');
  };
  const renderReadStatus = () => {
    const notice = layout.querySelector('#appTodayReadStatus');
    notice.hidden = !failedReads.length;
    notice.textContent = failedReads.length ? `${todayItems || todayNeeds || feed.caught_up ? 'Showing last update. ' : ''}${failedReads.join(', ')} unavailable. Retry to update.` : '';
    layout.querySelector('#appTodayRetry').hidden = !failedReads.length;
    connection(!failedReads.length);
  };
  const failedRead = () => {
    failedReads = ['Overdue', 'Next up'];
    if (!pageOwnsMoves) failedReads.push('Recent moves');
    renderToday();
    if (!pageOwnsMoves && !feed.caught_up) render('#appTodayMoves', unavailable);
    renderReadStatus();
  };
  const unavailableRead = () => {
    todayItems = null; todayNeeds = null;
    resetFeed();
    if (!vendorDirectory) render('#appWorkingList', unavailable);
    failedRead();
  };
  const refresh = async ({ signal } = {}) => {
    if (win.navigator.onLine === false) { failedRead(); return; }
    try { client ||= await createClient(boot.mode, { ...boot.options, docContext:false }); }
    catch { failedRead(); return; }
    const [board, triage] = await Promise.allSettled([
      readWithDeadline(() => client.getBoard({ workspace:'all' }), { signal }),
      readWithDeadline(async () => {
        const brief = normalizeBrief(await client.morningBrief());
        if (brief) { owners.setViewer(brief.sponsor); return brief.sections.today.state === 'unavailable' ? null : {items:brief.sections.today.items}; }
        return client.todayTriage();
      }, { signal }),
    ]);
    if (signal?.aborted || win.navigator.onLine === false) return;
    const connected = board.status === 'fulfilled' && validBoard(board.value);
    const triageValid = triage.status === 'fulfilled' && validTriage(triage.value);
    connection(connected && triageValid && !failedReads.length);
    failedReads = [];
    if (!connected || !triageValid) failedReads.push('Overdue');
    if (!triageValid) failedReads.push('Next up');
    if (connected) {
      const value = board.value;
      if (feedActor !== value.actor) {
        todayItems = null; todayNeeds = null;
        resetFeed();
      }
      feedActor = value.actor;
      const authorized = new Map(value.deals.map(deal => [deal.id, deal.name]));
      todayItems = (triageValid ? triage.value.items : todayItems)?.filter(item => item.subject_type !== 'deal' || authorized.has(item.subject_id)) ?? null;
      receipts = receipts.filter(receipt => authorized.has(receipt.deal_id))
        .map(receipt => ({ ...receipt, deal_name: authorized.get(receipt.deal_id) }));
      if (!pageOwnsMoves) renderMoves();
      const active = scopedDeals(value, 'team');
      if (triageValid || !todayNeeds) todayNeeds = overdueActionRows(active, todayItems, businessDay());
      else todayNeeds = todayNeeds.filter(deal => active.some(current => current.id === (deal.subject_id || deal.id)));
      if (!vendorDirectory) render('#appWorkingList', overdueRows(active.filter(d => needsAttention(d))).slice(0,8).join('') || empty);
      renderToday();
      if (!pageOwnsMoves) {
        try {
          // The existing feed starts with history. Never present its oldest
          // page as recent; advance bounded pages until it reaches the present.
          const takePage = createPageBudget({ document: root });
          // eslint-disable-next-line no-restricted-syntax -- Recent-change catch-up has a max of four pages and consumes takePage before each read.
          for (let page = 0; page < 4; page++) {
            takePage();
            const changes = await readWithDeadline(() => client.getChanges(cursor), { signal });
            if (signal?.aborted || win.navigator.onLine === false) return;
            if (!Array.isArray(changes?.events)) throw new Error('Invalid change response');
            const batch = changes.events;
            feed = observeChangeBatch(feed, batch);
            receipts = ingestChangeEvents(receipts, batch, { dealName:id => authorized.get(id) })
              .filter(receipt => authorized.has(receipt.deal_id));
            cursor = changes.cursor ?? cursor;
            if (feed.caught_up) break;
          }
          renderMoves();
        } catch {
          if (signal?.aborted) return;
          failedReads.push('Recent moves');
          if (!feed.caught_up) render('#appTodayMoves', unavailable);
        }
      }
    } else {
      if (triageValid) todayItems = triage.value.items;
      if (!vendorDirectory && !todayNeeds) render('#appWorkingList', unavailable);
      if (!pageOwnsMoves) {
        failedReads.push('Recent moves');
        if (!feed.caught_up) render('#appTodayMoves', unavailable);
      }
      renderToday();
    }
    renderReadStatus();
    if (!failedReads.length) {
      const observed = new Date().toISOString();
      status.querySelector('#appSyncTime').textContent = time(observed);
      status.querySelector('#appSyncTime').dateTime = observed;
    }
  };
  layout.addEventListener('click', event => {
    const item = event.target.closest('[data-layout-deal]'); if (!item) return;
    const id = item.dataset.layoutDeal;
    const existing = [...root.querySelectorAll('.deal-link, .kanban-card, button[data-open], button[data-open-deal]')].find(n => n.dataset.id === id || n.dataset.open === id || n.dataset.openDeal === id || n.dataset.deal === id);
    if (existing) { closeDrawer(); existing.click(); }
    else globalThis.location.assign(`/deals?deal=${encodeURIComponent(id)}`);
  });
  win.addEventListener('offline', failedRead);
  const auto = mountAutoRefresh({ document:root, window:win, refresh, onResume:unavailableRead });
  layout.querySelector('#appTodayRetry').onclick = () => auto.refresh();
  let fanOut = false;
  status.querySelector('#appSyncRefresh').onclick = () => {
    auto.refresh(); fanOut = true;
    try { root.querySelectorAll('[data-layout-refresh]').forEach(button => button.click()); } finally { fanOut = false; }
  };
  pageRefresh?.addEventListener('click', () => { if (!fanOut) auto.refresh(); });
  auto.refresh();
  // Ages are relative to now, so the list repaints each minute; render() skips the DOM when the text is unchanged.
  const ageTick = mountLocalTicker({ document: root, window: win, tick: () => { if (!pageOwnsMoves && feed.caught_up) renderMoves(); }, intervalMs: 60_000 });
  win.addEventListener('pagehide', event => {
    if (!event.persisted) { ageTick.dispose(); auto.dispose(); owners.dispose(); win.removeEventListener('offline', failedRead); }
  });
}
