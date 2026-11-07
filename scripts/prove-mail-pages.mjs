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
  let timer, page, closing, disconnect, connection, expired = false, release;
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
    connection = Promise.resolve().then(() => engine.connectOverCDP(cdpUrl, { timeout: remaining() })).catch(() => { throw unavailable('Existing browser connection unavailable'); }).then(async browser => {
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
    await bounded(page.setViewportSize({ width: 390, height: 844 }));
    let reads = 0;
    page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/') || path === '/mcp') reads++; });
    const responsePending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/intelligence/mail-needs-partner', { timeout: remaining() });
    responsePending.catch(() => {});
    await bounded(page.goto(base.origin + '/', { timeout: remaining(), waitUntil: 'domcontentloaded' }));
    if (new URL(page.url()).origin !== base.origin || new URL(page.url()).pathname !== '/') throw unavailable('Home requires an existing signed-in session');
    const response = await bounded(responsePending);
    if ([401, 403].includes(response.status()) || !response.ok()) throw unavailable('Signed-in mailbox read unavailable');
    const raw = await bounded(response.json());
    if (!['ready', 'empty'].includes(raw?.state)) throw unavailable('Natural mailbox response unavailable');
    await bounded(page.waitForFunction(() => document.querySelector('section[aria-label="Mail priorities"]')?.getAttribute('aria-busy') === 'false', null, { timeout: remaining() }));
    let offset = 0;
    const seen = [];
    const assertions = [];
    const readsBeforePaging = reads;
    for (let index = 0; index < 5; index++) {
      const observation = await bounded(page.evaluate(async ({ raw, offset }) => {
        const { parseMailPage } = await import('/js/ui-mail-priorities.js');
        const snapshot = parseMailPage(raw);
        if (snapshot.state !== 'ready' || snapshot.items.length < 6) throw Object.assign(Error('At least six natural decisions required'), { insufficient: true });
        const host = document.querySelector('section[aria-label="Mail priorities"]');
        if (!host || host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') !== 'true') throw Error('Mail priorities must open automatically');
        const expected = snapshot.items.slice(offset, offset + 5);
        const rows = [...host.querySelectorAll('[data-mail-proposal]')];
        if (rows.length !== expected.length || rows.some((row, index) => {
          const item = expected[index];
          const paragraphs = [...row.querySelectorAll('p')].map(node => node.textContent);
          const button = row.querySelector('button');
          const link = row.querySelector('a');
          return row.dataset.mailProposal !== item.proposal_id
            || paragraphs[0] !== `${item.reasonLabel} · ${item.decision_date || 'Decision date unknown'}`
            || paragraphs[1] !== `Source time ${item.occurred_at || 'unknown'}`
            || !(button ? button.type === 'button' && button.textContent === `Review ${row.querySelector('h3').textContent}` : link?.textContent === 'Review in inbox' && (link.getAttribute('href') === '/inbox' || /^\/\?card=[^&]+$/.test(link.getAttribute('href'))));
        })) throw Error('Ranked rows, evidence or review destinations differ');
        const coverage = `Mailbox ${snapshot.coverage.mailbox} · Recorded inbound pending proposals · As of ${snapshot.coverage.as_of_day} · Recorded next date in UTC`;
        const expectedParagraphs = [coverage, ...(snapshot.more ? ['Only the first 25 ranked decisions are shown.'] : [])];
        if (JSON.stringify([...host.querySelectorAll(':scope > div > p')].map(n => n.textContent)) !== JSON.stringify(expectedParagraphs)) throw Error('Coverage or first-25 warning differs');
        const range = `Decisions ${offset + 1}–${Math.min(offset + 5, snapshot.items.length)} of ${snapshot.items.length} loaded`;
        if (host.querySelector('[data-mail-range]')?.textContent !== range) throw Error('Loaded range differs');
        const height = host.getBoundingClientRect().height;
        if (height >= 1600 || host.scrollWidth > host.clientWidth || document.documentElement.scrollWidth > innerWidth) throw Error('Panel exceeds phone dimensions');
        const buttons = [...host.querySelectorAll('button')];
        const next = buttons.find(n => n.textContent === 'Next mail');
        const previous = buttons.find(n => n.textContent === 'Previous mail');
        const more = offset + 5 < snapshot.items.length;
        if (!next || next.disabled === more || !previous || previous.disabled !== (offset === 0)) throw Error('Page controls differ');
        return { ids: rows.map(n => n.dataset.mailProposal), count: snapshot.items.length, height, range, more };
      }, { raw, offset })).catch(error => {
        if (error.message.includes('At least six natural decisions required')) throw unavailable('At least six natural decisions required');
        throw error;
      });
      seen.push(...observation.ids); assertions.push(observation);
      if (!observation.more) break;
      offset += 5;
      await bounded(page.getByRole('button', { name: 'Next mail', exact: true }).click({ timeout: remaining() }));
    }
    if (seen.length !== assertions[0].count || new Set(seen).size !== seen.length) throw Error('Loaded decisions not reached exactly once');
    if (reads !== readsBeforePaging) throw Error('Paging added business reads');
    const after = await bounded(releaseReader(base, { timeoutMs: remaining() }));
    if (after.source_commit !== release.source_commit) throw unavailable('Release changed during observation');
    return { status: 'passed', release, after, assertions, reads, seen, scope: 'natural_signed_in_read_only' };
  } catch (error) {
    if (expired) throw unavailable('Total proof deadline exceeded');
    throw error;
  } finally {
    clearTimeout(timer); expired = true;
    await Promise.allSettled([...(connection ? [connection] : []), ...pendingPages]);
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
