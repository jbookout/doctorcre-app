import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from 'es-module-lexer';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function exercise(page, asset) {
  return page.evaluate(async asset => {
    const { mountEmailActions, actionModel } = await import(asset);
    const assertions = [];
    const check = (value, label) => { if (!value) throw Error(label); assertions.push(label); };
    const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
    const row = { id: 'synthetic-proposal', version: 1, kind: 'file_to_deal', deal: 'd1', source: { activity_id: 'synthetic-activity', evidence_quote: 'Synthetic evidence' } };
    const board = { deals: [{ id: 'd1', name: 'Synthetic One' }, { id: 'd2', name: 'Synthetic Two' }] };
    const exact = args => ({ contract: 'email-followups.v2', proposal_id: row.id, deal: args.deal, base_version: 1, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote, requires_confirmation: true, proposal_digest: `sha256:${'a'.repeat(64)}` });
    function mount(overrides = {}) {
      const host = document.createElement('section'); document.body.append(host);
      const counts = { denied: 0, preview: 0, create: 0, confirm: 0 };
      const model = actionModel();
      const listeners = {};
      const add = host.addEventListener.bind(host);
      host.addEventListener = (type, fn, ...rest) => { listeners[type] = fn; add(type, fn, ...rest); };
      const client = { getBoard: async () => board,
        previewEmailFiling: async args => { counts.preview++; return exact(args); },
        createDeal: async () => { counts.create++; return { deal_id: 'created' }; },
        confirmEmailFiling: async args => { counts.confirm++; return { ok: true, proposal_id: row.id, status: 'confirmed', disposition: 'filed', version: 2, note: args.note, deal: args.deal, activity_id: row.source.activity_id }; }, ...overrides };
      const view = mountEmailActions(host, row, client, model, () => {}, () => {
        check(!host.querySelector('form,input,select,textarea,button,a'), 'private controls removed before denial'); counts.denied++;
      });
      const click = action => { const node = host.querySelector(`[data-followup="${action}"]`); if (!node) throw Error(`Missing ${action}`); node.click(); };
      const submit = () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const fill = (key, value) => { const node = host.querySelector(`[data-field="${key}"]`); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };
      const stale = () => {
        const oldState = model.state;
        const target = document.createElement('button'); target.dataset.followup = 'confirm';
        listeners.click({ target }); listeners.submit({ preventDefault() {} });
        view.update(row, true);
        check(model.state === oldState && !host.querySelector('button,form'), 'retained handlers and update cannot revive editor');
      };
      const close = () => { view.dispose(); host.remove(); };
      return { host, counts, model, view, click, fill, submit, stale, close };
    }
    for (const error of [{ status: 401 }, { status: 403 }, { code: 'session_changed' }]) {
      const m = mount({ getBoard: async () => { throw error; } });
      m.click('file'); await tick();
      check(m.counts.denied === 1, `board denial ${JSON.stringify(error)}`); m.stale();
      check(m.counts.preview + m.counts.create + m.counts.confirm === 0, 'retired editor makes no calls'); m.close();
    }
    for (const error of [{ status: 401 }, { status: 403 }, { code: 'session_changed' }]) {
      for (const replacement of [false, true]) {
        let rejectBoard;
        const m = mount({ getBoard: () => new Promise((resolve, reject) => { rejectBoard = reject; }) });
        m.click('file'); m.click('cancel');
        check(m.model.state.kind === 'idle', 'pending deal editor cancels');
        if (replacement) { m.click('new'); m.fill('name', 'Synthetic'); m.fill('client', 'Synthetic'); }
        const form = m.host.querySelector('form');
        rejectBoard(error); await tick();
        check(m.counts.denied === 1 && !m.host.querySelector('form,button,input,select,textarea,a'), `canceled board denial retires ${replacement ? 'replacement' : 'ready'} ${JSON.stringify(error)}`);
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        m.stale(); await tick();
        check(m.counts.preview + m.counts.create + m.counts.confirm === 0, 'canceled board denial prevents new calls'); m.close();
      }
    }
    {
      const m = mount({ getBoard: async () => { throw Error('network'); } });
      m.click('file'); await tick();
      check(m.counts.denied === 0 && m.host.textContent.includes('Could not load deals'), 'network failure remains recoverable');
      m.click('cancel'); m.click('new'); m.fill('name', 'Synthetic new'); m.fill('client', 'Synthetic client'); m.submit(); await tick();
      check(m.model.state.kind === 'preview', 'network cancel returns ready and new creation previews');
      m.click('cancel'); check(m.model.state.kind === 'created', 'created deal survives cancelled filing');
      m.click('preview-created'); await tick(); m.click('confirm'); await tick();
      check(m.model.state.kind === 'done' && m.counts.create === 1, 'created recovery confirms without duplicate creation'); m.close();
    }
    for (const disposed of [false, true]) {
      let resolve;
      const m = mount({ getBoard: () => new Promise(done => { resolve = done; }), previewEmailFiling: async () => { throw { status: 401 }; } });
      m.click('file');
      if (disposed) m.view.dispose();
      else { m.submit(); await tick(); check(m.counts.denied === 1, 'preview denial retires'); }
      resolve(board); await tick(); m.stale();
      check(!m.host.textContent.includes('Synthetic One'), disposed ? 'disposed ignores late board' : 'retired ignores late board');
      if (!disposed) m.close(); else m.host.remove();
    }
    {
      const writes = [];
      const m = mount({ confirmEmailFiling: async args => { writes.push(args); if (writes.length === 1) throw Error('lost'); return { ok: true, proposal_id: row.id, status: 'confirmed', disposition: 'filed', version: 2, note: args.note, deal: args.deal, activity_id: row.source.activity_id }; } });
      m.click('file'); await tick();
      const search = m.host.querySelector('[data-deal-search]'); search.value = 'Two'; search.dispatchEvent(new Event('input', { bubbles: true }));
      check(m.host.querySelector('option[value=d2]')?.textContent === 'Synthetic Two', 'successful deal search');
      m.fill('deal', 'd2'); m.submit(); await tick();
      check(m.model.state.kind === 'preview' && m.model.state.request.deal === 'd2', 'exact target preview');
      m.click('confirm'); await tick(); check(m.model.state.kind === 'unknown', 'unknown write retains recovery');
      m.click('replay'); await tick();
      check(m.model.state.kind === 'done' && JSON.stringify(writes[0]) === JSON.stringify(writes[1]), 'pending recovery replays identical request'); m.close();
    }
    for (const stage of ['create', 'created-preview', 'confirm']) {
      const error = { code: 'session_changed' };
      const m = mount(stage === 'create' ? { createDeal: async () => { throw error; } } : stage === 'created-preview' ? { previewEmailFiling: async () => { throw error; } } : { confirmEmailFiling: async () => { throw error; } });
      if (stage !== 'confirm') { m.click('new'); m.fill('name', 'Synthetic'); m.fill('client', 'Synthetic'); }
      else { m.click('file'); await tick(); }
      m.submit(); await tick();
      if (stage === 'confirm') { m.click('confirm'); await tick(); }
      check(m.counts.denied === 1, `${stage} denial retires`); m.stale(); m.close();
    }
    {
      const m = mount({ previewEmailFiling: async () => { throw Error('offline'); } });
      m.click('file'); await tick(); m.submit(); await tick();
      check(m.model.state.kind === 'refused' && m.counts.denied === 0, 'ordinary preview failure requires fresh review');
      m.click('refresh'); check(m.model.state.kind === 'idle', 'refresh returns ready');
      m.click('file'); await tick(); m.click('cancel');
      check(m.model.state.kind === 'idle', 'successful deal editor cancels'); m.close();
    }
    {
      const requests = [];
      const m = mount({ createDeal: async request => { requests.push(request); if (requests.length === 1) throw Error('lost'); return { deal_id: 'created' }; }, previewEmailFiling: async () => { throw Error('offline'); } });
      m.click('new'); m.fill('name', 'Synthetic'); m.fill('client', 'Synthetic'); m.submit(); await tick();
      check(m.model.state.kind === 'creation-unknown', 'uncertain creation keeps request');
      m.click('replay'); await tick();
      check(m.model.state.kind === 'created' && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), 'creation replay and failed preview retain created deal'); m.close();
    }
    return assertions;
  }, asset);
}

class Unavailable extends Error {}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prove({ origin, timeoutMs = 30000 }) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.origin !== origin || base.username || base.password) throw Error('Expected a bare HTTP origin');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('timeout-ms must be 1..30000');
  const controller = new AbortController(), assets = new Map();
  const deadline = Date.now() + timeoutMs;
  let requests = 0, browserPromise, timer, routeFailure;
  const read = async url => {
    if (url.origin !== origin || ++requests > 10) throw Error('Request budget or origin violation');
    let response;
    try { response = await fetch(url, { redirect: 'manual', signal: controller.signal }); }
    catch { throw new Unavailable('Release or asset evidence unavailable'); }
    if (!response.ok) throw new Unavailable(`Evidence HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 5 * 1024 * 1024) throw Error('Evidence byte limit'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const work = async () => {
    const releaseBytes = await read(new URL('/app-release', base));
    let release;
    try { release = JSON.parse(releaseBytes.toString()); } catch { throw new Unavailable('Release identity unavailable'); }
    if (release.service !== 'doctorcre-app' || !/^[a-f0-9]{40}$/.test(release.source_commit || '') || /^0+$/.test(release.source_commit)) throw new Unavailable('Release identity unavailable');
    const manifest = JSON.parse((await read(new URL('/artifact-manifest.json', base))).toString());
    assert.equal(manifest.schema, 'doctorcre-static-artifact.v1', 'Manifest schema');
    assert.equal(manifest.source_commit, release.source_commit, 'Manifest release identity');
    assert.ok(Array.isArray(manifest.files), 'Manifest files');
    const entries = new Map();
    for (const file of manifest.files) {
      assert.ok(typeof file.path === 'string' && !entries.has(file.path), 'Unique manifest path');
      entries.set(file.path, file);
    }
    const load = async path => {
      if (assets.has(path)) return;
      assert.match(path, /^js\/[A-Za-z0-9_.-]+\.js$/, 'Admitted module path');
      const entry = entries.get(path); assert.ok(entry, 'Module in manifest');
      const bytes = await read(new URL(`/${path}`, base));
      assert.equal(bytes.length, entry.bytes, 'Asset length'); assert.equal(hash(bytes), entry.sha256, 'Asset hash');
      assets.set(path, bytes);
      const [imports] = await parse(bytes.toString());
      for (const item of imports) {
        assert.ok(item.n && item.n.startsWith('./'), 'Only static relative module dependencies');
        const dependency = new URL(item.n, new URL(`/${path}`, base));
        assert.equal(dependency.origin, origin); assert.equal(dependency.search + dependency.hash, '');
        await load(dependency.pathname.slice(1));
      }
    };
    await load('js/ui-email-actions.js');
    if (controller.signal.aborted || Date.now() >= deadline) throw new Unavailable('Proof timeout');
    browserPromise = chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, deadline - Date.now()) });
    const browser = await browserPromise;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && route.request().method() === 'GET' && url.pathname === '/__email-proof__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      const bytes = url.origin === origin && !url.search && !url.hash && route.request().method() === 'GET' && assets.get(url.pathname.slice(1));
      if (bytes) return route.fulfill({ contentType: 'text/javascript', body: bytes });
      routeFailure = Error('Unexpected browser request'); await route.abort();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/__email-proof__`);
    const assertions = await exercise(page, `${origin}/js/ui-email-actions.js`);
    if (routeFailure) throw routeFailure;
    return { release, assets: [...assets].map(([path, bytes]) => ({ path, sha256: hash(bytes) })), assertions, requests, synthetic: true };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Unavailable('Proof timeout')); }, timeoutMs); })]);
  } finally {
    clearTimeout(timer); controller.abort();
    await (await browserPromise?.catch(() => null))?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--timeout-ms') throw Error('Usage: --origin <origin> --timeout-ms <milliseconds>');
    console.log(JSON.stringify(await prove({ origin: args[1], timeoutMs: Number(args[3]) })));
  } catch (error) { console.error(error.message); process.exitCode = error instanceof Unavailable ? 78 : 1; }
}
