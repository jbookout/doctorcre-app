import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execute = promisify(execFile);
export const fixtureProducerCommit = '32e9e1f9033ef79ceefec85439c39735c2fa0f0f';
export const stagingOrigin = 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev';

export async function requireStagingAuthority(request) {
  const response = await request.post('/mcp', {
    headers: { origin: stagingOrigin, 'sec-fetch-site': 'same-origin' },
    data: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
      params: { name: 'issue-tour-share-grant', arguments: {
        idempotency_key: randomUUID(), projection_id: randomUUID(),
        token_digest: 'sha256:' + 'a'.repeat(64), permission_scopes: ['invalid-preflight-scope'],
        expires_at: new Date(Date.now() + 60000).toISOString(), receipt_digest: 'sha256:' + 'b'.repeat(64),
      } } },
  });
  if (response.status() !== 200) throw new Error('staging authority preflight failed to authenticate');
  const body = await response.json();
  const value = JSON.parse(body.result?.content?.find(item => item.type === 'text')?.text || '{}');
  if (value.error === 'authority_connection_unavailable') {
    throw new Error('staging authority unavailable: CARR_DB_AUTHORITY_JOE_URL must be provisioned on carr-mcp-staging');
  }
  if (value.error !== 'tour_share_scope_invalid') {
    throw new Error(`staging authority preflight returned an unexpected refusal: ${value.error || body.error?.code || 'missing result'}`);
  }
}

async function produce(action, run) {
  const repo = process.env.CARR_JOURNEY_FIXTURE_REPO;
  if (!repo) throw new Error('CARR_JOURNEY_FIXTURE_REPO must name the pinned CARR checkout containing tools/staging-journey-fixtures.py');
  const source = await execute('git', ['-C', repo, 'rev-parse', 'HEAD']);
  const changed = await execute('git', ['-C', repo, 'status', '--porcelain', '--',
    'tools/staging-journey-fixtures.py', 'tools/staging-fixtures.py']);
  if (source.stdout.trim() !== fixtureProducerCommit || changed.stdout.trim()) {
    throw new Error(`CARR fixture producer requires clean commit ${fixtureProducerCommit}`);
  }
  const { stdout } = await execute(join(repo, '.venv/bin/python'),
    [join(repo, 'tools/staging-journey-fixtures.py'), action, '--run', run],
    { timeout: 180000, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(stdout);
  if (value.schema !== 'doctorcre-staging-journey-fixture.v1' || value.run !== run) {
    throw new Error('CARR fixture producer returned a mismatched run or contract');
  }
  return value;
}

async function cleanupJourney(producer, run) {
  let action = 'cleanup';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const state = await producer(action, run);
      if (state.remaining === 0) return;
      action = 'cleanup';
    } catch {
      action = 'remaining';
    }
  }
  throw new Error(`leftover fixture or unverified cleanup for synthetic run ${run}`);
}

export async function withJourneyFixture(body, producer = produce) {
  const run = randomUUID();
  let result, failure;
  try {
    const fixture = await producer('prepare', run);
    result = await body(fixture);
  } catch (error) {
    failure = error;
    failure.fixtureRun = run;
  }
  try {
    await cleanupJourney(producer, run);
  } catch (error) {
    if (!failure) failure = error;
    else {
      failure.message += `\n${error.message}`;
      failure.cleanupError = error;
    }
    failure.fixtureRun = run;
  }
  if (failure) throw failure;
  return result;
}
