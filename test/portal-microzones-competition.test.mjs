import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile('test/fixtures/portal-microzones-competition.market-study.json'));
const built = await build({ entryPoints: ['src/ui/portal/microzones-competition.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { officeIdentity } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

test('office identity survives filtering and distinguishes offices sharing a name', () => {
  const office = fixture.demographics.competition.offices[0];
  assert.equal(officeIdentity(office), officeIdentity({ ...office, market: 'Changed market' }));
  assert.notEqual(officeIdentity(office), officeIdentity({ ...office, address: 'Other office' }));
});
