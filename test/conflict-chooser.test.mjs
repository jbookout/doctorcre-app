import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { escapeText, fieldLabel, readableValue } from '../js/change-receipts.mjs';
import { classifyCommandOutcome } from '../js/command-feedback.mjs';

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function showConflict('), app.indexOf('function detailRows('));

function chooser(resolveConflict) {
  const radios = [{ disabled:false }, { disabled:false }];
  const button = { textContent:'Keep selected value' };
  let form;
  let keys = 0;
  const state = { client:{ resolveConflict } };
  const show = new Function('esc', 'readableValue', 'actorName', 'fieldLabel', 'openForm',
    'state', 'uuidv4', '$$', '$', 'loadHome', 'showToast', 'classifyCommandOutcome', `${source}; return showConflict;`)(
    escapeText, readableValue, (actor) => ({ joe:'Joe', dell:'Dell' })[actor] || actor,
    fieldLabel, (options) => { form = options; }, state, () => `key-${++keys}`,
    () => radios, () => button, async () => {}, () => {}, classifyCommandOutcome);
  show({ conflict_id:'c1', field:'attention', a:{ actor:'dell', value:true }, b:{ actor:'joe', value:false } });
  return { form:() => form, radios, button, keys:() => keys };
}

test('conflict requires an explicit choice and renders both attributed values', () => {
  const view = chooser(async () => ({ ok:true }));
  const { body, title } = view.form();
  assert.equal(title, 'Choose the Attention flag value');
  assert.match(body, /Current value.*Dell: Flagged/s);
  assert.match(body, /Your proposed value.*Joe: Not flagged/s);
  assert.match(body, /name="winner" value="a" required/);
  assert.match(body, /name="winner" value="b" required/);
  assert.doesNotMatch(body, /checked/);
});

test('an unanswered resolution reuses the exact choice and key', async () => {
  const sent = [];
  const view = chooser(async (request) => {
    sent.push(request);
    if (sent.length === 1) throw new Error('answer lost');
    return { ok:true, replayed:true };
  });
  await assert.rejects(view.form().onSubmit(new Map([['winner', 'b']])), /answer lost/);
  assert.equal(view.button.textContent, 'Check outcome');
  assert.ok(view.radios.every((radio) => radio.disabled));
  await view.form().onSubmit(new Map()); // disabled radios are omitted by FormData
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(sent[0], { conflict_id:'c1', winner:'b', idempotency_key:'key-1' });
  assert.equal(view.keys(), 1);
});

test('offline refusal leaves the choice editable because no request was sent', async () => {
  const sent = [];
  const view = chooser(async (request) => {
    sent.push(request);
    if (sent.length === 1) {
      const error = new Error('Offline');
      error.payload = { error:'offline' };
      throw error;
    }
    return { ok:true };
  });
  await assert.rejects(view.form().onSubmit(new Map([['winner', 'a']])), /Offline/);
  assert.ok(view.radios.every((radio) => !radio.disabled));
  await view.form().onSubmit(new Map([['winner', 'b']]));
  assert.equal(sent[1].winner, 'b');
  assert.notEqual(sent[1].idempotency_key, sent[0].idempotency_key);
});

test('a definitive authorization refusal does not offer outcome reconciliation', async () => {
  const view = chooser(async () => {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  });
  await assert.rejects(view.form().onSubmit(new Map([['winner', 'a']])), /Unauthorized/);
  assert.ok(view.radios.every((radio) => !radio.disabled));
  assert.equal(view.button.textContent, 'Keep selected value');
});
