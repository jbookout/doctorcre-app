import test from 'node:test';
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
  for (const family of families) for (const phone of family.phoneOnly ? [true] : [false, true]) {
    const f = await catalogFixture({ path, phone });
    try {
      await family.setup?.(f, 0);
      const node = f.window.document.querySelector(family.selector);
      const control = (await inventory(f.page)).find(row => f.window.document.querySelector(row.selector) === node);
      assert.ok(control, family.id + ' on ' + path);
      const proof = catalog.controls.find(row => canonicalIdentity(row.identity) === control.identity);
      assert.ok(proof, family.id + ' exact identity on ' + path + (phone ? ' phone' : ' desktop'));
      const result = await pressControl(f.page, control, { waitMs: 20, observations: proof.observations });
      assert.equal(result.status, 'OBSERVED', JSON.stringify({ path, phone, family: family.id, result }));
    } finally { f.close(); }
  }
});
