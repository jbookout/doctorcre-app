import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { catalogFixture } from './catalog-fixture.mjs';
import { families } from './catalog-families.mjs';
import { inventory, pressControl } from '../../scripts/e2e-staging/controls.mjs';
import { canonicalIdentity } from '../../scripts/e2e-staging/traversal.mjs';
import catalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };
import { screens } from '../../scripts/e2e-staging/screens.mjs';

for (const family of families) test(family.id + ': app handler effect passes; a no-op fails', async () => {
  for (const phone of family.phoneOnly ? [true] : [false, true]) for (const state of [0, 1]) for (const theme of ['dark', 'light']) for (const noop of [false, true]) {
    const f = await catalogFixture({ phone, theme, assist: state === 1, actor: state ? 'dell' : 'joe', callAvailable: !!state });
    try {
      await family.setup?.(f, state);
      const node = f.window.document.querySelector(family.selector);
      const control = (await inventory(f.page)).find(row => f.window.document.querySelector(row.selector) === node);
      assert.ok(control, family.id + ' must be inventoried');
      const proof = catalog.controls.find(row => canonicalIdentity(row.identity) === control.identity);
      assert.ok(proof, family.id + ' must have a checked-in exact identity');
      const observations = proof.observations;
      if (noop) {
        // Capture at the window before any app listener runs, including delegated
        // handlers and native default actions. Replacing onclick alone misses them.
        for (const event of ['click', 'input', 'change', 'keydown', 'submit']) f.window.addEventListener(event, value => {
          if (value.composedPath().includes(node)) { value.stopImmediatePropagation(); value.preventDefault(); }
        }, true);
      }
      const result = await pressControl(f.page, control, { waitMs: 20, observations });
      assert.equal(result.status, noop ? 'DEAD' : 'OBSERVED', JSON.stringify({ family: family.id, phone, state, noop, result }));
      assert.equal(result.proof_observation.passed, !noop);
    } finally { f.close(); }
  }
});

for (const { path } of (await screens()).filter(row => row.path !== '/share')) test('catalog proofs execute the app handlers on ' + path, { timeout: 30_000 }, async () => {
  for (const phone of [false, true]) {
    const f = await catalogFixture({ path, phone });
    try {
      const baseline = await inventory(f.page);
      const root = f.window.document;
      const toggles = ['#appSidebarToggle', '#appTodayToggle', '.app-shell-more-toggle', '#selfAvatar'];
      const expanded = toggles.map(selector => root.querySelector(selector).getAttribute('aria-expanded'));
      const theme = root.documentElement.dataset.theme;
      const assist = root.documentElement.dataset.colorAssist;
      const presence = root.querySelector('#docPresence');
      const presenceParent = presence.parentElement, presenceNext = presence.nextSibling;
      for (const family of families.filter(row => !row.phoneOnly || phone)) {
        await family.setup?.(f, 0);
        const node = root.querySelector(family.selector);
        const control = (await inventory(f.page)).find(row => root.querySelector(row.selector) === node);
        assert.ok(control, family.id + ' on ' + path);
        const proof = catalog.controls.find(row => canonicalIdentity(row.identity) === control.identity);
        assert.ok(proof, family.id + ' exact identity on ' + path + (phone ? ' phone' : ' desktop'));
        const result = await pressControl(f.page, control, { waitMs: 20, observations: proof.observations });
        assert.equal(result.status, 'OBSERVED', JSON.stringify({ path, phone, family: family.id, result }));

        // Share only the mounted route, never a previous control's state. Undo
        // through the app handlers and prove the full inventory is pristine.
        const input = root.querySelector('#docCommandInput');
        if (input.value) { input.value = ''; input.dispatchEvent(new f.window.Event('input', { bubbles: true })); }
        for (const dialog of root.querySelectorAll('dialog[open]')) dialog.close();
        if (root.documentElement.dataset.theme !== theme) root.querySelector('[data-pref="theme"]').click();
        if (root.documentElement.dataset.colorAssist !== assist) root.querySelector('#colorAssistButton').click();
        for (const [index, selector] of toggles.entries()) {
          const toggle = root.querySelector(selector);
          if (toggle.getAttribute('aria-expanded') !== expanded[index]) toggle.click();
        }
        await new Promise(resolve => f.window.queueMicrotask(resolve));
        presenceParent.insertBefore(presence, presenceNext);
        assert.deepEqual(await inventory(f.page), baseline, family.id + ' must restore ' + path + (phone ? ' phone' : ' desktop'));
      }
    } finally { f.close(); }
  }
});

// A family's `file:line` citation is what a reviewer reads; it must still be the
// line that renders the control, and every compiled proof must carry it.
test('each family cites the line that renders its control, as do its proofs', async () => {
  for (const family of families) {
    const [file, line] = family.source.split(':');
    const text = (await readFile(new URL('../../' + file, import.meta.url), 'utf8')).split('\n')[Number(line) - 1] || '';
    const markers = [family.name,
      ...[...family.selector.matchAll(/#([\w-]+)/g)].map(m => `id="${m[1]}"`),
      ...[...family.selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)].map(m => `${m[1]}="${m[2]}"`),
      ...[...family.selector.matchAll(/\.([\w-]+)/g)].map(m => m[1])];
    assert.ok(markers.some(marker => text.includes(marker)), `${family.id}: ${family.source} does not render ${family.selector}`);
    const cited = new Set(catalog.controls.filter(row => row.review.policy === family.id + '.v1').map(row => row.review.source));
    assert.deepEqual([...cited], [family.source], `${family.id}: proofs cite ${family.source}`);
  }
});
