import { chromium as rawChromium } from 'playwright';
import { temporaryDirectory } from './temp-directory.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

// Chromium base/command_line.cc: kSwitchPrefixes, IsSwitch,
// AppendSwitchesAndArguments and AppendSwitchNative.
// https://github.com/chromium/chromium/blob/main/base/command_line.cc
// Whitespace: https://github.com/chromium/chromium/blob/main/base/strings/whitespace_constants.h
// Reserve the union of platform spellings, including Windows slash/case forms.
function switchName(argument) {
  return argument.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '').match(/^(?:--?|\/)([^=]*)/)?.[1].replace(/[A-Z]/g, letter => letter.toLowerCase());
}
const mandatorySwitches = new Set(CHROMIUM_SAFETY_ARGS.map(switchName));

export const chromium = {
  async launch(options = {}) {
    const endpoint = options.cdpUrl || proofCdpUrl();
    if (endpoint) return borrowBrowser(endpoint, options);
    let removeDirectory;
    const directory = temporaryDirectory('doctorcre-proof-browser-', { after(cleanup) { removeDirectory = cleanup; } });
    const args = (options.args || []).filter(arg => !mandatorySwitches.has(switchName(arg)));
    try {
      const browser = await rawChromium.launch({
        ...options,
        args: [...CHROMIUM_SAFETY_ARGS, ...args],
        timeout: Math.min(30000, Math.max(1, options.timeout || 30000)),
        env: { ...(options.env || process.env), TMPDIR: directory, TEMP: directory, TMP: directory },
      });
      const close = browser.close.bind(browser);
      let closing;
      browser.close = (...args) => closing ||= Promise.resolve().then(() => close(...args)).then(() => removeDirectory());
      return browser;
    } catch (error) {
      removeDirectory();
      throw error;
    }
  },
};

const unavailable = message => Object.assign(Error(message), { exitCode: 78 });

export function proofCdpUrl(args = process.argv.slice(2)) {
  const index = args.indexOf('--cdp-url');
  const inline = args.find(arg => arg.startsWith('--cdp-url='));
  const endpoint = index < 0 ? inline?.slice(10) : args[index + 1];
  if ((index >= 0 || inline !== undefined) && (!endpoint || endpoint.startsWith('--'))) throw unavailable('CDP URL required');
  return endpoint;
}

export function signedInEngine(endpoint, engine = rawChromium) {
  validateEndpoint(endpoint, engine);
  return { launch: options => borrowBrowser(endpoint, options, engine) };
}

function validateEndpoint(endpoint, engine) {
  if (engine !== rawChromium && engine !== chromium) return;
  let url;
  try { url = new URL(endpoint); } catch { throw unavailable('Local CDP URL required'); }
  if (!['http:', 'ws:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw unavailable('Local CDP URL required');
}

async function borrowBrowser(endpoint, options = {}, engine = rawChromium) {
  validateEndpoint(endpoint, engine);
  if (engine === chromium) engine = rawChromium;
  for (const key of Object.keys(options)) {
    if (!['args', 'headless', 'timeout', 'cdpUrl'].includes(key)) throw unavailable(`Unsupported borrowed browser launch option: ${key}`);
  }
  let connection;
  try {
    connection = await engine.connectOverCDP(endpoint, { ...options, timeout: Math.min(30000, Math.max(1, options.timeout || 30000)), isLocal: true });
  } catch (error) { throw unavailable(`Signed-in browser connection unavailable: ${error.message}`); }
  try {
    if (options.args?.length || options.headless !== undefined) {
      const session = await connection.newBrowserCDPSession();
      try {
        const { arguments: actual } = await session.send('Browser.getBrowserCommandLine');
        if (options.headless !== undefined && options.headless !== actual.some(arg => /^--headless(?:=|$)/.test(arg))) throw unavailable('Unsupported borrowed browser launch option: headless');
        if (options.args?.some(arg => !actual.includes(arg))) throw unavailable('Unsupported borrowed browser launch option: args');
      } finally { await session.detach(); }
    }
  } catch (error) {
    await connection.close();
    throw unavailable(`Borrowed browser launch settings unavailable: ${error.message}`);
  }
  const pages = new Set(), pending = new Set();
  let state = 'active', closing;
  function ownedContext(settings = {}) {
    for (const key of Object.keys(settings)) {
      if (!['viewport', 'timezoneId', 'serviceWorkers'].includes(key)) throw unavailable(`Unsupported borrowed browser context option: ${key}`);
    }
    if (settings.viewport === null) throw unavailable('Unsupported borrowed browser context option: viewport=null');
    if (settings.serviceWorkers !== undefined && !['allow', 'block'].includes(settings.serviceWorkers)) throw unavailable('Unsupported borrowed browser context option: serviceWorkers');
    const localPages = new Set(), routes = [];
    let defaultTimeout;
    return {
      async newPage() {
        if (state !== 'active') throw unavailable('Proof browser closed');
        const acquisition = (async () => {
          let page;
          try {
            const shared = connection.contexts()[0];
            if (!shared) throw Error();
            page = await shared.newPage();
            pages.add(page);
            localPages.add(page);
            const closePage = page.close.bind(page);
            let closingPage;
            page.close = (...args) => closingPage ||= Promise.resolve().then(() => closePage(...args)).then(() => {
              pages.delete(page);
              localPages.delete(page);
            });
            if (state !== 'active') {
              await page.close();
              pages.delete(page);
              localPages.delete(page);
              throw Error();
            }
            if (settings.viewport) await page.setViewportSize(settings.viewport);
            if (settings.timezoneId || settings.serviceWorkers === 'block') {
              // Keep page overrides attached until the target closes; detaching resets them.
              const session = await shared.newCDPSession(page);
              if (settings.timezoneId) await session.send('Emulation.setTimezoneOverride', { timezoneId: settings.timezoneId });
              if (settings.serviceWorkers === 'block') {
                await session.send('Network.enable');
                await session.send('Network.setBypassServiceWorker', { bypass: true });
              }
            }
            if (defaultTimeout) page.setDefaultTimeout(defaultTimeout);
            for (const args of routes) await page.route(...args);
            return page;
          } catch { throw unavailable('Signed-in browser page unavailable'); }
        })();
        pending.add(acquisition);
        try { return await acquisition; } finally { pending.delete(acquisition); }
      },
      async route(...args) { routes.push(args); for (const page of localPages) await page.route(...args); },
      setDefaultTimeout(timeout) { defaultTimeout = timeout; for (const page of localPages) page.setDefaultTimeout(timeout); },
      pages: () => [...localPages].filter(page => !page.isClosed?.()),
      close: async () => { await Promise.all([...localPages].map(page => page.close())); localPages.clear(); },
    };
  }
  const context = ownedContext();
  function close() {
    if (!closing) {
      state = 'draining';
      closing = (async () => {
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled([...pages].map(page => page.close()));
        // CDP Browser.close disconnects this Playwright client, leaving Chrome running.
        await connection.close();
        state = 'closed';
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
    }
    return closing;
  }
  return { newPage: async settings => settings ? ownedContext(settings).newPage() : context.newPage(), newContext: async settings => ownedContext(settings), contexts: () => [context], close };
}

chromium.connectOverCDP = (endpoint, options) => borrowBrowser(endpoint, options);

// Positional legacy CLIs share the same CDP option without changing their arguments.
export function proofArgs(args = process.argv.slice(2)) {
  proofCdpUrl(args);
  return args.filter((arg, index) => arg !== '--cdp-url' && args[index - 1] !== '--cdp-url' && !arg.startsWith('--cdp-url='));
}
