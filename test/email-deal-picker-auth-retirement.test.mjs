import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const initial = new JSDOM('');
globalThis.window = initial.window; globalThis.document = initial.window.document;
const compiled = await build({ entryPoints: ['src/ui/email-followup-actions.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const { mountEmailActions, actionModel } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
initial.window.close();
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
for (const error of [{ status: 401 }, { status: 403 }, { code: 'session_changed' }]) {
  test(`board denial retires before notifying parent ${JSON.stringify(error)}`, async () => {
    const dom = new JSDOM('<main></main>');
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const host = document.querySelector('main');
    let denied = 0;
    const view = mountEmailActions(host, { id: 'p', version: 1, kind: 'file_to_deal', deal: 'd', source: { activity_id: 'a', evidence_quote: 'Synthetic' } }, { getBoard: async () => { throw error; } }, actionModel(), () => assert.fail('changed'), () => { denied++; assert.equal(host.querySelector('form,button,input,select,textarea'), null); });
    host.querySelector('[data-followup=file]').click();
    await settle();
    assert.equal(denied, 1);
    view.update({ id: 'p', version: 2, kind: 'file_to_deal', source: {} }, true);
    assert.equal(host.querySelector('form,button'), null);
    view.dispose(); dom.window.close();
  });
}

for (const error of [{ status: 401 }, { status: 403 }, { code: 'session_changed' }]) {
  test(`canceled board denial retires replacement editor ${JSON.stringify(error)}`, async t => {
    const dom = new JSDOM('<main></main>');
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const host = document.querySelector('main');
    let rejectBoard, denied = 0, creates = 0;
    const view = mountEmailActions(host, { id: 'p', version: 1, kind: 'file_to_deal', deal: 'd', source: { activity_id: 'a', evidence_quote: 'Synthetic' } }, {
      getBoard: () => new Promise((resolve, reject) => { rejectBoard = reject; }),
      createDeal: async () => { creates++; return { deal_id: 'created' }; },
      previewEmailFiling: async () => { throw Error('Synthetic preview unavailable'); },
    }, actionModel(), () => assert.fail('changed'), () => { denied++; });
    t.after(() => { view.dispose(); dom.window.close(); });
    host.querySelector('[data-followup=file]').click();
    host.querySelector('[data-followup=cancel]').click();
    host.querySelector('[data-followup=new]').click();
    const form = host.querySelector('form');
    for (const key of ['name', 'client']) {
      const field = host.querySelector(`[data-field=${key}]`);
      field.value = 'Synthetic'; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    rejectBoard(error); await settle();
    const controls = host.querySelectorAll('form,button,input,select,textarea,a').length;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual({ denied, controls, creates }, { denied: 1, controls: 0, creates: 0 });
  });
}
