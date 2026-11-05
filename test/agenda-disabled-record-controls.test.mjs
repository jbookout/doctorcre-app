import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = await build({ entryPoints: ['src/ui/deal-room-agenda.tsx'], bundle: true, format: 'esm', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
const { mountDealRoomAgenda } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const review = { title: 'Synthetic review', index: 1, total: 3, deal: { id: 'synthetic', name: 'Synthetic deal', context: 'Context', reason: 'Reason', phase: 'Review', nextStep: 'Call', nextDate: 'Not set', marketAgent: null } };

test('record controls follow hidden, pending, access restoration and teardown', () => {
  const dom = new JSDOM('<button></button><aside></aside><div></div>');
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const [button, panel, dock] = document.body.children;
  const view = mountDealRoomAgenda({ button, panel, dock }, () => {});
  const props = { buttonHidden: true, disabled: false, review: null, confirms: [], confirmError: null };
  let count = 0;
  panel.addEventListener('click', e => { if (e.target.closest('[data-open-deal],[data-agenda-step]')) count++; });
  try {
    view.render(props);
    assert.equal(panel.hidden, true);
    view.render({ ...props, buttonHidden: false, review, confirms: [{ id: 'synthetic', label: 'Suggestion' }] });
    const controls = [...panel.querySelectorAll('[data-open-deal],[data-agenda-step]')];
    assert.equal(controls.length, 2);
    controls[0].focus();
    for (const cause of ['pending', 'access']) {
      view.render({ ...props, review, disabled: true, confirms: [{ id: 'synthetic', label: 'Suggestion' }] });
      for (const control of controls) { assert.equal(control.disabled, true, cause); control.click(); }
      assert.equal(count, 0);
      assert.equal(panel.hidden, false);
      assert.equal(panel.querySelector('#agendaProgress').textContent, '2 of 3');
      assert.equal(dock.querySelector('[data-confirm]').disabled, true);
      view.render({ ...props, review, disabled: false, confirms: [{ id: 'synthetic', label: 'Suggestion' }] });
      assert.equal(document.activeElement, controls[0]);
    }
    for (const control of controls) control.click();
    assert.equal(count, 2);
    view.render(props);
    assert.equal(panel.hidden, true);
    view.dispose();
    assert.equal(panel.children.length, 0);
    assert.equal(dock.children.length, 0);
  } finally {
    Object.assign(globalThis, previous); dom.window.close();
  }
});

for (const state of ['review_enabled', 'review_disabled_pending', 'review_disabled_access', 'review_reenabled']) {
  test(`dispose removes the visible review and start listener from ${state}`, () => {
    const dom = new JSDOM('<button></button><aside></aside><div></div>');
    const previous = { window: globalThis.window, document: globalThis.document };
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const [button, panel, dock] = document.body.children;
    const actions = [];
    const view = mountDealRoomAgenda({ button, panel, dock }, action => actions.push(action));
    const props = { buttonHidden: false, disabled: false, review,
      confirms: [{ id: 'synthetic', label: 'Suggestion' }], confirmError: null };
    try {
      view.render(props);
      button.click();
      assert.deepEqual(actions, ['start']);
      if (state !== 'review_enabled') view.render({ ...props, disabled: true });
      if (state === 'review_reenabled') view.render(props);
      assert.equal(button.disabled, state === 'review_disabled_pending' || state === 'review_disabled_access');
      assert.equal(panel.hidden, false);
      assert.equal(panel.querySelector('.agenda-deal h3').textContent, 'Synthetic deal');
      assert.equal(button.textContent, 'Review deals');
      assert.equal(dock.querySelectorAll('[data-confirm]').length, 2);
      view.dispose();
      for (const target of [panel, dock, button]) assert.equal(target.childNodes.length, 0, state);
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepEqual(actions, ['start'], 'disposed start listener must not dispatch, even when the button was disabled');
    } finally {
      Object.assign(globalThis, previous); dom.window.close();
    }
  });
}
