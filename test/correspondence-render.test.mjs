import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
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
    assert.equal(await page.locator('.evidence-item .evidence-source').count(), 2);
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
  assert.match(html, /Source:/); assert.doesNotMatch(html, /No (threads|meetings)|0 (threads|meetings)|<ol/);
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

test('a disposed mount cannot paint a previous deal after its read resolves', async () => {
  let resolve; const root = { innerHTML: '' };
  const dispose = mountEvidence(root, { client: { correspondenceReadiness: () => new Promise(done => { resolve = done; }) }, detail: {} });
  await Promise.resolve();
  dispose(); root.innerHTML = 'Demo next deal'; resolve(readiness);
  await new Promise(done => setTimeout(done, 0)); assert.equal(root.innerHTML, 'Demo next deal');
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
