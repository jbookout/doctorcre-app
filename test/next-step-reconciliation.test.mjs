import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyCommandOutcome, commandMessage } from '../js/command-feedback.mjs';

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function nextStepForm('), app.indexOf('function parkDealForm('));

function harness(setNextStep) {
  const fields = { '#stepText':{ value:'', disabled:false }, '#stepDate':{ value:'', disabled:false },
    '#dialogSubmit':{ textContent:'' } };
  const forms = [];
  const refreshes = [];
  const state = { deals:new Map([['d1', { name:'Acme', next_step:'Old', next_date:null }]]),
    nextStepRequests:new Map(), nextStepInFlight:new Set(), client:{ setNextStep },
    boardSync:{ requestRefresh:(reason) => refreshes.push(reason) } };
  let keys = 0;
  const openForm = (form) => forms.push(form);
  const nextStepForm = new Function('state', 'openForm', 'esc', '$', 'uuidv4',
    'classifyCommandOutcome', 'commandMessage', 'confirmLocalWrite', 'showToast', 'renderBoardOnly',
    `${source}; return nextStepForm;`)(state, openForm, String, (selector) => fields[selector],
    () => `key-${++keys}`, classifyCommandOutcome, commandMessage,
    (_, patch) => Object.assign(state.deals.get('d1'), patch), () => {}, () => {});
  return { state, fields, forms, refreshes, nextStepForm, keys:() => keys };
}

test('lost answer retains the full next-step request across dialog reopen', async () => {
  const sent = [];
  const view = harness(async (request) => {
    sent.push(request);
    if (sent.length === 1) throw new Error('answer lost');
    return { ok:true, replayed:true };
  });
  view.nextStepForm('d1');
  await assert.rejects(view.forms[0].onSubmit(new Map([['text', 'Call Friday'], ['next_date', '2026-09-25']])), /could not be confirmed/);
  assert.equal(view.fields['#dialogSubmit'].textContent, 'Check outcome');
  assert.equal(view.fields['#stepText'].disabled, true);
  view.nextStepForm('d1');
  assert.equal(view.forms[1].submit, 'Check outcome');
  assert.match(view.forms[1].body, /Call Friday/);
  await view.forms[1].onSubmit(new Map());
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(view.keys(), 1);
  assert.equal(view.state.nextStepRequests.size, 0);
  assert.equal(view.state.deals.get('d1').next_step, 'Old'); // A later board value must not be painted over by replay.
  assert.deepEqual(view.refreshes, ['after-write']);
});

test('second submit during an open next-step request sends nothing', async () => {
  let release;
  const sent = [];
  const view = harness((request) => { sent.push(request); return new Promise((resolve) => { release = resolve; }); });
  view.nextStepForm('d1');
  const first = view.forms[0].onSubmit(new Map([['text', 'Call Friday']]));
  await assert.rejects(view.forms[0].onSubmit(new Map([['text', 'Call Saturday']])), /still being sent/);
  assert.equal(sent.length, 1);
  release({ ok:true });
  await first;
  assert.equal(view.state.nextStepRequests.size, 0);
});

test('offline no-send allows a revised next step with a new key', async () => {
  const sent = [];
  const view = harness(async (request) => {
    sent.push(request);
    if (sent.length === 1) {
      const error = new Error('Offline');
      error.payload = { error:'offline' };
      throw error;
    }
    return { ok:true };
  });
  view.nextStepForm('d1');
  await assert.rejects(view.forms[0].onSubmit(new Map([['text', 'Call Friday']])), /Offline/);
  assert.equal(view.state.nextStepRequests.size, 0);
  assert.equal(view.fields['#stepText'].disabled, false);
  await view.forms[0].onSubmit(new Map([['text', 'Call Saturday']]));
  assert.equal(sent[1].text, 'Call Saturday');
  assert.notEqual(sent[1].idempotency_key, sent[0].idempotency_key);
});
