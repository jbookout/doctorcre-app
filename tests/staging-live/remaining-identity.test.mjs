import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStagingRecords } from '../../scripts/e2e-staging/records.mjs';
import { fakeAPI, reply } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';

beforeEach(admitFixtureRun);
test('fixed party setup refuses a different selected client or vendor role before admitting fixtures', async t => {
  for (const variant of ['client', 'vendor']) {
    const output = await mkdtemp(join(tmpdir(), 'remaining-identity-'));
    const run = openRun(output, { runId: `remaining-identity-${variant}`, events: null });
    t.after(() => run.dispose());
    t.after(() => rm(output, { recursive: true, force: true }));
    const fake = fakeAPI(output), factory = fake.requestFactory;
    fake.requestFactory = async options => {
      const api = await factory(options), get = api.get.bind(api);
      api.get = async (path, options) => {
        const response = await get(path, options);
        if (!path.includes('/relationships?')) return response;
        const value = await response.json();
        if (variant === 'client') value.nodes[0].record_id = '99999999-0000-4000-8000-000000000001';
        else value.nodes[0].kind = 'vendor';
        return reply(value);
      };
      return api;
    };
    await assert.rejects(prepareStagingRecords(output, { ...fake, run }), /stopped at readback/);
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(plan.state, 'pending');
    await assert.rejects(prepareStagingRecords(output, { ...fake, run }), /partial plan requires reconciliation/);
  }
});

test('missing relationship seed proof refuses reuse with a precise prerequisite and no new fixture writes', async t => {
  const output = await mkdtemp(join(tmpdir(), 'remaining-referral-prerequisite-'));
  const run = openRun(output, { runId: 'remaining-referral-prerequisite', events: null });
  t.after(() => { run.dispose(); return rm(output, { recursive: true, force: true }); });
  const fake = fakeAPI(output);
  await prepareStagingRecords(output, { ...fake, run });
  fake.calls.length = 0;
  await assert.rejects(prepareStagingRecords(output, { ...fake, run, reuseOnly: true, relationshipFixture: true }),
    { code: 'staging-fixture-relationship-prerequisite' });
  assert.deepEqual(fake.calls.filter(row => row.path === '/mcp').map(row => row.options.data.params.name), ['get-deal-room']);
});
