export const commit = 'a'.repeat(40);
const pair = (name) => ({ file: `tests/agent/${name}.e2e.ts`, title: name, target: 'chromium', disposition: 'run', kind: 'test' });
export const plan = [pair('one'), pair('two')];
export function result(name, status = 'passed', selected = true) {
  return { id: name, testId: `${pair(name).file}::${name}`, kind: 'test', declarationIndex: name === 'one' ? 0 : 1,
    titlePath: [name], file: pair(name).file, source: { file: pair(name).file, line: 1, column: 1 }, targetId: 'chromium', platform: 'web', agent: 'default', repeat: 0,
    status, selected, attempts: selected ? [{ id: `${name}-attempt`, index: 0, status, startedAt: '2026-10-05T00:00:00.000Z', durationMs: 1,
      steps: [{ id: `${name}-step`, index: 0, kind: 'agent', api: 'agent.act', label: 'fixture action', status, source: {file: pair(name).file, line: 1, column: 1}, startedAt: '2026-10-05T00:00:00.000Z', durationMs: 1, events: [], artifacts: [] }],
      artifacts: [{ id: `${name}-video`, kind: 'video', mediaType: 'video/webm', path: `${name}/video.webm`, redaction: 'not-required', producer: { kind: 'attempt' } }], secondaryErrors: [], cleanup: { status: 'passed' } }] : [] };
}
export function report(shard, status = 'passed', rerun = false) {
  const name = shard === 1 ? 'one' : 'two';
  const results = plan.map(p => result(p.title, p.title === name ? status : 'skipped', p.title === name));
  return { schemaVersion: 'report-1', run: { id: `01900000-0000-7000-8000-00000000000${shard}`, specVersion: '0.1', runner: { name: 'e2e', version: '0.17.0' },
    project: { id: 'doctorcre-app', configDigest: 'b'.repeat(64) }, vcs: { commit, dirty: false }, environment: { ci: true }, targets: [{ id: 'chromium' }],
    status: status === 'passed' ? 'passed' : 'failed', exitCode: status === 'passed' ? 0 : 1,
    startedAt: '2026-10-05T00:00:00.000Z', finishedAt: `2026-10-05T00:00:0${rerun ? 2 : 1}.000Z`, results, serialGroups: [], errors: [], limits: {}, usage: { modelTokens: 2 },
    summary: { discovered: 2, selected: 1, executed: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, interrupted: 0, flaky: 0, skipped: status === 'skipped' ? 1 : 0 } } };
}
export const bundle = (shard) => ({ receipt: { schema: 'doctorcre-e2e-shard.v1', shard, total: 2, commit, startedAt: '2026-10-05T00:00:00.000Z', plan, selected: [plan[shard - 1]], firstExit: 0, finalExit: 0 }, first: report(shard), final: report(shard) });

