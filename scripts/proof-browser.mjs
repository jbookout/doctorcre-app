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
  return index < 0 ? args.find(arg => arg.startsWith('--cdp-url='))?.slice(10) : args[index + 1];
}

export function signedInEngine(endpoint, engine = rawChromium) {
  return { launch: options => borrowBrowser(endpoint, options, engine) };
}

async function borrowBrowser(endpoint, options = {}, engine = rawChromium) {
  if (engine === chromium) engine = rawChromium;
  let connection;
  try {
    if (engine === rawChromium || engine === chromium) {
      const url = new URL(endpoint);
      if (!['http:', 'ws:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw Error();
    }
    connection = await engine.connectOverCDP(endpoint, { ...options, timeout: Math.min(30000, Math.max(1, options.timeout || 30000)), isLocal: true });
  } catch { throw unavailable('Signed-in browser connection unavailable'); }
  const pages = new Set(), pending = new Set();
  let state = 'active', closing;
  function ownedContext(settings = {}) {
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
            if (state !== 'active') {
              await page.close();
              pages.delete(page);
              localPages.delete(page);
              throw Error();
            }
            if (settings.viewport) await page.setViewportSize(settings.viewport);
            if (settings.timezoneId) {
              const session = await shared.newCDPSession(page);
              try { await session.send('Emulation.setTimezoneOverride', { timezoneId: settings.timezoneId }); } finally { await session.detach(); }
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
  return { newPage: settings => settings ? ownedContext(settings).newPage() : context.newPage(), newContext: async settings => ownedContext(settings), contexts: () => [context], close };
}

chromium.connectOverCDP = (endpoint, options) => borrowBrowser(endpoint, options);

// Positional legacy CLIs share the same CDP option without changing their arguments.
export function proofArgs(args = process.argv.slice(2)) {
  const endpoint = proofCdpUrl(args);
  if (args.some(arg => arg === '--cdp-url' || arg.startsWith('--cdp-url=')) && !endpoint) throw unavailable('CDP URL required');
  return args.filter((arg, index) => arg !== '--cdp-url' && args[index - 1] !== '--cdp-url' && !arg.startsWith('--cdp-url='));
}
