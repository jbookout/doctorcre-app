import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright';
import { readAppRelease } from './app-release-reader.mjs';
const unavailable = message => Object.assign(Error(message), { exitCode: 78 });

export async function prove({ origin, expectedCommit, cdpUrl, timeoutMs = 30000, engine = chromium, releaseReader = readAppRelease, ancestry }) {
  const base = new URL(origin);
  if (base.href !== `${base.origin}/` || base.username || base.password || !['https:', 'http:'].includes(base.protocol)) throw unavailable('Expected an origin');
  const end = performance.now() + timeoutMs;
  const remaining = () => { const ms = Math.ceil(end - performance.now()); if (ms <= 0) throw unavailable('Total proof deadline exceeded'); return ms; };
  let timer, page, closing, disconnect, expired = false, release;
  const closePage = () => closing ||= page?.close();
  const pendingPages = new Set();
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; void closePage()?.catch(() => {}); reject(unavailable('Total proof deadline exceeded')); }, timeoutMs); });
  const bounded = operation => Promise.race([operation, deadline]);
  try {
    release = await bounded(releaseReader(base, { timeoutMs: remaining() }));
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit)) throw unavailable('Expected merge commit is required');
    if (release.source_commit !== expectedCommit) {
      const ancestor = ancestry || ((expected, observed) => new Promise(resolve => {
        execFile('git', ['merge-base', '--is-ancestor', expected, observed], { timeout: remaining(), killSignal: 'SIGKILL' }, error => resolve(!error));
      }));
      if (!await bounded(ancestor(expectedCommit, release.source_commit))) throw unavailable('Release does not contain expected merge, or ancestry is unknown');
    }
    if (!cdpUrl) throw unavailable('Existing signed-in browser session required');
    const endpoint = new URL(cdpUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || !['http:', 'ws:'].includes(endpoint.protocol)) throw unavailable('CDP endpoint must be local');
    const connection = Promise.resolve().then(() => engine.connectOverCDP(cdpUrl, { timeout: remaining() })).catch(() => { throw unavailable('Existing browser connection unavailable'); }).then(async browser => {
      // Playwright CDP close disconnects its transport; it does not terminate the shared browser.
      if (expired) { await browser.close(); throw unavailable('Total proof deadline exceeded'); }
      disconnect = () => browser.close();
      return browser;
    });
    const browser = await bounded(connection);
    let context;
    try { context = browser.contexts()[0]; } catch { throw unavailable('Existing browser context unavailable'); }
    if (!context) throw unavailable('Existing signed-in browser context required');
    const acquire = Promise.resolve().then(() => context.newPage()).catch(() => { throw unavailable('Existing browser page unavailable'); }).then(async acquired => {
      if (expired) { await acquired.close(); throw unavailable('Total proof deadline exceeded'); }
      page = acquired; return acquired;
    });
    pendingPages.add(acquire); acquire.finally(() => pendingPages.delete(acquire)).catch(() => {});
    await bounded(acquire);
    const responsePending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/intelligence/mail-needs-partner', { timeout: remaining() });
    responsePending.catch(() => {});
    await bounded(page.goto(base.origin + '/', { timeout: remaining(), waitUntil: 'domcontentloaded' }));
    if (new URL(page.url()).origin !== base.origin || new URL(page.url()).pathname !== '/') throw unavailable('Home requires an existing signed-in session');
    const response = await bounded(responsePending);
    if ([401, 403].includes(response.status()) || !response.ok()) throw unavailable('Signed-in mailbox read unavailable');
    const raw = await bounded(response.json());
    if (!['ready', 'empty'].includes(raw?.state)) throw unavailable('Natural mailbox response unavailable');
    await bounded(page.waitForFunction(() => document.querySelector('section[aria-label="Mail priorities"]')?.getAttribute('aria-busy') === 'false', null, { timeout: remaining() }));
    const assertions = await bounded(page.evaluate(async raw => {
      const { parseMailPage } = await import('/js/ui-mail-priorities.generated.js');
      const snapshot = parseMailPage(raw);
      const host = document.querySelector('section[aria-label="Mail priorities"]');
      if (!host) throw Error('Mail priorities panel missing');
      if (host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') !== 'true') throw Error('Mail priorities must open automatically');
      const rows = [...host.querySelectorAll('[data-mail-proposal]')];
      const expected = snapshot.items;
      if (rows.length !== expected.length || rows.some((row, index) => {
        const item = expected[index];
        const paragraphs = [...row.querySelectorAll('p')].map(node => node.textContent);
        return row.dataset.mailProposal !== item.proposal_id
          || paragraphs[0] !== `${item.reasonLabel} · ${item.decision_date || 'Decision date unknown'}`
          || paragraphs[1] !== `Source time ${item.occurred_at || 'unknown'}`;
      })) throw Error('Visible ranked decisions differ from registered read');
      const coverage = `Mailbox ${snapshot.coverage.mailbox} · Recorded inbound pending proposals · As of ${snapshot.coverage.as_of_day} · Recorded next date in UTC`;
      const expectedParagraphs = [coverage,
        ...(snapshot.state === 'empty' ? ['No recorded pending mail decisions.'] : []),
        ...(snapshot.more ? ['Only the first 25 ranked decisions are shown.'] : [])];
      const paragraphs = [...host.querySelectorAll(':scope > div > p')].map(node => node.textContent);
      if (JSON.stringify(paragraphs) !== JSON.stringify(expectedParagraphs)) throw Error('Mailbox coverage, empty state or page limit differs from registered read');
      return { count: rows.length, populated: rows.length ? 'observed' : 'unobserved', order_reasons_dates: true };
    }, raw));
    const review = page.locator('section[aria-label="Mail priorities"] li button').first();
    if (await bounded(review.count())) {
      await bounded(review.click({ timeout: remaining() }));
      await bounded(page.getByRole('button', { name: 'Close review', exact: true }).waitFor({ timeout: remaining() }));
      assertions.existing_review = 'opened without confirmation';
    } else assertions.existing_review = 'unobserved';
    const after = await bounded(releaseReader(base, { timeoutMs: remaining() }));
    if (after.source_commit !== release.source_commit) throw unavailable('Release changed during observation');
    return { status: 'passed', release, after, assertions, scope: 'natural_signed_in_read_only' };
  } catch (error) {
    if (expired) throw unavailable('Total proof deadline exceeded');
    throw error;
  } finally {
    clearTimeout(timer); expired = true;
    await Promise.allSettled(pendingPages);
    try { await closePage(); } finally { await disconnect?.(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'expected-commit': { type: 'string' }, 'cdp-url': { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' } } });
    const timeoutMs = Number(values['timeout-ms']);
    if (!values.origin || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw unavailable('Use --origin with optional --expected-commit, --cdp-url and --timeout-ms 1..30000');
    console.log(JSON.stringify(await prove({ origin: values.origin, expectedCommit: values['expected-commit'], cdpUrl: values['cdp-url'], timeoutMs })));
  } catch (error) { console.log(JSON.stringify({ status: 'unproven', error: error.message })); process.exitCode = error.exitCode || 1; }
}
