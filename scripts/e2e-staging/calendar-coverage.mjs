import { inventory, ControlSkip } from './controls.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalIdentity } from './traversal.mjs';
import { calendarURL, calendarState, calendarCases, recordCalendarState } from './state-plan.mjs';

export class CalendarCoverageFailure extends Error {
  constructor(code) { super('Calendar coverage failed: ' + code); this.code = code; }
}
const requireCalendar = (value, code) => { if (!value) throw new CalendarCoverageFailure(code); };
const dayStep = (day, count) => new Date(new Date(day + 'T00:00:00Z').valueOf() + count * 86400000).toISOString().slice(0, 10);
const monthStep = (day, count) => {
  const date = new Date(day + 'T00:00:00Z');
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date.getUTCDate(), end)); return first.toISOString().slice(0, 10);
};
const inPeriod = (state, day) => {
  if (state.view === 'month') return state.d.slice(0, 7) === day.slice(0, 7);
  const start = dayStep(state.d, -new Date(state.d + 'T00:00:00Z').getUTCDay());
  return day >= start && day <= dayStep(start, 6);
};

export async function readCalendarContext(page) {
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await page.evaluate(async () => {
        const { view } = await import('/js/calendar.js');
        return ['ready', 'unauthorized', 'unavailable'].includes(view.result.status) && !document.querySelector('#calStatusLabel')?.textContent.includes('Updating');
      });
      if (ready) break;
      await delay(50);
    }
    requireCalendar(ready, 'calendar-read-timeout');
    const data = await page.evaluate(async () => {
      const { view } = await import('/js/calendar.js');
      const { pageDocContext } = await import('/js/doc-context.js');
      return { status: view.result.status, failed: view.result.failed?.length || 0, state: view.state, today: view.today, sequence: view.sequence,
        entries: (view.result.entries || []).map(row => ({ key: row.key, day: row.day, deal_id: row.deal_id })),
        focusEntry: view.focusEntry, selected: pageDocContext?.snapshot().selected || null };
    });
    requireCalendar(data.status === 'ready' && !data.failed, 'calendar-data-incomplete');
    return data;
  } catch (error) { if (error instanceof CalendarCoverageFailure) throw error; throw new CalendarCoverageFailure('calendar-read-failed'); }
}

export async function assertCalendarState(page, expected, grid) {
  const data = await readCalendarContext(page), actual = calendarState(page.url());
  requireCalendar(actual && actual.view === data.state.view && actual.d === data.state.anchor && (actual.day || null) === data.state.day, 'url-state-diverged');
  if (expected) {
    const wanted = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value === 'today' ? data.today : value]));
    requireCalendar(actual.view === wanted.view && actual.d === wanted.d && (actual.day || null) === (wanted.day || null), 'operation-result-incorrect');
  }
  const dom = await page.evaluate(() => ({
    view: document.querySelector('#calGrid')?.dataset.view,
    days: [...document.querySelectorAll('#calGrid .cal-day')].map(node => node.dataset.day),
    selected: [...document.querySelectorAll('#calGrid .cal-day[aria-selected=true]')].map(node => node.dataset.day),
    pressed: [...document.querySelectorAll('#calViewSwitch [aria-pressed=true]')].map(node => node.dataset.view),
  }));
  requireCalendar(dom.view === actual.view && dom.pressed.length === 1 && dom.pressed[0] === actual.view, 'view-render-incorrect');
  requireCalendar(dom.days.length === (actual.view === 'month' ? 42 : 7) && new Set(dom.days).size === dom.days.length, 'grid-incomplete');
  requireCalendar(dom.days.every((day, index) => !index || day === dayStep(dom.days[index - 1], 1)), 'grid-dates-incorrect');
  requireCalendar(dom.selected.length === (actual.day && dom.days.includes(actual.day) ? 1 : 0) && (!dom.selected.length || dom.selected[0] === actual.day), 'selection-render-incorrect');
  if (grid) requireCalendar(dom.days.length === grid.count && dom.days[0] === grid.first && dom.days.at(-1) === grid.last, 'boundary-grid-incorrect');
  return { state: actual, cells: dom.days.length, selected: actual.day || null };
}

export async function assertCalendarAction(page, action, beforeURL) {
  const before = calendarState(beforeURL), after = await readCalendarContext(page);
  requireCalendar(before?.d && action.calendar?.action, 'operation-unclassified');
  const type = action.calendar.action;
  let expected = { ...before }, record;
  if (type === 'prev' || type === 'next') expected.d = before.view === 'month' ? monthStep(before.d, type === 'next' ? 1 : -1) : dayStep(before.d, type === 'next' ? 7 : -7);
  else if (type === 'today') expected = { view: before.view, d: after.today, day: after.today };
  else if (type === 'view') expected = { ...before, view: action.calendar.view, d: before.day || before.d };
  else if (type === 'day' || type === 'entry') {
    const day = action.calendar.day;
    requireCalendar(day, 'day-prerequisite-missing');
    expected = { ...before, d: inPeriod(before, day) ? before.d : day, day };
    if (type === 'entry') {
      const entry = after.entries.find(row => row.key === action.calendar.entry_key);
      requireCalendar(entry && after.focusEntry === entry.key && after.selected?.kind === 'deal' && after.selected.id === entry.deal_id, 'record-selection-incorrect');
      record = recordCalendarState(entry);
    } else requireCalendar(!after.selected, 'day-selection-retained-record');
  } else requireCalendar(type === 'refresh', 'operation-unclassified');
  const rendered = await assertCalendarState(page, expected);
  return { action: type, before, after: rendered.state, assertions_passed: true, ...(record ? { record } : {}) };
}

async function admitLocator(page, locator, admit) {
  if (!admit) return;
  const rows = await inventory(page);
  const matches = await locator.evaluateAll((nodes, controls) => controls.filter(row =>
    nodes.includes(document.querySelector(row.selector))), rows);
  if (matches.length !== 1) throw new ControlSkip('control-not-unique');
  await admit(page, matches[0]);
}

async function chooseEntry(page, key, selector = '.cal-chip', admit) {
  const matches = await page.locator(selector).evaluateAll((nodes, wanted) => nodes.flatMap((node, index) => node.dataset.entry === wanted ? [index] : []), key);
  requireCalendar(matches.length === 1, 'entry-control-not-unique');
  const locator = page.locator(selector).nth(matches[0]);
  await admitLocator(page, locator, admit);
  await locator.click();
}

export async function prepareCalendarRecord(page, spec, admit) {
  const data = await readCalendarContext(page);
  const entries = data.entries.filter(entry => recordCalendarState(entry).entry_binding === spec.entry_binding);
  requireCalendar(entries.length === 1, 'record-state-changed');
  await chooseEntry(page, entries[0].key, '.cal-chip', admit);
  const selected = await readCalendarContext(page);
  requireCalendar(selected.selected?.kind === 'deal' && selected.selected.id === entries[0].deal_id && selected.focusEntry === entries[0].key, 'record-selection-incorrect');
  return { binding: spec.entry_binding, kind: 'deal', record_binding: canonicalIdentity(entries[0].deal_id) };
}

export async function runCalendarCase({ spec, freshPage, evidence, admit }) {
  const item = calendarCases.find(row => row.id === spec.case);
  requireCalendar(item, 'case-unknown');
  let page, steps = [], input = item.input;
  try {
    page = await freshPage({ path: calendarURL(input) });
    let context = await readCalendarContext(page), expected = item.expected;
    const select = item.steps.find(step => step.select);
    let chosen;
    if (select) {
      if (select.select === 'empty') {
        const days = await page.locator('#calGrid .cal-day').evaluateAll(nodes => nodes.map(node => node.dataset.day));
        chosen = { day: days.find(day => !context.entries.some(entry => entry.day === day)) };
        requireCalendar(chosen.day, 'empty-day-prerequisite-missing');
      } else if (select.select === 'agenda') {
        const keys = await page.locator('.cal-agenda-item').evaluateAll(nodes => nodes.map(node => node.dataset.entry));
        chosen = context.entries.find(entry => keys.includes(entry.key));
        requireCalendar(chosen, 'agenda-prerequisite-missing');
      } else {
        chosen = context.entries[0];
        requireCalendar(chosen, 'populated-day-prerequisite-missing');
        await page.context().close();
        page = await freshPage({ path: calendarURL({ view: 'week', d: chosen.day }) });
        context = await readCalendarContext(page);
      }
    }
    const start = context.sequence;
    for (const step of item.steps) {
      if (step.click) { const locator = page.locator(step.click); await admitLocator(page, locator, admit); await locator.click(); }
      else if (step.key) { const locator = page.locator('.cal-day-open[data-select-day="' + step.day + '"]'); await admitLocator(page, locator, admit); await locator.focus(); await page.keyboard.press(step.key); }
      else if (step.history === 'back') await page.goBack();
      else if (step.history === 'forward') await page.goForward();
      else if (step.select === 'event' || step.select === 'agenda') await chooseEntry(page, chosen.key, step.select === 'agenda' ? '.cal-agenda-item' : '.cal-chip', admit);
      else if (step.select) { const locator = page.locator('.cal-day-open[data-select-day="' + chosen.day + '"]'); await admitLocator(page, locator, admit); await locator.click(); }
      steps.push({ ...step });
    }
    if (select) {
      const before = calendarState(calendarURL({ view: context.state.view, d: context.state.anchor, ...(context.state.day ? { day: context.state.day } : {}) }));
      expected = { ...before, day: chosen.day, d: inPeriod(before, chosen.day) ? before.d : chosen.day };
    }
    if (!expected) expected = { view: context.state.view, d: context.state.anchor, ...(context.state.day ? { day: context.state.day } : {}) };
    const rendered = await assertCalendarState(page, expected, item.grid);
    context = await readCalendarContext(page);
    if (item.refresh) requireCalendar(context.sequence > start, 'refresh-did-not-read');
    if (item.dayKind === 'empty') requireCalendar((await page.locator('#dayPanelBody .cal-day-entry').count()) === 0 && /No critical date/.test(await page.locator('#dayPanelBody').textContent()), 'empty-day-render-incorrect');
    if (item.dayKind === 'populated') requireCalendar((await page.locator('#dayPanelBody .cal-day-entry').count()) > 0, 'populated-day-render-incorrect');
    if (item.record) requireCalendar(context.focusEntry === chosen.key && context.selected?.kind === 'deal' && context.selected.id === chosen.deal_id, 'record-selection-incorrect');
    const row = { spec, status: 'passed', steps, assertions: rendered, ...(chosen?.key ? { record_state: recordCalendarState(chosen) } : {}) };
    if (evidence) row.evidence_path = await evidence(page, row);
    return row;
  } catch (error) {
    if (error instanceof ControlSkip) return { spec, status: 'SKIPPED', steps, reason: error.reason, execution: { press_attempted: false, handler_executions: 0 } };
    const result = { spec, status: 'failed', steps, failure: { phase: 'calendar-coverage', code: error instanceof CalendarCoverageFailure ? error.code : 'calendar-case-failed' } };
    if (page && evidence) {
      try { result.evidence_path = await evidence(page, result); }
      catch { result.evidence_failure = 'calendar-evidence-failed'; }
    }
    return result;
  } finally { if (page) await page.context().close(); }
}
