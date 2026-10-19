import test from 'node:test';
import assert from 'node:assert/strict';
import * as workspace from '../js/control-room-workspace-model.js';
import { assignmentBoard, effectiveModelText } from '../js/model-room-model.js';
import { readFile } from 'node:fs/promises';

test('a failed and blocked job appears once with its recorded blocker and last progress', () => {
  const job = { id: 'demo-export', title: 'Demo export', status: 'failed', health: 'blocked',
    executor: 'cx-app', owner: 'joe', blocked_reason: 'Demo source did not answer',
    note: 'Demo records validated before export', updated_at: '2026-10-18T12:00:00Z' };
  const result = workspace.attentionTasks([job, { ...job, note: 'Demo retry reached the source' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].blocker, 'Demo source did not answer');
  assert.equal(result[0].progress, 'Demo retry reached the source');
  assert.equal(result[0].agent, 'cx-app');
  assert.equal(result[0].owner, 'joe');
  assert.equal(result[0].task.id, 'demo-export');
});

test('model and effort remain unknown unless each is explicitly recorded', async () => {
  const capture = JSON.parse(await readFile(new URL('fixtures/model-room-live-capture.json', import.meta.url)));
  const event = capture.read_room_queue_default.events[0];
  const card = effective_model => assignmentBoard({ events: [{ ...event, card: { ...event.card, effective_model } }] }).cards[0];
  assert.equal(card('gpt-6-high').effort, 'unknown', 'a model suffix is not evidence of effort');
  assert.equal(card({ host: 'desktop', tier: 'high' }).effectiveModel, 'unknown');
  assert.equal(card({ id: 'demo-model', effort: 'high' }).effort, 'high');
  assert.equal(card({ effort: 'high' }).effectiveModel, 'unknown');
  assert.equal(card({}).effort, 'unknown');
  assert.equal(effectiveModelText('   '), 'unknown');
  assert.equal(effectiveModelText({ id: '   ' }), 'unknown');
  assert.equal(card({ id: 'demo-model', effort: '   ' }).effort, 'unknown');
});

test('a census owner and manufactured age note do not establish agent work or progress', () => {
  const row = { id: 'work_request:WR-1', kind: 'work_request', status: 'blocked', owner: 'joe', executor: 'joe', note: 'work request · 4 days old' };
  assert.equal(workspace.jobFacts(row).agent, 'unknown');
  assert.equal(workspace.jobFacts(row).progress, 'unknown');
  const facts = workspace.jobFacts({ ...row, held: { owner: 'joe', executor: 'cx-app', blocker: { detail: 'Demo dependency' } } });
  assert.equal(facts.agent, 'cx-app');
  assert.equal(facts.blocker, 'Demo dependency');
  assert.equal(facts.model, 'unknown');
  assert.equal(facts.effort, 'unknown');
});

test('attention puts failures first, retains same-title distinct work, and excludes progressing work', () => {
  const rows = workspace.attentionTasks([
    { id: 'blocked', status: 'blocked', title: 'Demo export' },
    { id: 'moving', status: 'running' },
    { id: 'failed', status: 'failed', title: 'Demo export' },
  ]);
  assert.deepEqual(rows.map(row => row.id), ['failed', 'blocked']);
});
