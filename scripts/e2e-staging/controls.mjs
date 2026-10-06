import { createHash } from 'node:crypto';

export const CONTROL_SELECTOR = 'button,input:not([type="hidden"]):not([readonly]),textarea:not([readonly]),a[href],[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="switch"],[role="checkbox"],input[type="checkbox"],input[type="radio"],[aria-pressed],[aria-expanded],summary,select';
export const WORKSPACE_VIEW_SELECTOR = '[role="tab"],[data-view],#appTabsSlot [aria-pressed],[data-layout-slot="tabs"] [aria-pressed],[data-atlas-view],#viewConversation,#viewEverything';

async function inventoryState(page) {
  return page.locator(CONTROL_SELECTOR).evaluateAll((elements, workspaceSelector) => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const busyVisible = element => {
      const style = getComputedStyle(element);
      if (style.display === 'contents') return [...element.childNodes].some(node => {
        if (node.nodeType === Node.ELEMENT_NODE) return busyVisible(node);
        if (node.nodeType !== Node.TEXT_NODE) return false;
        const range = document.createRange();
        range.selectNode(node);
        const rect = range.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (style.visibility !== 'visible' || !element.checkVisibility()) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
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
      const reason = (element.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || element.getAttribute('title') || element.getAttribute('data-disabled-reason') || '';
      return { selector, name, role, inputType: element.getAttribute('type'), workspace: element.matches(workspaceSelector), aria: ['aria-selected','aria-expanded','aria-pressed','aria-checked'].map(key => element.getAttribute(key)).join('|'), options: element.tagName === 'SELECT' ? [...element.options].filter(option => !option.disabled).map(option => ({ value: option.value, text: option.textContent })) : null, href: element.getAttribute('href'), disabled: element.matches(':disabled,[aria-disabled="true"]'), reason, identity: `${location.pathname}${location.search}|${selector}|${role}|${element.getAttribute('href') || ''}` };
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
      const identity = `${context}|${row.identity}|${disclosure}|${row.disabled}`;
      return row.options?.length ? row.options.map(option => ({ ...row, name: `${row.name}: ${option.text}`, optionValue: option.value, identity: `${identity}|${option.value}` })) : [{ ...row, identity }];
    });
    return { rows: controls, busy: [...document.querySelectorAll('[aria-busy="true"]')].some(busyVisible) };
  }, WORKSPACE_VIEW_SELECTOR);
}

export async function inventory(page) {
  return (await inventoryState(page)).rows;
}

export async function settledInventory(page, { timeoutMs = 30_000, stableMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous, stableSince = Date.now();
  while (Date.now() < deadline) {
    const { rows, busy } = await inventoryState(page);
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
  await page.evaluate(() => {
    const root = document.querySelector('main,[role="main"],#appMain,#mainContent') || document.body;
    window.__controlObservation = { mutations: 0, focus: 0, aria: 0 };
    window.__controlObserver = new MutationObserver(records => {
      for (const record of records) {
        if (root.contains(record.target) || record.target === root || record.target.closest?.('[role="dialog"],[role="status"],[role="alert"],dialog,.toast,.sheet')) window.__controlObservation.mutations++;
        if (record.type === 'attributes' && /^(aria-|open|checked|disabled)/.test(record.attributeName)) window.__controlObservation.aria++;
      }
    });
    window.__controlObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__controlFocus = () => window.__controlObservation.focus++;
    document.addEventListener('focusin', window.__controlFocus);
    document.addEventListener('focusout', window.__controlFocus);
  });
  const beforeURL = page.url();
  const beforeValue = await locator.evaluate(element => element.value ?? null);
  const signals = new Set();
  const request = () => signals.add('network request');
  const dialog = async value => { signals.add('dialog'); await value.accept().catch(() => {}); };
  const popup = () => signals.add('new tab');
  const download = () => signals.add('download');
  const filechooser = () => signals.add('file chooser');
  page.on('request', request); page.on('dialog', dialog); page.on('popup', popup); page.on('download', download); page.on('filechooser', filechooser);
  let error;
  try {
    if (control.role === 'select') {
      await locator.selectOption(control.optionValue);
    } else if (control.inputType === 'range') {
      await locator.press('ArrowRight');
      if (await locator.inputValue() === beforeValue) await locator.press('ArrowLeft');
    } else if (['input','textarea'].includes(control.role) && await locator.getAttribute('readonly') === null && !['submit','button','checkbox','radio','file','color'].includes(control.inputType)) {
      await locator.click({ timeout: 5000 });
      const values = { email: 'e2e@example.test', url: 'https://example.test', tel: '2025550100', number: '1', date: '2030-01-15', time: '12:00', 'datetime-local': '2030-01-15T12:00', month: '2030-01', week: '2030-W03' };
      await locator.fill(values[control.inputType] || 'E2E synthetic input');
    } else await locator.click({ timeout: 5000, noWaitAfter: true });
    await page.waitForTimeout(waitMs);
    if (await locator.evaluate(element => element.value ?? null).catch(() => null) !== beforeValue) signals.add('main form state change');
    if (page.url() !== beforeURL) signals.add('URL change');
    const observed = await page.evaluate(() => {
      window.__controlObserver?.disconnect();
      document.removeEventListener('focusin', window.__controlFocus);
      document.removeEventListener('focusout', window.__controlFocus);
      return window.__controlObservation;
    }).catch(() => null);
    if (observed?.mutations) signals.add('main DOM mutation');
    if (observed?.focus) signals.add('focus move');
    if (observed?.aria) signals.add('aria state change');
  } catch { error = 'Control click failed or timed out'; }
  finally { page.off('request', request); page.off('dialog', dialog); page.off('popup', popup); page.off('download', download); page.off('filechooser', filechooser); }
  return { status: error ? 'ERROR' : signals.size ? 'OBSERVED' : 'DEAD', reason: error, signals: [...signals] };
}

export async function sweepScreen({ freshPage, screen, target, evidence, waitMs = 2000, limit = 5000, routedPaths = [] }) {
  const queue = [{ openers: [], controls: null }], destructive = [], seen = new Set(), controls = [];
  let reached = false, exhausted = false;
  while (queue.length || destructive.length) {
    if (controls.length >= limit) { exhausted = true; break; }
    const state = queue.shift() || destructive.shift();
    const page = await freshPage();
    try {
      for (const opener of state.openers) {
        const result = await pressControl(page, opener, { waitMs: Math.min(waitMs, 500) });
        if (!['OBSERVED','DEAD'].includes(result.status)) throw new Error('opener replay failed');
      }
      reached = true;
      const listed = state.controls || await settledInventory(page, { stableMs: waitMs < 2000 ? waitMs : 1500 });
      for (const control of listed) {
        if (controls.length >= limit) { exhausted = true; break; }
        if (seen.has(control.identity)) continue;
        if (!state.destructive && /(?:delete|archive|send draft|send-draft|sign out)/i.test(control.name)) {
          destructive.push({ openers: state.openers, controls: [control], destructive: true });
          continue;
        }
        seen.add(control.identity);
        const fresh = await freshPage();
        try {
          for (const opener of state.openers) {
            const replay = await pressControl(fresh, opener, { waitMs: Math.min(waitMs, 500) });
            if (!['OBSERVED','DEAD'].includes(replay.status)) throw new Error('opener replay failed');
          }
          const result = await pressControl(fresh, control, { waitMs });
          const key = `${target}/${screen.path}/${createHash('sha256').update(control.identity).digest('hex').slice(0, 16)}`;
          const row = { ...control, ...result, key, screen: screen.name, path: screen.path, target, openers: state.openers.map(opener => opener.name) };
          if (evidence) row.evidence_path = await evidence(fresh, row);
          controls.push(row);
          const destination = new URL(fresh.url());
          const current = new URL(page.url());
          const discovery = destination.origin === current.origin && !destination.pathname.startsWith('/auth/') && (fresh.url() === page.url() || !routedPaths.includes(destination.pathname + destination.search));
          if (result.status === 'OBSERVED' && discovery) {
            const exposed = (await settledInventory(fresh, { stableMs: waitMs < 2000 ? waitMs : 1500 })).filter(next => !seen.has(next.identity));
            if (exposed.length) queue.push({ openers: [...state.openers, control], controls: exposed });
          }
        } catch {
          controls.push({ ...control, key: `${target}/${screen.path}/${createHash('sha256').update(control.identity).digest('hex').slice(0, 16)}`, status: 'UNREACHABLE', reason: 'Fresh-state opener replay failed', screen: screen.name, path: screen.path, target, openers: state.openers.map(opener => opener.name) });
        } finally { await fresh.context().close(); }
      }
    } finally { await page.context().close(); }
  }
  return { ...screen, target, reached, exhausted, controls };
}
