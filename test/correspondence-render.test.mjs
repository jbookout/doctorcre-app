import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { JSDOM } from 'jsdom';
import { renderEvidence, loadEvidence, mountEvidence } from '../js/correspondence.js';
import { correspondenceState, meetingEvidence } from '../js/correspondence-model.js';
import { identity, found, readiness, meeting } from './fixtures/correspondence.mjs';
const readyView = { threads: correspondenceState(found, identity), meetings: meetingEvidence([meeting]) };

test('390px and iPad fixture evidence stays readable, sourced, read-only and touch-sized', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const css = await readFile(new URL('../css/correspondence.css', import.meta.url), 'utf8');
  const system = await readFile(new URL('../css/system.css', import.meta.url), 'utf8');
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<style>${system}\n${css}</style><main style="padding:16px">${renderEvidence(readyView)}</main>`);
    assert.equal(await page.locator('.evidence-item').count(), 2);
    assert.equal(await page.locator('.evidence-item .evidence-source').count(), 0);
    assert.equal(await page.locator('button,input,textarea,a').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const summary = page.locator('.evidence-item summary').first();
    const box = await summary.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44);
    await summary.click(); assert.equal(await page.locator('.evidence-item details').first().getAttribute('open'), '');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.correspondence-evidence').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
});

test('unavailable is intentional visible copy with source and no zero or success list', () => {
  const html = renderEvidence({});
  assert.match(html, /Threads unavailable/); assert.match(html, /Meeting evidence unavailable/);
  assert.doesNotMatch(html, /Source:/); assert.doesNotMatch(html, /No (threads|meetings)|0 (threads|meetings)|<ol/);
});

test('recorded native identity is read verbatim; installation counts cannot stand in for a deal timeline', async () => {
  const calls = [];
  const state = await loadEvidence({ correspondenceReadiness: async args => { calls.push(['readiness', args]); return readiness; },
    readCorrespondenceThread: async args => { calls.push(['thread', args]); return found; } },
  { activities: [{ ...meeting, detail: { native_identity: identity } }] });
  assert.deepEqual(calls, [['readiness', {}], ['thread', identity]]);
  assert.equal(state.threads.state, 'ready'); assert.equal(state.meetings.state, 'ready');
});

test('refused, unanswered and failed reads settle as unavailable', async () => {
  for (const read of [async () => { throw new Error('demo refusal'); }, async () => null, () => new Promise(() => {})]) {
    const state = await loadEvidence({ correspondenceReadiness: read, readCorrespondenceThread: read },
      { activities: [{ ...meeting, detail: { native_identity: identity } }] }, { timeoutMs: 10 });
    assert.equal(state.threads.state, 'unavailable'); assert.equal(state.threads.count, null);
  }
});

test('without native provenance no thread id is fabricated and no zero is shown', async () => {
  let calls = 0;
  const state = await loadEvidence({ correspondenceReadiness: async () => readiness,
    readCorrespondenceThread: async () => { calls++; return found; } }, { deal: { id: 'demo-deal' } });
  assert.equal(calls, 0); assert.equal(state.threads.state, 'unavailable');
});

test('mixed correspondence pointers preserve unavailable coverage instead of a successful survivor count', async t => {
  const valid = { ...meeting, kind: 'correspondence', detail: { native_identity: identity } };
  const cases = {
    'missing identity': { ...valid, detail: {} },
    'malformed identity': { ...valid, detail: { native_identity: { ...identity, native_id_epoch: -1 } } },
    'missing source': { ...valid, source: null },
    'mixed invalid and missing provenance': { ...valid, detail: {}, source: null },
  };
  for (const [label, invalid] of Object.entries(cases)) {
    await t.test(label, async () => {
      const calls = [];
      const state = await loadEvidence({ correspondenceReadiness: async () => readiness,
        readCorrespondenceThread: async args => { calls.push(args); return found; } },
      { activities: [valid, invalid, meeting] });
      assert.equal(state.threads.state, 'unavailable');
      assert.equal(state.threads.count, null);
      assert.deepEqual(state.threads.items, []);
      assert.equal(state.threads.reason, 'thread_coverage_unavailable');
      assert.deepEqual(calls, [identity]);
      assert.equal(state.meetings.state, 'ready');
      const html = renderEvidence(state);
      assert.match(html, /Threads unavailable/);
      assert.doesNotMatch(html, /provenance|Source:/);
    });
  }
});

test('an ordinary meeting without a mail pointer does not invalidate correspondence coverage', async () => {
  const state = await loadEvidence({ correspondenceReadiness: async () => readiness,
    readCorrespondenceThread: async () => found },
  { activities: [{ ...meeting, kind: 'correspondence', detail: { native_identity: identity } }, meeting] });
  assert.equal(state.threads.state, 'ready');
  assert.equal(state.threads.count, 1);
  assert.equal(state.meetings.state, 'ready');
});

test('equal native identities with reordered JSON fields produce one read and one receipt item', async () => {
  const reordered = { native_id_epoch: identity.native_id_epoch, native_id: identity.native_id, source_system: identity.source_system };
  const calls = [];
  const state = await loadEvidence({ correspondenceReadiness: async () => readiness,
    readCorrespondenceThread: async args => { calls.push(args); return found; } },
  { activities: [identity, reordered].map(native_identity => ({ ...meeting, kind: 'correspondence', detail: { native_identity } })) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], identity);
  assert.equal(state.threads.state, 'ready');
  assert.equal(state.threads.count, 1);
  assert.deepEqual(state.threads.items.map(item => item.id), [found.receipts[0].read_receipt_id]);
});

test('a disposed mount cannot paint a previous deal after its read resolves', async () => {
  let resolve; const root = new JSDOM('<main></main>').window.document.querySelector('main');
  const dispose = mountEvidence(root, { client: { correspondenceReadiness: () => new Promise(done => { resolve = done; }) }, detail: {} });
  await Promise.resolve();
  dispose(); root.innerHTML = 'Demo next deal'; resolve(readiness);
  await new Promise(done => setTimeout(done, 0)); assert.equal(root.innerHTML, 'Demo next deal');
});

test('meeting disclosure and keyboard focus survive delayed read settlement and timeout', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const modules = Object.fromEntries(await Promise.all(['correspondence.js', 'correspondence-model.js'].map(async name =>
    [`/js/${name}`, await readFile(new URL(`../js/${name}`, import.meta.url), 'utf8')])));
  for (const phase of ['readiness', 'thread']) {
    for (const outcome of ['settled', 'timeout']) {
      await t.test(`${phase} ${outcome}`, async t => {
        const page = await browser.newPage(); t.after(() => page.close());
        await page.route('http://evidence.test/**', route => {
          const source = modules[new URL(route.request().url()).pathname];
          return route.fulfill({ contentType: source ? 'text/javascript' : 'text/html',
            body: source ?? '<main id="evidence"></main>' });
        });
        await page.goto('http://evidence.test/');
        await page.evaluate(async ({ phase, outcome, identity, found, readiness, meeting }) => {
          const { mountEvidence } = await import('/js/correspondence.js');
          const pending = () => new Promise(resolve => { window.resolveEvidenceRead = resolve; });
          const activities = phase === 'readiness' && outcome === 'timeout' ? [meeting]
            : [meeting, { ...meeting, kind: 'correspondence', detail: { native_identity: identity } }];
          mountEvidence(document.querySelector('#evidence'), { timeoutMs: 3000, detail: { activities }, client: {
            correspondenceReadiness: phase === 'readiness' ? pending : async () => readiness,
            readCorrespondenceThread: phase === 'thread' ? pending : async () => found,
          } });
        }, { phase, outcome, identity, found, readiness, meeting });
        const summary = page.locator('[data-kind="meeting"] summary');
        const disclosure = page.locator('[data-kind="meeting"] details');
        await summary.focus();
        await summary.press('Enter');
        assert.equal(await disclosure.getAttribute('open'), '');
        assert.equal(await summary.evaluate(el => document.activeElement === el), true);
        assert.equal(await page.locator('[data-state="loading"]').count(), 1);
        if (outcome === 'settled') {
          await page.evaluate(answer => window.resolveEvidenceRead(answer), phase === 'readiness' ? readiness : found);
        }
        await page.waitForFunction(() => !document.querySelector('[data-state="loading"]'));
        assert.equal(await disclosure.getAttribute('open'), '', 'settlement preserves the open meeting');
        assert.equal(await summary.evaluate(el => document.activeElement === el), true, 'settlement preserves keyboard focus');
        if (outcome === 'settled') assert.equal(await page.locator('[data-kind="thread"]').count(), 1);
        else assert.equal(await page.locator('[data-state="unavailable"]').textContent().then(text => text.includes('Threads unavailable')), true);
        await summary.press('Enter');
        assert.equal(await disclosure.getAttribute('open'), null, 'the preserved summary remains operable');
      });
    }
  }
});

test('meeting prose is escaped and untrusted metadata is never rendered', () => {
  const html = renderEvidence({ ...readyView, meetings: meetingEvidence([{ ...meeting, summary: '<img src=x onerror=alert(1)>' }]) });
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
});

test('both record panel controllers wire Evidence using the shared renderer', async () => {
  const pipeline = await readFile(new URL('../js/pipeline.js', import.meta.url), 'utf8');
  const business = await readFile(new URL('../js/workspace-business.js', import.meta.url), 'utf8');
  const deals = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(pipeline, /mountEvidence\(/);
  assert.match(business, /loadEvidence\(/);
  assert.match(business, /renderEvidence\(/);
  assert.match(deals, /mountEvidence\(/, 'the current /deals route uses app.js, so its record dialog also needs Evidence');
});
