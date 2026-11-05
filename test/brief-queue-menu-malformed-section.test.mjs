import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const { createBriefQueueView } = await import('data:text/javascript;base64,' + bundle.toString('base64'));

test('malformed section coverage preserves menu, replacement counts and disposal', () => {
  const dom = new JSDOM('<nav></nav><main></main>');
  const menu = dom.window.document.querySelector('nav');
  const view = createBriefQueueView(menu, dom.window.document.querySelector('main'));
  try {
    for (const sections of [null, undefined, {}, { today: null }, ...[null, {}, 'bad', 2].map(items => ({ today: { items, total: 1 } })),
      ...[undefined, null, '0', -1, 0.5, NaN, Infinity, 9007199254740992].map(total => ({ today: { items: [], total } })),
      { today: { items: [{}], total: 0 } }]) {
      view.renderMenu({ sponsor: 'joe', sections });
      assert.equal(menu.querySelectorAll('button').length, 4);
      assert.match(menu.querySelector('[data-brief-queue=today]').textContent, /coverage unknown/);
      assert.doesNotMatch(menu.textContent, /No eligible work|0 of 0/);
      view.renderMenu({ sponsor: 'joe', sections }, 'loops');
      assert.equal(menu.querySelector('select').value, 'loops');
      view.renderMenu({ sponsor: 'joe', sections });
      view.renderMenu({ sponsor: 'joe', sections: { today: { items: [{}], total: 3 } } });
      assert.match(menu.querySelector('[data-brief-queue=today]').textContent, /1 of 3/);
    }
    for (const [state, suffix] of [['empty', ''], ['partial', ' · Some sources are unavailable'], ['unavailable', ' · Unavailable']]) {
      view.renderMenu({ sponsor: 'joe', sections: { today: { state, items: [], total: 0 } } });
      assert.equal(menu.querySelector('[data-brief-queue=today]').textContent, `Today queue · 0 of 0${suffix}`);
    }
    view.renderMenu({ sponsor: 'dell', sections: null });
    assert.equal(menu.querySelectorAll('button').length, 3);
    assert.equal(menu.querySelector('[data-brief-queue=needs_joe]'), null);
    view.dispose();
    assert.equal(menu.childElementCount, 0);
  } finally { view.dispose(); dom.window.close(); }
});
