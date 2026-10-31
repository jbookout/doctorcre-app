import test from 'node:test';
import assert from 'node:assert/strict';
import { queueBoard, prLinks, QUEUE_STAGES, QUEUE_REFRESH_MS, QUEUE_IDLE_MS } from '../js/work-queue-board-model.js';

const job = (card_id, stage, extra = {}) => ({ card_id, work_request: 'WR-000557', work_request_title: 'Queue', stage, stale: false, prs: [], ...extra });
const read = (jobs, github = []) => ({ ok: true, stale_after_hours: 24, jobs, github });

test('every stage is present in order, even when empty, and jobs group by Work Request in queue order', () => {
  const board = queueBoard(read([job('WR557.S4.J1', 'review'), job('WR9.S1.J1', 'review', { work_request: 'WR-000009', work_request_title: 'Other' }),
    job('WR557.S4.J2', 'review')]));
  assert.deepEqual(board.stages.map(stage => [stage.id, stage.count]), [['queued', 0], ['running', 0], ['build', 0], ['review', 3], ['merged', 0], ['live', 0], ['closed', 0]]);
  assert.deepEqual(board.stages[3].groups.map(group => [group.work_request, group.title, group.jobs.map(item => item.card_id)]),
    [['WR-000557', 'Queue', ['WR557.S4.J1', 'WR557.S4.J2']], ['WR-000009', 'Other', ['WR9.S1.J1']]]);
  assert.equal(QUEUE_STAGES.length, 7);
});

test('staleness and stage come only from the server read', () => {
  const board = queueBoard(read([job('WR557.S4.J1', 'review', { stale: false, created_at: '2020-01-01T00:00:00Z' }), job('WR557.S4.J2', 'build', { stale: true })]));
  assert.equal(board.stale, 1);
  assert.equal(board.staleAfterHours, 24);
});

test('a malformed read is refused instead of drawing a partial board', () => {
  for (const bad of [null, { ok: true, jobs: [] }, read([job('WR557', 'review')]), read([job('WR557.S4.J1', 'bogus')]),
    read([{ ...job('WR557.S4.J1', 'review'), stale: 'yes' }])])
    assert.throws(() => queueBoard(bad), /incomplete/);
});

test('GitHub gaps and truncated windows become notices', () => {
  const board = queueBoard(read([], [{ repo: 'DoctorCRE/carr-system', state: 'unavailable' }, { repo: 'jbookout/doctorcre-app', state: 'ok', truncated: true },
    { repo: 'jbookout/software-factory', state: 'ok', truncated: false }]));
  assert.deepEqual(board.notices, ['GitHub could not be read for DoctorCRE/carr-system; its PR stages may be behind.',
    'Only the 100 most recently updated jbookout/doctorcre-app PRs were read.']);
});

test('only GitHub pull request URLs become links, labelled with their WR.S.J.repo#pr ID and state', () => {
  const links = prLinks(job('WR557.S4.J1', 'build', { prs: [
    { url: 'https://github.com/jbookout/doctorcre-app/pull/12', card_id: 'WR557.S4.J1.app#12', state: 'open', draft: true },
    { url: 'javascript:alert(1)', card_id: 'WR557.S4.J1.app#13', state: 'open', draft: false }] }));
  assert.deepEqual(links, [{ href: 'https://github.com/jbookout/doctorcre-app/pull/12', label: 'WR557.S4.J1.app#12', state: 'draft' }]);
});

test('the refresh clock is 60 seconds with a 5-minute idle cutoff', () => {
  assert.deepEqual([QUEUE_REFRESH_MS, QUEUE_IDLE_MS], [60_000, 300_000]);
});

test('started and production-verified jobs appear in their own stages', () => {
  const board = queueBoard(read([
    job('WR557.S4.J1', 'running'),
    job('WR557.S4.J2', 'merged', { prs: [{ state: 'merged', production_live: true }] }),
    job('WR557.S4.J3', 'merged', { prs: [{ state: 'merged', production_live: null }] }),
  ]));
  assert.equal(board.stages.find(stage => stage.id === 'running').count, 1);
  assert.equal(board.stages.find(stage => stage.id === 'live').count, 1);
  assert.equal(board.stages.find(stage => stage.id === 'merged').count, 1);
});
