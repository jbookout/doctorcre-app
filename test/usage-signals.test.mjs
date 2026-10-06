import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageCapture } from '../js/usage-signals.js';
import { JSDOM } from 'jsdom';
import { mountUsageCapture } from '../js/usage-signals.js';

const releaseSha = 'a'.repeat(40);
const timestamp = '2026-10-05T12:00:00.000Z';
test('capture rejects client fields and free text before transport', async () => {
  const sent = [];
  const capture = createUsageCapture({ partner: 'joe', releaseSha, now: () => new Date(timestamp), send: event => sent.push(event) });
  const fixture = { name: 'Synthetic Client', record: { practice: 'Synthetic Practice' }, search: 'Synthetic Client', chat: 'Lease for Synthetic Practice' };
  assert.equal(await capture.record('screen_viewed', 'home', fixture), false);
  for (const value of ['Synthetic Client', fixture, '/deals?client=Synthetic']) assert.equal(await capture.record('screen_viewed', value), false);
  assert.equal(await capture.record('Lease for Synthetic Practice', 'home'), false);
  assert.deepEqual(sent, []);
  assert.equal(await capture.record('screen_viewed', 'home'), true);
  assert.deepEqual(sent, [{ event_name: 'screen_viewed', screen: 'home', partner: 'joe', release_sha: releaseSha, timestamp }]);
});

test('browser events carry only fixed fields and the local switch stops capture', async () => {
  const dom = new JSDOM('<button class="primary-action">Synthetic Client</button><p role="alert" hidden></p><button id="usageCaptureToggle"></button>', { url: 'https://app.doctorcre.com/deals?client=Synthetic' });
  const calls = [];
  const fetch = async (url, options) => {
    if (url === '/app-release') return Response.json({ source_commit: releaseSha });
    if (url.endsWith('/session')) return Response.json({ schema: 'doctorcre-usage.v1', enabled: true, partner: 'joe', csrf_token: 'fixture' });
    calls.push(JSON.parse(options.body)); return Response.json({ captured: true }, { status: 202 });
  };
  const capture = mountUsageCapture({ document: dom.window.document, window: dom.window, fetch, now: () => new Date(timestamp) });
  await capture.ready;
  dom.window.document.querySelector('button').click();
  dom.window.document.dispatchEvent(new dom.window.CustomEvent('doctorcre:usage', { detail: 'chat_sent' }));
  dom.window.document.dispatchEvent(new dom.window.CustomEvent('doctorcre:usage', { detail: { event_name: 'chat_sent', chat: 'Synthetic Lease' } }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(event => event.event_name), ['screen_viewed', 'primary_action_used', 'chat_sent']);
  const alert = dom.window.document.querySelector('[role="alert"]');
  alert.textContent = 'Synthetic Client lease failed'; alert.hidden = false;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.at(-1).event_name, 'error_shown');
  assert.equal(JSON.stringify(calls).includes('Synthetic'), false);
  dom.window.document.getElementById('usageCaptureToggle').click();
  dom.window.document.querySelector('button').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 4);
  assert.equal(dom.window.localStorage.getItem('doctorcre:usage-capture'), 'off');
  capture.dispose(); dom.window.close();
});
