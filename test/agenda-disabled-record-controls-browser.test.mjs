import test from 'node:test';
import assert from 'node:assert/strict';
import { componentDocument, chromium, fixtureServer } from './browser-harness.mjs';
import { exerciseAgenda } from '../scripts/prove-agenda-disabled-record-controls.mjs';

for (const width of [390, 1440]) {
  test('native record activation follows agenda state at ' + width + 'px', async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await componentDocument(page, server.origin, {owner:'agenda disabled controls'});
    const result = await exerciseAgenda(page, server.origin + '/js/ui-agenda.generated.js');
    assert.deepEqual(result.activations, { open: 6, step: 6 });
    assert.ok(result.assertions > 40);
  });
}
