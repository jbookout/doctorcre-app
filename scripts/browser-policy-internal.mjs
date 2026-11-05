import { temporaryDirectory } from './temp-directory.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

function launchOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError('Chromium options must be a plain object');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (!['args', 'headless', 'timeout'].includes(key)) throw new TypeError(`Chromium option refused: ${String(key)}`);
  }
  const { args = [], headless = true, timeout = 30_000 } = options;
  if (typeof headless !== 'boolean' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 120_000) {
    throw new TypeError('Chromium requires boolean headless and a timeout in (0, 120000] ms');
  }
  if (!Array.isArray(args) || args.length > 128) throw new TypeError('Chromium args must be an array of at most 128 flags');
  const flags = new Map(CHROMIUM_SAFETY_ARGS.map(arg => [arg.split('=')[0], arg]));
  const extras = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > 8192 || !/^--[a-zA-Z0-9-]+(?:=[^\s\0]+)?$/.test(arg)) {
      throw new TypeError('Chromium args must be individual long flags');
    }
    const name = arg.split('=')[0];
    if (['--no-use-mock-keychain', '--user-data-dir'].includes(name)) throw new TypeError(`Chromium flag refused: ${name}`);
    if (flags.has(name)) {
      if (flags.get(name) !== arg) throw new TypeError(`Chromium conflicting flag: ${name}`);
    } else {
      flags.set(name, arg);
      extras.push(arg);
    }
  }
  return { args: extras, headless, timeout };
}

// This internal seam lets tests observe the exact engine call without exporting a raw launcher to callers.
export function createChromiumLauncher(engine) {
  return async function launchChromium(options = {}) {
    const validated = launchOptions(options);
    let release;
    const directory = temporaryDirectory('doctorcre-chromium-', { after(cleanup) { release = cleanup; } });
    try {
      const browser = await engine.launch({
        headless: validated.headless,
        timeout: validated.timeout,
        args: [...CHROMIUM_SAFETY_ARGS, ...validated.args],
        env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory },
      });
      const close = browser.close.bind(browser);
      let closing;
      browser.close = (...args) => {
        closing ??= Promise.resolve().then(() => close(...args)).finally(release);
        return closing;
      };
      browser.once?.('disconnected', release);
      if (browser.isConnected?.() === false) release();
      return browser;
    } catch (error) {
      release();
      throw error;
    }
  };
}
