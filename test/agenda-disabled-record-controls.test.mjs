import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const compiled = await build({ entryPoints: ['src/ui/deal-room-agenda.tsx'], bundle: true, format: 'esm', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
const { mountDealRoomAgenda } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('record controls follow hidden, pending, access restoration and teardown', () => {
  const dom = new JSDOM('<button></button><aside></aside><div></div>');
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const [button, panel, dock] = document.body.children;
  const view = mountDealRoomAgenda({ button, panel, dock }, () => {});
  const props = { buttonHidden: true, disabled: false, review: null, confirms: [], confirmError: null };
  const review = { title: 'Synthetic review', index: 1, total: 3, deal: { id: 'synthetic', name: 'Synthetic deal', context: 'Context', reason: 'Reason', phase: 'Review', nextStep: 'Call', nextDate: 'Not set', marketAgent: null } };
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
