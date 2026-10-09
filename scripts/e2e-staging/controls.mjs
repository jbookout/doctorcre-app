import { currentRun, RUN_LIMITS, RunLimitError } from './run-limits.mjs';
import { createHash } from 'node:crypto';
import { canonicalIdentity, identityKey, canContinueTraversal, traversalSnapshot } from './traversal.mjs';

import { isRecordedActionRuntime } from './recorded-action-reconciliation.mjs';

import { destinationOwnership } from './state-plan.mjs';
import { assertCalendarAction } from './calendar-coverage.mjs';

export const CONTROL_SELECTOR = 'button,input:not([type="hidden"]):not([readonly]),textarea:not([readonly]),a[href],[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="switch"],[role="checkbox"],input[type="checkbox"],input[type="radio"],[aria-pressed],[aria-expanded],summary,select';
export const WORKSPACE_VIEW_SELECTOR = '[role="tab"],[data-view],#appTabsSlot [aria-pressed],[data-layout-slot="tabs"] [aria-pressed],[data-atlas-view],#viewConversation,#viewEverything';

export class SweepFailure extends Error {
  constructor(phase, code, selector) {
    super(`Staging sweep failed: ${phase}/${code}`);
    this.failure = { phase, code, ...(selector ? { selector } : {}) };
  }
}

async function inventoryState(page, scope) {
  const state = await page.locator(CONTROL_SELECTOR).evaluateAll((elements, workspaceSelector) => {
    const visible = element => {
      if (!element.checkVisibility({ visibilityProperty: true })) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const busyVisible = element => {
      const style = getComputedStyle(element);
      if (style.display === 'contents') return [...element.childNodes].some(node => {
        if (node.nodeType === Node.ELEMENT_NODE) return busyVisible(node);
        if (node.nodeType !== Node.TEXT_NODE) return false;
        const parent = node.parentElement;
        if (getComputedStyle(parent).visibility !== 'visible') return false;
        for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.contentVisibility === 'hidden' || (style.display !== 'contents' && !ancestor.checkVisibility())) return false;
          if (ancestor.tagName === 'DETAILS' && !ancestor.open) {
            const summary = [...ancestor.children].find(child => child.tagName === 'SUMMARY');
            if (!summary?.contains(parent)) return false;
          }
        }
        const range = document.createRange();
        range.selectNode(node);
        const rect = range.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return visible(element);
    };
    const cssPath = element => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts = [];
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        const index = [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName).indexOf(node) + 1;
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      }
      return parts.join(' > ');
    };
    const panelSelector = 'dialog,[role="dialog"],.drawer,.sheet,[role="tabpanel"],[role="menu"]';
    const regions = new Set(document.querySelectorAll(`${panelSelector},[role="main"],[role="region"],details,header,nav,main,#appShell,#appMainSlot,#appSidebar,#appToday,.app-shell-more-list,.app-shell-account-menu`));
    for (const controller of document.querySelectorAll('[aria-controls]')) {
      for (const id of controller.getAttribute('aria-controls').split(/\s+/)) {
        const target = document.getElementById(id);
        if (target) regions.add(target);
      }
    }
    const ownerOf = element => {
      for (let node = element; node; node = node.parentElement) if (regions.has(node)) return node;
      return document.body;
    };
    const workspaceOf = element => element.closest('#appLayout') || element.closest('main,[role="main"]') || ownerOf(element);
    const panelLabel = element => element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    const ownership = new Map();
    const modal = [...document.querySelectorAll('dialog:modal')].at(-1);
    const rows = elements.filter(element => (!modal || modal.contains(element)) && visible(element) && !element.closest('[inert]')).map(element => {
      const labels = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      const name = (element.getAttribute('aria-label') || labels || element.textContent || element.getAttribute('title') || element.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
      const selector = cssPath(element);
      const panels = [];
      for (let node = element; node; node = node.parentElement) if (node.matches(panelSelector)) panels.push([cssPath(node), panelLabel(node)]);
      ownership.set(selector, { owner: ownerOf(element), workspace: workspaceOf(element), panels, disclosure: element.getAttribute('aria-expanded') ?? (element.tagName === 'SUMMARY' ? String(element.parentElement.open) : '') });
      const role = element.getAttribute('role') || (element.tagName === 'A' ? 'link' : element.tagName.toLowerCase());
      let calendar;
      if (location.pathname === '/calendar') {
        const action = { calPrev: 'prev', calNext: 'next', calToday: 'today', calRefresh: 'refresh' }[element.id];
        if (action) calendar = { action };
        else if (element.matches('#calViewSwitch [data-view]')) calendar = { action: 'view', view: element.dataset.view };
        else if (element.matches('.cal-day-open')) calendar = { action: 'day', day: element.dataset.selectDay };
        else if (element.matches('.cal-chip,.cal-agenda-item')) calendar = { action: 'entry', day: element.dataset.day, entry_key: element.dataset.entry };
      }
      const reason = (element.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || element.getAttribute('title') || element.getAttribute('data-disabled-reason') || '';
      return { selector, name, role, state_url: location.pathname + location.search, ...(calendar ? { calendar } : {}), inputType: element.getAttribute('type'), workspace: element.matches(workspaceSelector), aria: ['aria-selected','aria-expanded','aria-pressed','aria-checked'].map(key => element.getAttribute(key)).join('|'), checked: element.matches('input[type="checkbox"],input[type="radio"]') ? element.checked : null, options: element.tagName === 'SELECT' ? [...element.options].filter(option => !option.disabled).map(option => ({ value: option.value, text: option.textContent })) : null, href: element.getAttribute('href'), disabled: element.matches(':disabled,[aria-disabled="true"]'), reason, identity: `${location.pathname}${location.search}|${selector}|${role}|${element.getAttribute('href') || ''}` };
    });
    const localControls = new Map(), workspaceViews = new Map();
    for (const row of rows) {
      const { owner, workspace } = ownership.get(row.selector);
      if (!localControls.has(owner)) localControls.set(owner, []);
      localControls.get(owner).push(row.selector);
      if (row.workspace) {
        if (!workspaceViews.has(workspace)) workspaceViews.set(workspace, []);
        workspaceViews.get(workspace).push([row.selector, row.aria]);
      }
    }
    const controls = rows.flatMap(row => {
      const { owner, workspace, panels, disclosure } = ownership.get(row.selector);
      const context = JSON.stringify([cssPath(owner), localControls.get(owner), workspaceViews.get(workspace) || [], panels]);
      const identity = `${context}|${row.identity}|${disclosure}|${row.disabled}|${JSON.stringify([row.name, row.aria, row.checked])}`;
      return row.options?.length ? row.options.map(option => ({ ...row, name: `${row.name}: ${option.text}`, optionValue: option.value, identity: `${identity}|${option.value}` })) : [{ ...row, identity }];
    });
    return { rows: controls, busy: [...document.querySelectorAll('[aria-busy="true"]')].some(busyVisible) };
  }, WORKSPACE_VIEW_SELECTOR);
  return { ...state, rows: state.rows.map(row => ({ ...row, identity: canonicalIdentity(scope ? JSON.stringify([scope, row.identity]) : row.identity) })) };
}

export async function inventory(page, { scope } = {}) {
  return (await inventoryState(page, scope)).rows;
}

export async function settledInventory(page, { timeoutMs = 30_000, stableMs = 1500, scope } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous, stableSince = Date.now();
  while (Date.now() < deadline) {
    let state;
    try { state = await inventoryState(page, scope); }
    catch (error) {
      if (!error.message?.includes('Execution context was destroyed') || page.isClosed()) throw error;
      // Navigation can invalidate an in-flight DOM read. Reobserve the new
      // document within the original deadline; no old inventory is accepted.
      previous = undefined; stableSince = Date.now();
      await page.waitForTimeout(100);
      continue;
    }
    const { rows, busy } = state;
    const signature = JSON.stringify(rows.map(row => row.identity));
    if (signature !== previous || busy || !rows.length) stableSince = Date.now();
    if (rows.length && !busy && Date.now() - stableSince >= stableMs) return rows;
    previous = signature;
    await page.waitForTimeout(100);
  }
  throw new Error('Control inventory did not settle; screen completeness is unverified');
}

export async function pressControl(page, control, { waitMs = 2000 } = {}) {
  const locator = page.locator(control.selector);
  if (control.disabled) return { status: 'DISABLED', reason: control.reason || 'No reason provided', signals: [] };
  if (await locator.count() !== 1 || !await locator.isVisible()) return { status: 'UNREACHABLE', reason: 'Control missing after replay', signals: [] };
  await locator.focus().catch(() => {});
  const beforeURL = page.url();
  await page.evaluate(selector => {
    const root = document.querySelector('main,[role="main"],#appMain,#mainContent') || document.body;
    const target = document.querySelector(selector);
    const state = window.__controlObservation = { mutations: 0, focus: 0, aria: 0, target, beforeOpen: target?.tagName === 'SUMMARY' ? target.parentElement.open : null, beforeValue: target?.value ?? null, beforeChecked: target?.checked ?? null, valueChanged: false, requests: [], deadline: Infinity };
    const active = () => !state.snapshot && Date.now() <= state.deadline;
    const events = ['click', 'input', 'change', 'keydown', 'submit'];
    let inCallback = false, pendingFocus = 0, callbackGeneration = 0;
    // window.event identifies the native dispatch while existing app handlers
    // run. Async work inherits attribution only when scheduled by that dispatch
    // or its callbacks. Pre-existing timers and polling never inherit it.
    const matches = event => event.type === 'submit' ? event.submitter === target : event.composedPath().includes(target);
    const caused = () => active() && (inCallback || (window.event && events.includes(window.event.type) && matches(window.event)));
    const visible = node => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return element?.checkVisibility({ visibilityProperty: true }) && !element.closest('[hidden],[inert],dialog:not([open])');
    };
    const visibleBefore = new WeakSet([...document.querySelectorAll('*')].filter(visible));
    const observe = records => {
      if (!active()) return;
      for (const record of records) {
        // A causal dismissal hides its own mutation target before delivery.
        if (!visible(record.target) && !visibleBefore.has(record.target)) continue;
        if (record.type === 'attributes' && record.oldValue === record.target.getAttribute(record.attributeName)) continue;
        if (record.type === 'characterData' && record.oldValue === record.target.textContent) continue;
        if (root.contains(record.target) || record.target === root || record.target.closest?.('[role="dialog"],[role="status"],[role="alert"],dialog,.toast,.sheet')) state.mutations++;
        if (record.type === 'attributes' && /^(aria-|open|checked|disabled)/.test(record.attributeName)) state.aria++;
      }
    };
    // Unattributed asynchronous rendering is discarded at its microtask, not
    // carried forward and credited to the next interaction.
    window.__controlObserver = new MutationObserver(records => { if (caused()) observe(records); });
    window.__controlObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true });
    const flush = () => {
      observe(window.__controlObserver.takeRecords());
      if (!active()) return;
      state.focus += pendingFocus; pendingFocus = 0;
      if (target?.isConnected && ((target.value ?? null) !== state.beforeValue || (target.checked ?? null) !== state.beforeChecked)) state.valueChanged = true;
    };
    const originals = { setTimeout: window.setTimeout, setInterval: window.setInterval, requestAnimationFrame: window.requestAnimationFrame, queueMicrotask: window.queueMicrotask, fetch: window.fetch, then: Promise.prototype.then, xhrOpen: XMLHttpRequest.prototype.open, xhrSend: XMLHttpRequest.prototype.send };
    const promises = new WeakSet(), xhrURLs = new WeakMap();
    const finishCallback = generation => originals.queueMicrotask.call(window, () => {
      if (generation !== callbackGeneration) return;
      flush(); inCallback = false;
    });
    const inherit = callback => typeof callback !== 'function' ? callback : function (...args) {
      if (!active()) return callback.apply(this, args);
      window.__controlObserver.takeRecords(); pendingFocus = 0;
      const generation = ++callbackGeneration; inCallback = true;
      try {
        const result = callback.apply(this, args);
        if (result instanceof Promise) promises.add(result);
        return result;
      // Resolving an awaited promise queues the native continuation before
      // this cleanup microtask. Promise.then wrappers cannot see native await.
      // Flush its effects before clearing attribution, without extending it to
      // the next timer task (which may belong to unrelated idle rendering).
      } finally { flush(); finishCallback(generation); }
    };
    for (const key of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask']) window[key] = function (callback, ...args) {
      return originals[key].call(this, caused() ? inherit(callback) : callback, ...args);
    };
    Promise.prototype.then = function (fulfilled, rejected) {
      const attributed = caused() || promises.has(this);
      const result = originals.then.call(this, attributed ? inherit(fulfilled) : fulfilled, attributed ? inherit(rejected) : rejected);
      if (attributed) promises.add(result);
      return result;
    };
    const request = (url, method) => { if (caused()) state.requests.push([new URL(url, location.href).href, method.toUpperCase()]); };
    window.fetch = function (input, options) {
      request(input instanceof Request ? input.url : String(input), options?.method || (input instanceof Request ? input.method : 'GET'));
      const result = originals.fetch.call(this, input, options);
      if (caused()) promises.add(result);
      return result;
    };
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      xhrURLs.set(this, [url, method]);
      return originals.xhrOpen.call(this, method, url, ...args);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      const metadata = xhrURLs.get(this); if (metadata) request(...metadata);
      return originals.xhrSend.apply(this, args);
    };
    const interaction = event => {
      if (!matches(event)) return;
      flush(); inCallback = true; finishCallback(++callbackGeneration);
    };
    for (const event of events) window.addEventListener(event, interaction);
    window.__controlFocus = () => {
      if (!active()) return;
      pendingFocus++;
      originals.queueMicrotask.call(window, () => { if (caused()) { state.focus += pendingFocus; } pendingFocus = 0; });
    };
    document.addEventListener('focusin', window.__controlFocus);
    document.addEventListener('focusout', window.__controlFocus);
    window.__controlFinish = () => {
      if (state.snapshot) return state.snapshot;
      clearTimeout(state.timer);
      window.__controlObserver.disconnect();
      for (const event of events) window.removeEventListener(event, interaction);
      document.removeEventListener('focusin', window.__controlFocus);
      document.removeEventListener('focusout', window.__controlFocus);
      for (const key of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'fetch']) window[key] = originals[key];
      Promise.prototype.then = originals.then;
      XMLHttpRequest.prototype.open = originals.xhrOpen; XMLHttpRequest.prototype.send = originals.xhrSend;
      state.snapshot = { mutations: state.mutations, focus: state.focus, aria: state.aria, url: location.href, valueChanged: state.valueChanged, requests: state.requests };
      state.target = null;
      return state.snapshot;
    };
  }, control.selector);
  const signals = new Set();
  let deadline = Infinity;
  const record = signal => { if (Date.now() <= deadline) signals.add(signal); };
  const requests = [];
  const request = value => { if (Date.now() <= deadline) requests.push([value.url(), value.method()]); };
  const dialog = async value => { record('dialog'); await value.accept().catch(() => {}); };
  const popup = () => record('new tab');
  const download = () => record('download');
  const filechooser = () => record('file chooser');
  const navigation = frame => { if (frame === page.mainFrame() && frame.url() !== beforeURL) record('URL change'); };
  page.on('request', request); page.on('dialog', dialog); page.on('popup', popup); page.on('download', download); page.on('filechooser', filechooser); page.on('framenavigated', navigation);
  let error, observed;
  try {
    if (control.role === 'select') {
      await locator.selectOption(control.optionValue);
    } else if (control.inputType === 'range') {
      await locator.press('ArrowRight');
      if (await page.evaluate(() => {
        const state = window.__controlObservation;
        return state.target?.isConnected && state.target.value === state.beforeValue;
      })) await locator.press('ArrowLeft');
    } else if (['input','textarea'].includes(control.role) && await locator.getAttribute('readonly') === null && !['submit','button','checkbox','radio','file','color'].includes(control.inputType)) {
      await locator.click({ timeout: 5000 });
      const values = { email: 'e2e@example.test', url: 'https://example.test', tel: '2025550100', number: '1', date: '2030-01-15', time: '12:00', 'datetime-local': '2030-01-15T12:00', month: '2030-01', week: '2030-W03' };
      await locator.fill(values[control.inputType] || 'E2E synthetic input');
    } else await locator.click({ timeout: 5000, noWaitAfter: true });
    deadline = Date.now() + waitMs;
    await page.evaluate(deadline => {
      const state = window.__controlObservation;
      if (!state) return;
      // Native summary default actions run after bubbling. Read their state
      // immediately after the press, before waiting for asynchronous effects.
      if (state.target?.isConnected && state.beforeOpen !== null && state.target.parentElement.open !== state.beforeOpen) state.aria++;
      state.deadline = deadline;
      state.timer = setTimeout(window.__controlFinish, Math.max(0, deadline - Date.now()));
    }, deadline).catch(() => {});
    await page.waitForTimeout(Math.max(0, deadline - Date.now()));
  } catch { error = 'Control click failed or timed out'; }
  finally {
    page.off('request', request); page.off('dialog', dialog); page.off('popup', popup); page.off('download', download); page.off('filechooser', filechooser); page.off('framenavigated', navigation);
    observed = await page.evaluate(() => window.__controlFinish?.() || null).catch(() => null);
  }
  if (observed?.requests.some(initiated => requests.some(actual => actual[0] === initiated[0] && actual[1] === initiated[1]))) signals.add('network request');
  if (observed?.valueChanged) signals.add('main form state change');
  if (observed && observed.url !== beforeURL) signals.add('URL change');
  if (observed?.mutations) signals.add('main DOM mutation');
  if (observed?.focus) signals.add('focus move');
  if (observed?.aria) signals.add('aria state change');
  return { status: error ? 'ERROR' : signals.size ? 'OBSERVED' : 'DEAD', reason: error, signals: [...signals] };
}

export async function sweepScreen({ freshPage, screen, target, evidence, checkpoint, prior, identityScope, waitMs = 2000, limit = RUN_LIMITS.controlsPerScreen, routedPaths = [], recordedActionRuntime }) {
  const run = currentRun();
  limit = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : RUN_LIMITS.controlsPerScreen, RUN_LIMITS.controlsPerScreen);
  const stopAtLimit = () => { if (run) { run.stop('control-count-limit'); throw new RunLimitError('control-count-limit'); } };
  if (prior?.recorded_action_ledger && (!isRecordedActionRuntime(recordedActionRuntime) ||
      recordedActionRuntime.screen_sha256 !== createHash('sha256').update(JSON.stringify(prior)).digest('hex')))
    throw new SweepFailure('recorded-action', 'unvalidated-runtime');
  const continuing = canContinueTraversal(prior);
  const saved = continuing ? structuredClone(prior.traversal) : null;
  const queue = saved ? [...(saved.active ? [saved.active] : []), ...saved.queue] : [{ openers: [], controls: null }];
  const destructive = saved?.destructive || [], seen = new Set((saved?.seen || []).map(canonicalIdentity)), controls = continuing ? structuredClone(prior.controls) : [];
  const ledger = continuing && prior.recorded_action_ledger ? structuredClone(prior.recorded_action_ledger) : null;
  const resolved = new Set((ledger?.resolved || []).map(row => row.queued_identity));
  let active = null, pending = saved?.pending_discovery || null;
  const priorFailures = continuing ? [...(prior.prior_failures || []), ...(prior.failure ? [{ ...prior.failure, retained_controls: prior.controls.length }] : [])] : [];
  const failureEvidence = priorFailures.length ? { prior_failures: priorFailures } : {};
  const delegations = continuing ? structuredClone(prior.delegations || []) : [];
  const stateEvidence = () => ({ ...(identityScope ? { state_scope: identityScope } : {}), ...(delegations.length ? { delegations } : {}), ...(ledger ? { recorded_action_ledger: ledger } : {}) });
  const stableMs = waitMs < 2000 ? waitMs : 1500;
  const settle = async (page, phase, selector) => {
    try { await page.waitForLoadState('networkidle', { timeout: 30_000 }); }
    catch { throw new SweepFailure(phase, 'network-idle-failed', selector); }
    try { return await settledInventory(page, { stableMs, scope: identityScope }); }
    catch { throw new SweepFailure(phase, 'inventory-failed', selector); }
  };
  const replayOpeners = async (page, openers, strict = continuing) => {
    let listed, lastAction, lastBeforeURL;
    for (const opener of openers) {
      recordedActionRuntime?.guardOpener(opener);
      let action = opener;
      if (strict) {
        listed ||= await settle(page, 'frontier-validation', opener.selector);
        const matching = listed.filter(row => row.identity === canonicalIdentity(opener.identity));
        if (matching.length !== 1) throw new SweepFailure('frontier-validation', 'opener-state-changed', opener.selector);
        action = matching[0];
      }
      let result;
      lastAction = action; lastBeforeURL = page.url();
      try { result = await pressControl(page, action, { waitMs: Math.min(waitMs, 500) }); }
      catch { throw new SweepFailure('replay', 'opener-press-failed', opener.selector); }
      if (!['OBSERVED','DEAD'].includes(result.status)) throw new SweepFailure('replay', result.status === 'UNREACHABLE' ? 'opener-unreachable' : 'opener-press-failed', opener.selector);
      listed = await settle(page, 'replay', opener.selector);
    }
    return { listed, lastAction, lastBeforeURL };
  };
  let reached = continuing ? prior.reached : false, exhausted = false, failure = null;
  const fail = (error, phase, openers, control, code = `${phase}-failed`) => {
    const bounded = error instanceof SweepFailure ? error.failure : { phase, code };
    failure ||= { ...bounded, ...(control && !bounded.selector ? { selector: control.selector } : {}), openers: openers.map(opener => opener.name) };
  };
  const close = async (page, openers, control) => {
    if (!page) return;
    try { await page.context().close(); }
    catch (error) { fail(error, 'cleanup', openers, control, 'context-close-failed'); }
  };
  const publishProgress = async () => {
    if (!checkpoint) return;
    try { await checkpoint(structuredClone({ ...screen, ...failureEvidence, ...stateEvidence(), target, reached, exhausted, controls, failure, in_progress: true, traversal: traversalSnapshot({ queue, destructive, active, pending, seen, resolved }) })); }
    catch { failure ||= { phase: 'checkpoint', code: 'checkpoint-write-failed', openers: [] }; }
  };
  const enqueue = async (page, openers, exposed) => {
    // A later form/effect change must not disappear merely because the DOM
    // identity is unchanged. Revalidate already resolved actions on discovery.
    for (const row of exposed) if (resolved.has(canonicalIdentity(row.identity)))
      await recordedActionRuntime.consume(page, row);
    const scheduled = new Set([...(active?.controls || []), ...queue.flatMap(state => state.controls || []), ...destructive.flatMap(state => state.controls || [])].map(row => canonicalIdentity(row.identity)));
    const next = exposed.filter(row => !resolved.has(canonicalIdentity(row.identity)) && !seen.has(canonicalIdentity(row.identity)) && !scheduled.has(canonicalIdentity(row.identity)));
    if (next.length) queue.push({ openers, controls: next });
  };
  const resolveDiscovery = async (page, openers, control, beforeURL) => {
    const ownership = () => destinationOwnership({ beforeURL, afterURL: page.url(), control, routedPaths });
    let decision = ownership(), exposed;
    if (decision.kind === 'discover') {
      exposed = await settle(page, 'discovery', control.selector);
      // A source URL can still be visible while navigation is committing.
      // Classify the settled destination before queuing any of its controls.
      decision = ownership();
    }
    if (decision.kind === 'unclassified') throw new SweepFailure('ownership', decision.reason, control.selector);
    if (decision.kind === 'delegate' || decision.kind === 'calendar-operation') {
      const witness = decision.kind === 'calendar-operation' ? await assertCalendarAction(page, control, beforeURL) : null;
      const row = controls.at(-1);
      const states = [...(decision.states || []), ...(witness?.record ? [witness.record] : [])];
      const delegation = { source_key: row.key, before: beforeURL, after: page.url(), reason: decision.reason, states, ...(witness ? { witness } : {}) };
      const old = delegations.find(item => item.source_key === row.key);
      if (old && JSON.stringify(old.states) !== JSON.stringify(states)) throw new SweepFailure('ownership', 'delegated-state-changed', control.selector);
      if (!old) delegations.push(delegation);
    } else if (decision.kind === 'discover') {
      // Persist the measured binding, which may already contain scrubbed
      // display metadata. Only the uniquely matched live action is executed.
      const measured = controls.at(-1);
      await enqueue(page, [...openers, measured], exposed);
    }
    pending = null;
    await publishProgress();
  };
  if (pending) {
    let page;
    try {
      page = await freshPage();
      const exposed = await replayOpeners(page, [...pending.openers, pending.control], true);
      await resolveDiscovery(page, pending.openers, exposed.lastAction, exposed.lastBeforeURL);
    } catch (error) { fail(error, 'discovery', pending?.openers || []); }
    finally { await close(page, pending?.openers || []); }
    if (failure && failure.phase !== 'checkpoint') await publishProgress();
  }
  while ((queue.length || destructive.length) && !failure) {
    if (controls.length >= limit) { stopAtLimit(); exhausted = true; break; }
    const state = queue.shift() || destructive.shift();
    if (state.controls) {
      state.controls = state.controls.filter(control => !resolved.has(canonicalIdentity(control.identity)) && !seen.has(canonicalIdentity(control.identity)));
      if (!state.controls.length) continue;
    }
    active = { ...state, controls: state.controls ? [...state.controls] : null };
    let page, phase = 'fresh-page';
    try {
      page = await freshPage();
      reached = true;
      phase = 'replay';
      await replayOpeners(page, state.openers);
      phase = 'inventory';
      const listed = state.controls || await settledInventory(page, { stableMs, scope: identityScope });
      active.controls = [...listed];
      // Measurements replay the admitted state in their own fresh contexts.
      // Retain its URL for discovery, then retire the unused inventory context.
      const sourceURL = page.url();
      await close(page, state.openers);
      if (!failure) page = null;
      for (const control of listed) {
        if (failure) break;
        if (controls.length >= limit) { stopAtLimit(); exhausted = true; break; }
        active.controls.shift();
        if (seen.has(canonicalIdentity(control.identity)) || resolved.has(canonicalIdentity(control.identity))) continue;
        if (!state.destructive && /(?:delete|archive|send draft|send-draft|sign out)/i.test(control.name)) {
          destructive.push({ openers: state.openers, controls: [control], destructive: true });
          continue;
        }
        if (ledger?.aliases.some(row => row.queued_identity === canonicalIdentity(control.identity))) {
          let fresh;
          try {
            fresh = await freshPage();
            await replayOpeners(fresh, state.openers);
            const entry = await recordedActionRuntime.consume(fresh, control);
            if (!entry) throw new SweepFailure('recorded-action', 'equivalence-unproved', control.selector);
            ledger.resolved.push(entry);
            resolved.add(entry.queued_identity);
            await publishProgress();
          } catch (error) {
            active.controls.unshift(control);
            fail(error, 'recorded-action', state.openers, control, 'equivalence-unproved');
          } finally { await close(fresh, state.openers, control); }
          if (failure) await publishProgress();
          continue;
        }
        seen.add(canonicalIdentity(control.identity));
        const key = `${target}/${screen.path}/${identityKey(control.identity)}`;
        const base = { ...control, ...(identityScope ? { state_scope: identityScope } : {}), key, screen: screen.name, path: screen.path, target, openers: state.openers.map(opener => opener.name) };
        let fresh, row, phase = 'fresh-page';
        try {
          fresh = await freshPage();
          phase = 'replay';
          const replayed = await replayOpeners(fresh, state.openers);
          let action = control;
          if (continuing) {
            const matching = (replayed.listed || await settle(fresh, 'frontier-validation', control.selector)).filter(row => row.identity === canonicalIdentity(control.identity));
            if (matching.length !== 1) throw new SweepFailure('frontier-validation', 'control-state-changed', control.selector);
            action = matching[0];
          }
          phase = 'press';
          const beforeURL = fresh.url();
          const result = await pressControl(fresh, action, { waitMs });
          row = { ...base, ...result };
          controls.push(row);
          phase = 'evidence';
          if (evidence) row.evidence_path = await evidence(fresh, row);
          phase = 'discovery';
          const destination = new URL(fresh.url());
          const current = new URL(sourceURL);
          const discovery = destination.origin === current.origin && !destination.pathname.startsWith('/auth/') && (fresh.url() === sourceURL || !routedPaths.includes(destination.pathname + destination.search));
          pending = result.status === 'OBSERVED' && discovery ? { openers: state.openers, control } : null;
          phase = 'checkpoint';
          await publishProgress();
          phase = 'discovery';
          if (!failure && pending) {
            await resolveDiscovery(fresh, state.openers, action, beforeURL);
          }
        } catch (error) {
          fail(error, phase, state.openers, control);
          if (!row && ['replay','press'].includes(phase)) {
            row = { ...base, status: phase === 'replay' ? 'UNREACHABLE' : 'ERROR', reason: failure.phase + ': ' + failure.code, signals: [] };
            controls.push(row);
          }
          if (!row) { seen.delete(canonicalIdentity(control.identity)); active.controls.unshift(control); }
        } finally { await close(fresh, state.openers, control); }
        if (failure && failure.phase !== 'checkpoint') await publishProgress();
      }
    } catch (error) { fail(error, phase, state.openers); }
    finally { await close(page, state.openers); }
    if (!failure && !exhausted) active = null;
    if (failure && failure.phase !== 'checkpoint') await publishProgress();
  }
  return { ...screen, ...failureEvidence, ...stateEvidence(), target, reached, exhausted, controls, failure, ...(failure || exhausted ? { in_progress: true, traversal: traversalSnapshot({ queue, destructive, active, pending, seen, resolved }) } : {}) };
}
