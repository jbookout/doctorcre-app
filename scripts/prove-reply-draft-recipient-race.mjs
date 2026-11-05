import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

const usage = 'Usage: node scripts/prove-reply-draft-recipient-race.mjs --origin URL --timeout-ms 30000';
function options(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw Error(usage);
  const url = new URL(args[1]);
  const timeout = Number(args[3]);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw Error(usage);
  return { origin: url.origin, timeout };
}

async function prove({ origin, timeout }) {
  let browser, timer, expired = false;
  const work = async () => {
    browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout });
    if (expired) { await browser.close(); throw Error('Proof timeout'); }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const modules = new Set();
    let requests = 0, violation;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' || url.origin !== origin || ++requests > 64
        || !(url.pathname === '/__reply-draft-proof' || url.pathname === '/app-release' || /^\/js\/[\w./-]+\.js$/.test(url.pathname))) {
        violation = 'Proof refused an outbound request';
        return route.abort();
      }
      if (url.pathname === '/__reply-draft-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reply draft proof</title>' });
      try {
        const response = await route.fetch({ timeout, maxRedirects: 0 });
        if (!response.ok()) throw Error(`Protected or unavailable asset ${url.pathname} (${response.status()})`);
        const body = await response.body();
        if (body.length > 1048576) throw Error('Proof asset exceeds 1 MiB');
        if (url.pathname.endsWith('.js')) modules.add(url.href);
        await route.fulfill({ response, body });
      } catch (error) {
        violation = error.message;
        await route.abort();
      }
    });
    await page.goto(origin + '/__reply-draft-proof');
    const result = await page.evaluate(async () => {
      const check = (condition, message) => { if (!condition) throw Error(message); };
      const release = await (await fetch('/app-release')).json();
      check(release.service === 'doctorcre-app' && /^[0-9a-f]{40}$/.test(release.source_commit), 'Release identity unavailable');
      const fixture = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && release.environment === 'fixture';
      check(fixture || (release.environment === 'production' && release.source_commit !== '0'.repeat(40)), 'Deployed release identity required');
      const { createReplyDeviceDrafts } = await import('/js/ui-email-actions.js');
      check(typeof createReplyDeviceDrafts === 'function', 'Missing createReplyDeviceDrafts export');
      const data = new Map();
      const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
      const row = { id: 'synthetic-proposal', version: 3, reply_draft: { subject: 'Synthetic', body: 'Synthetic reply', to: ['a@example.test'], cc: ['b@example.test'] } };
      const snapshot = { baseVersion: 3, ...row.reply_draft };
      const drafts = createReplyDeviceDrafts(storage, 'synthetic-actor');
      const assertions = [];
      for (const field of ['to', 'cc']) {
        const newer = { ...snapshot, [field]: ['new@example.test'] };
        check(drafts.save(row.id, snapshot) && drafts.save(row.id, newer), 'Synthetic persistence failed');
        drafts.remove(row.id, snapshot);
        check(JSON.stringify(drafts.restore(row)?.[field]) === JSON.stringify(newer[field]), `${field}-only edit lost after late receipt`);
        assertions.push(`${field}-only edit retained`);
        check(createReplyDeviceDrafts(storage, 'other-actor').restore(row) === null, 'Actor isolation failed');
        check(drafts.restore({ ...row, id: 'other-proposal' }) === null, 'Proposal isolation failed');
        drafts.remove(row.id, newer);
        check(drafts.restore(row) === null, 'Matching snapshot was not removed');
      }
      assertions.push('matching snapshot removed', 'actor and proposal isolated');
      const after = await (await fetch('/app-release')).json();
      check(after.source_commit === release.source_commit && after.environment === release.environment, 'Release changed during proof');
      return { release, fixture, assertions };
    });
    if (violation) throw Error(violation);
    return { origin, ...result, loaded_module_urls: [...modules].sort(), requests, evidence: 'synthetic deployed-module behavior; no natural records read' };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(Error('Proof timeout')); }, timeout); })]);
  } finally {
    clearTimeout(timer);
    await browser?.close();
  }
}

try {
  const config = options(process.argv.slice(2));
  if (!config) console.log(usage);
  else {
    const receipt = JSON.stringify(await prove(config));
    if (Buffer.byteLength(receipt) > 65536) throw Error('Receipt exceeds 64 KiB');
    console.log(receipt);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
