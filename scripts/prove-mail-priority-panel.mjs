import assert from 'node:assert/strict';
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
    const connection = engine.connectOverCDP(cdpUrl, { timeout: remaining() }).then(async browser => {
      // Playwright CDP close disconnects its transport; it does not terminate the shared browser.
      if (expired) { await browser.close(); throw unavailable('Total proof deadline exceeded'); }
      disconnect = () => browser.close();
      return browser;
    });
    const browser = await bounded(connection);
    const context = browser.contexts()[0];
    if (!context) throw unavailable('Existing signed-in browser context required');
    const acquire = context.newPage().then(async acquired => {
      if (expired) { await acquired.close(); throw unavailable('Total proof deadline exceeded'); }
      page = acquired; return acquired;
    });
    pendingPages.add(acquire); acquire.finally(() => pendingPages.delete(acquire)).catch(() => {});
    await bounded(acquire);
    await bounded(page.goto(base.origin + '/', { timeout: remaining(), waitUntil: 'domcontentloaded' }));
    if (new URL(page.url()).origin !== base.origin || new URL(page.url()).pathname !== '/') throw unavailable('Home requires an existing signed-in session');
    const show = page.getByRole('button', { name: 'Show mail priorities', exact: true });
    try { await bounded(show.waitFor({ timeout: remaining() })); } catch { throw unavailable('Mail priorities or signed-in Home unavailable'); }
    const responsePending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/intelligence/mail-needs-partner', { timeout: remaining() });
    responsePending.catch(() => {});
    await bounded(show.click({ timeout: remaining() }));
    const response = await bounded(responsePending);
    if ([401, 403].includes(response.status()) || !response.ok()) throw unavailable('Signed-in mailbox read unavailable');
    const raw = await bounded(response.json());
    if (!['ready', 'empty'].includes(raw?.state)) throw unavailable('Natural mailbox response unavailable');
    await bounded(page.waitForFunction(() => document.querySelector('section[aria-label="Mail priorities"]')?.getAttribute('aria-busy') === 'false', null, { timeout: remaining() }));
    const assertions = await bounded(page.evaluate(async raw => {
      const { parseMailPage } = await import('/js/ui-mail-priorities.js');
      const snapshot = parseMailPage(raw);
      const host = document.querySelector('section[aria-label="Mail priorities"]');
      if (!host) throw Error('Mail priorities panel missing');
      const rows = [...host.querySelectorAll('[data-mail-proposal]')];
      const expected = snapshot.items;
      if (rows.length !== expected.length || rows.some((row, index) => row.dataset.mailProposal !== expected[index].proposal_id || !row.textContent.includes(expected[index].reasonLabel) || !row.textContent.includes(expected[index].decision_date || 'Decision date unknown'))) throw Error('Visible ranked decisions differ from registered read');
      if (!host.textContent.includes(snapshot.coverage.mailbox) || !host.textContent.includes(snapshot.coverage.as_of_day)) throw Error('Mailbox coverage missing');
      if (snapshot.state === 'empty' && !host.textContent.includes('No recorded pending mail decisions.')) throw Error('Empty state missing');
      return { count: rows.length, populated: rows.length ? 'observed' : 'unobserved', order_reasons_dates: true };
    }, raw));
    const review = page.getByRole('region', { name: 'Mail priorities', exact: true }).getByRole('button', { name: /^Review / }).first();
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
    if (!release) throw unavailable('Release identity unavailable');
    throw error;
  } finally {
    clearTimeout(timer); expired = true;
    try { await closePage(); } finally { await disconnect?.(); }
    for (const acquisition of pendingPages) void acquisition.catch(() => {});
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
