import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { createRetainedCommands } from '../js/retained-commands.mjs';

test('closing and reopening a national form preserves its unknown request and locks its original material', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<dialog id="formDialog"><p id="dialogContext"></p><h2 id="dialogTitle"></h2><form id="dialogForm"><div id="dialogBody"></div><p id="formError"></p><button id="dialogSubmit"></button></form></dialog>');
  const doc = dom.window.document;
  const dialog = doc.querySelector('dialog'); dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  const calls = []; let lost = true;
  const state = { selfActor: 'joe', client: { createNationalAccount: async args => { calls.push(structuredClone(args)); if (lost) { lost = false; throw new Error('reply lost after commit'); } return { ok: true }; } } };
  const context = vm.createContext({ document: doc, state, createRetainedCommands, uuidv4: randomUUID, FormData: dom.window.FormData,
    $: (selector, root = doc) => root.querySelector(selector), $$: (selector, root = doc) => [...root.querySelectorAll(selector)],
    esc: String, actorName: String, setTimeout: () => 0, loadHome: async () => {}, showToast: () => {} });
  const start = source.includes('function appWrite(') ? source.indexOf('function appWrite(') : source.indexOf('function openForm(');
  vm.runInContext(source.slice(start, source.indexOf('function nextStepForm(')) +
    source.slice(source.indexOf('function addAccountForm('), source.indexOf('function showConflict(')) + '\nglobalThis.open = addAccountForm;', context);
  context.open(); doc.querySelector('#accountName').value = 'Synthetic reviewed account';
  await doc.querySelector('#dialogForm').onsubmit({ preventDefault() {}, currentTarget: doc.querySelector('#dialogForm') });
  assert.equal(calls.length, 1);
  dialog.close(); context.open();
  assert.equal(doc.querySelector('#accountName').value, 'Synthetic reviewed account');
  assert.equal(doc.querySelector('#accountName').disabled, true);
  assert.match(doc.querySelector('#dialogSubmit').textContent, /Check outcome/i);
  await doc.querySelector('#dialogForm').onsubmit({ preventDefault() {}, currentTarget: doc.querySelector('#dialogForm') });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(dialog.open, false);
  dom.window.close();
});
