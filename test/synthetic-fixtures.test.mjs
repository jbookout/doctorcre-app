import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFixtures } from '../scripts/privacy/generate-synthetic-fixtures.mjs';

test('regenerating fixtures is deterministic and uses visibly synthetic identities', () => {
  for (const [file, payload] of Object.entries(generateFixtures())) {
    assert.deepEqual(JSON.parse(readFileSync(new URL(`../test/fixtures/${file}`, import.meta.url))), payload);
  }
  const chart = generateFixtures()['charts-synthetic.json'];
  assert.equal(chart.deals.length, 74);
  for (const row of chart.deals) {
    assert.match(row.id, /^example-deal-/);
    assert.match(row.name, /^Example /);
    assert.match(row.client_ref, /^C-9\d{2}$/);
    assert.match(row.client_name, /^Example /);
  }
  const sessions = generateFixtures()['session-identity.json'].captures[0].payload.sessions;
  assert.ok(sessions.every((row) => row.display_name.startsWith('Example ')));
});
