import { canonicalIdentity } from './traversal.mjs';

export const validDay = value => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value; };
const input = (view, d, day) => ({ view, d, ...(day ? { day } : {}) });
const step = (id, view, d, selector, expectedD, day) => ({ id, input: input(view, d, day), steps: [{ click: selector }], expected: input(view, expectedD, day) });
export const calendarCases = [
  { id: 'month-layout', input: input('month', '2026-09-24'), steps: [], expected: input('month', '2026-09-24'), grid: { count: 42, first: '2026-08-30', last: '2026-10-10' } },
  { id: 'week-layout', input: input('week', '2026-09-24'), steps: [], expected: input('week', '2026-09-24'), grid: { count: 7, first: '2026-09-20', last: '2026-09-26' } },
  step('month-prev-year', 'month', '2026-01-31', '#calPrev', '2025-12-31'),
  step('month-prev-clamp', 'month', '2026-03-31', '#calPrev', '2026-02-28'),
  step('month-next-nonleap', 'month', '2026-01-31', '#calNext', '2026-02-28'),
  step('month-next-leap', 'month', '2028-01-31', '#calNext', '2028-02-29'),
  step('month-next-thirty-days', 'month', '2026-03-31', '#calNext', '2026-04-30'),
  step('month-next-year', 'month', '2026-12-31', '#calNext', '2027-01-31'),
  step('week-prev-year', 'week', '2027-01-03', '#calPrev', '2026-12-27'),
  step('week-next-year', 'week', '2026-12-28', '#calNext', '2027-01-04'),
  step('week-prev-leap', 'week', '2028-03-06', '#calPrev', '2028-02-28'),
  step('week-next-leap', 'week', '2028-02-28', '#calNext', '2028-03-06'),
  { id: 'today-month', input: input('month', '2020-01-01'), steps: [{ click: '#calToday' }], expected: { view: 'month', d: 'today', day: 'today' } },
  { id: 'today-week', input: input('week', '2020-01-01'), steps: [{ click: '#calToday' }], expected: { view: 'week', d: 'today', day: 'today' } },
  { id: 'toggle-week', input: input('month', '2026-09-24', '2026-09-25'), steps: [{ click: '#calViewSwitch [data-view=week]' }], expected: input('week', '2026-09-25', '2026-09-25') },
  { id: 'toggle-month', input: input('week', '2026-09-24', '2026-09-25'), steps: [{ click: '#calViewSwitch [data-view=month]' }], expected: input('month', '2026-09-25', '2026-09-25') },
  { id: 'keyboard-left-year', input: input('month', '2027-01-01', '2027-01-01'), steps: [{ key: 'ArrowLeft', day: '2027-01-01' }], expected: input('month', '2026-12-31', '2026-12-31') },
  { id: 'keyboard-right-month', input: input('week', '2026-09-30', '2026-09-30'), steps: [{ key: 'ArrowRight', day: '2026-09-30' }], expected: input('week', '2026-09-30', '2026-10-01') },
  { id: 'keyboard-up-month', input: input('month', '2026-03-03', '2026-03-03'), steps: [{ key: 'ArrowUp', day: '2026-03-03' }], expected: input('month', '2026-02-24', '2026-02-24') },
  { id: 'keyboard-down-leap', input: input('month', '2028-02-24', '2028-02-24'), steps: [{ key: 'ArrowDown', day: '2028-02-24' }], expected: input('month', '2028-03-02', '2028-03-02') },
  { id: 'history-back', input: input('month', '2026-09-24'), steps: [{ click: '#calNext' }, { history: 'back' }], expected: input('month', '2026-09-24') },
  { id: 'history-forward', input: input('month', '2026-09-24'), steps: [{ click: '#calNext' }, { history: 'back' }, { history: 'forward' }], expected: input('month', '2026-10-24') },
  { id: 'refresh', input: { view: 'month' }, steps: [{ click: '#calRefresh' }], refresh: true },
  { id: 'empty-day', input: { view: 'month' }, steps: [{ select: 'empty' }], dayKind: 'empty' },
  { id: 'populated-day', input: { view: 'week' }, steps: [{ select: 'populated' }], dayKind: 'populated' },
  { id: 'event-record', input: { view: 'week' }, steps: [{ select: 'event' }], record: true },
  { id: 'agenda-record', input: { view: 'month' }, steps: [{ select: 'agenda' }], record: true },
];

export function calendarURL(state) {
  const query = new URLSearchParams();
  if (state.view) query.set('view', state.view);
  if (state.d) query.set('d', state.d);
  if (state.day) query.set('day', state.day);
  return '/calendar' + (query.size ? '?' + query : '');
}

export function calendarState(url) {
  const parsed = new URL(url, 'https://staging.invalid');
  if (parsed.pathname !== '/calendar' || [...parsed.searchParams.keys()].some(key => !['view', 'd', 'day'].includes(key))) return null;
  for (const key of ['view', 'd', 'day']) if (parsed.searchParams.getAll(key).length > 1) return null;
  const view = parsed.searchParams.get('view') || 'month', d = parsed.searchParams.get('d'), day = parsed.searchParams.get('day');
  if (!['month', 'week'].includes(view) || d && !validDay(d) || day && !validDay(day)) return null;
  return { view, ...(d ? { d } : {}), ...(day ? { day } : {}) };
}

export function declaredStates(paths) {
  const states = [];
  if (paths.includes('/ideas-events')) for (const tab of ['ideas', 'events']) states.push({ id: 'tab-' + tab, owner: '/ideas-events', kind: 'workspace', url: '/ideas-events?tab=' + tab });
  if (paths.includes('/calendar')) {
    for (const view of ['month', 'week']) states.push({ id: 'workspace-' + view, owner: '/calendar', kind: 'workspace', url: calendarURL({ view }) });
    for (const item of calendarCases) states.push({ id: 'operation-' + item.id, owner: '/calendar', kind: 'calendar-operation', case: item.id });
  }
  return states;
}

export function requestedCalendarState(url) {
  const state = calendarState(url);
  if (!state) return null;
  const canonical = calendarURL(state);
  return { id: 'requested-' + canonicalIdentity(canonical).split(':')[1], owner: '/calendar', kind: 'workspace', url: canonical };
}

export function recordCalendarState(entry) {
  if (!validDay(entry.day) || typeof entry.key !== 'string' || !entry.key || typeof entry.deal_id !== 'string' || !entry.deal_id) throw new Error('Calendar record prerequisite is incomplete');
  const binding = canonicalIdentity(JSON.stringify([entry.key, entry.deal_id, entry.day]));
  return { id: 'record-' + binding.split(':')[1], owner: '/calendar', kind: 'calendar-record', url: calendarURL({ view: 'week', d: entry.day, day: entry.day }), entry_binding: binding };
}

export function validateStateSpec(spec) {
  if (!spec || typeof spec !== 'object') return false;
  const declared = declaredStates(['/ideas-events', '/calendar']).find(item => item.owner === spec.owner && item.id === spec.id);
  if (declared) return JSON.stringify(spec) === JSON.stringify(declared);
  if (spec.owner !== '/calendar') return false;
  if (spec.kind === 'workspace') {
    const requested = requestedCalendarState(spec.url);
    return requested && JSON.stringify(spec) === JSON.stringify(requested);
  }
  return spec.kind === 'calendar-record' && /^record-[a-f0-9]{64}$/.test(spec.id || '') && spec.entry_binding === 'control-state.v1:' + spec.id.slice(7) && calendarState(spec.url)?.view === 'week' && calendarState(spec.url)?.day && calendarState(spec.url).day === calendarState(spec.url).d;
}

export function destinationOwnership({ beforeURL, afterURL, control, routedPaths }) {
  const before = new URL(beforeURL), after = new URL(afterURL);
  if (before.origin !== after.origin || after.pathname.startsWith('/auth/')) return { kind: 'outside' };
  if (after.pathname === '/ideas-events' && routedPaths.includes('/ideas-events')) {
    if (before.href === after.href && !control.href) return { kind: 'discover' };
    const keys = [...after.searchParams.keys()];
    if (keys.length === 1 && keys[0] === 'tab' && ['ideas', 'events'].includes(after.searchParams.get('tab')))
      return { kind: 'delegate', states: declaredStates(['/ideas-events']), reason: 'declared-ideas-tabs' };
  }
  if (after.pathname === '/calendar' && routedPaths.includes('/calendar')) {
    if (!calendarState(after.href)) return { kind: 'unclassified', reason: 'calendar-query-unclassified' };
    if (before.pathname === '/calendar') {
      if (control.calendar?.action) return { kind: 'calendar-operation', states: [], reason: control.calendar.action };
      if (before.href === after.href) return { kind: 'discover' };
      if (!control.href) return { kind: 'unclassified', reason: 'calendar-operation-unclassified' };
    }
    const requested = requestedCalendarState(after.href);
    return { kind: 'delegate', states: [requested], reason: 'requested-calendar-state' };
  }
  return { kind: after.href === before.href || !routedPaths.includes(after.pathname + after.search) ? 'discover' : 'planned' };
}
