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

const diagnostics = new WeakMap();

export const chromium = {
  async launch(options = {}) {
    let removeDirectory;
    let browser;
    const directory = temporaryDirectory('doctorcre-proof-browser-', { after(cleanup) { removeDirectory = cleanup; } });
    const args = (options.args || []).filter(arg => !mandatorySwitches.has(switchName(arg)));
    try {
      browser = await rawChromium.launch({
        ...options,
        args: [...CHROMIUM_SAFETY_ARGS, ...args],
        timeout: Math.min(30000, Math.max(1, options.timeout || 30000)),
        env: { ...(options.env || process.env), TMPDIR: directory, TEMP: directory, TMP: directory },
      });
      // The public logger omits Chromium stderr. Retain the pinned local-driver
      // collector before disconnect removes its channel; real-CDP tests cover it.
      const collector = browser._connection?.toImpl(browser).options.browserLogsCollector;
      diagnostics.set(browser, () => collector?.recentLogs().join('\n') || '');
      const close = browser.close.bind(browser);
      let closing;
      browser.close = (...args) => closing ||= Promise.resolve().then(() => close(...args)).then(() => removeDirectory());
      return browser;
    } catch (error) {
      await browser?.close();
      removeDirectory();
      throw error;
    }
  },
};

export function browserDiagnostics(browser) {
  return diagnostics.get(browser)?.() || '';
}
