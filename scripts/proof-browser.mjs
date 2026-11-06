import { chromium as rawChromium } from 'playwright';
import { temporaryDirectory } from './temp-directory.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export const chromium = {
  async launch(options = {}) {
    let removeDirectory;
    const directory = temporaryDirectory('doctorcre-proof-browser-', { after(cleanup) { removeDirectory = cleanup; } });
    const args = (options.args || []).filter(arg => !CHROMIUM_SAFETY_ARGS.some(required => arg.split('=')[0] === required.split('=')[0]));
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
