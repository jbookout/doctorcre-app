// Offline browser seam: app-owned modules supply every handler. No HTTP,
// browser, credentials or business writes. Global bindings are restored on close.
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { mountAppShell } from '../../js/app-shell.js';
import { mountGlobalCallMode } from '../../js/global-call-mode.js';
import { mountDocPresence } from '../../js/doc-presence.js';
import { createDocContext } from '../../js/doc-context-model.js';
import { createLiveClient } from '../../js/live-client.js';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import routes from '../../contracts/app-routes.v1.json' with { type: 'json' };

export async function catalogFixture({ path = '/', phone = false, actor = 'joe', theme = 'dark', assist = false, callAvailable = true } = {}) {
  const pathname = new URL(path, 'https://synthetic.invalid').pathname;
  const asset = routes.routes[pathname] || (pathname.startsWith('/control-room/progress/board/') ? 'progress-board.html' : pathname.slice(1));
  const html = await readFile(new URL('../../' + asset, import.meta.url), 'utf8');
  const { window: win } = new JSDOM(html, { url: STAGING_ORIGIN + path, runScripts: 'outside-only', pretendToBeVisual: true });
  const saved = new Map();
  for (const [key, value] of Object.entries({ window: win, document: win.document, location: win.location, localStorage: win.localStorage,
    matchMedia: query => ({ matches: query.includes('max-width') && phone, addEventListener() {}, removeEventListener() {} }) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  win.matchMedia = globalThis.matchMedia;
  win.CSS = { escape: value => value };
  win.Request = Request;
  win.Element.prototype.checkVisibility = function () { return !this.closest('[hidden],[inert],dialog:not([open])'); };
  win.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  win.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new win.Event('close')); };
  win.localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme }));
  win.localStorage.setItem('dealroom-color-assist', assist ? 'on' : 'off');
  const page = new EventEmitter();
  const fetch = async (url, init = {}) => {
    const href = new URL(String(url), win.location.href).href;
    page.emit('request', { url: () => href, method: () => init.method || 'GET', postDataJSON: () => JSON.parse(init.body) });
    if (href === win.location.origin + '/mcp') {
      const rpc = JSON.parse(init.body), operation = rpc.params?.name;
      const payloads = { 'list-doc-suggestions': { ok: true, suggestions: [] }, 'morning-brief': { ok: false },
        'deal-room-board': { deals: [] }, find: { parties: [], deals: [] } };
      if (!(operation in payloads)) throw new Error('Offline unsupported operation: ' + operation);
      return { ok: true, json: async () => ({ result: { content: [{ text: JSON.stringify(payloads[operation]) }] } }) };
    }
    if (href.startsWith('http://127.0.0.1:4682/api/state')) return { ok: true, json: async () => ({ state: 'idle' }) };
    if (href.endsWith('/api/system-work/session')) return { ok: true, json: async () => ({ actor: { slug: actor } }) };
    throw new Error('Offline synthetic API unavailable');
  };
  saved.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch')); win.fetch = fetch; globalThis.fetch = (...args) => win.fetch(...args);
  mountAppShell(win.document, pathname);
  const call = await mountGlobalCallMode(win.document);
  call.render();
  win.document.querySelector('#callModeButton').hidden = !callAvailable;
  const presence = mountDocPresence({ document: win.document, window: win, context: createDocContext({ page: 'home' }),
    client: createLiveClient({ fetchImpl: (...args) => win.fetch(...args) }) });
  await new Promise(resolve => setTimeout(resolve, 5));
  const evaluate = async (fn, arg) => win.eval('(' + fn.toString() + ')')(arg);
  const context = { close: async () => close() };
  Object.assign(page, { url: () => win.location.href, isClosed: () => false, context: () => context, evaluate,
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)), waitForLoadState: async () => {},
    locator: selector => ({ evaluateAll: async (fn, arg) => win.eval('(' + fn.toString() + ')')([...win.document.querySelectorAll(selector)], arg),
      count: async () => win.document.querySelectorAll(selector).length, isVisible: async () => win.document.querySelector(selector)?.checkVisibility(),
      getAttribute: async name => win.document.querySelector(selector)?.getAttribute(name),
      focus: async () => win.document.querySelector(selector).focus(), click: async () => win.document.querySelector(selector).click(),
      fill: async value => { const node = win.document.querySelector(selector); node.value = value; node.dispatchEvent(new win.Event('input', { bubbles: true })); },
      selectOption: async value => { const node = win.document.querySelector(selector); node.value = value; node.dispatchEvent(new win.Event('change', { bubbles: true })); },
    }) });
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    presence?.dispose(); win.dispatchEvent(new win.Event('pagehide')); win.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
  return { page, window: win, actor, close };
}
