import { GOVERNANCE_LANES, validGovernanceQueuePayload, validScheduleBoardPayload } from './operations-model.js';

export function jobLinks(task) {
  const candidates = [task.work_request, task.work_request_ref, task.human_ref,
    task.kind === 'work_request' ? task.id?.replace(/^work_request:/, '') : null, ...(Array.isArray(task.related) ? task.related : []).filter(r => r?.kind === 'work_request').map(r => r.id)];
  const workRequest = candidates.find(ref => typeof ref === 'string' && /^WR-\d{1,12}$/.test(ref)) || null;
  const raw = task.pr_url || task.pr;
  let prUrl = null, prLabel = null;
  if (typeof raw === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(raw)) {
    prUrl = raw; prLabel = `PR #${raw.split('/').at(-1)}`;
  } else if (Number.isSafeInteger(Number(raw)) && Number(raw) > 0) prLabel = `PR #${Number(raw)}`;
  return { workRequest, prUrl, prLabel };
}

export function governanceTasks(payload) {
  if (!validGovernanceQueuePayload(payload)) return [];
  return GOVERNANCE_LANES.flatMap(lane => payload[lane.id].map(row => ({
    ...row, id: `governance:${lane.id}:${row[lane.idField]}`, kind: 'governance_item',
    governance: { lane: lane.id, ref: row[lane.idField], entry: row },
    title: row.statement || row.reason || row.staging_key || 'Retrieval proposal',
    status: 'review', stage: 'review', updated_at: row[lane.sinceField],
    note: row.admission_reason || row.reason || '',
  })));
}

export function withGovernance(board, tasks) {
  // Join by exact governance reference only. Similar titles never establish identity.
  const existing = new Set(board.stages.flatMap(s => s.tasks).flatMap(t => [t.id, t.governance?.ref, t.kind === 'governance_item' ? t.id.replace(/^governance_item:/, '') : null]));
  return { ...board, stages: board.stages.map(stage => ({ ...stage, tasks: [...stage.tasks,
    ...(stage.id === 'review' ? tasks.filter(t => !existing.has(t.id) && !existing.has(t.governance.ref)) : [])] })) };
}

export function automationMonth(payload, year, month) {
  const jobs = validScheduleBoardPayload(payload) ? payload.jobs : null;
  const start = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  return { label: start.toLocaleDateString('en-US', {month:'long', year:'numeric'}), jobs,
    blanks: start.getDay(), days: Array.from({length:days}, (_, i) => {
      const date = new Date(year,month,i+1), key = dateKey(date);
      return { day:i+1, key, jobs: (jobs || []).filter(j => j.next_due_at && dateKey(new Date(j.next_due_at)) === key) };
    }), undated: (jobs || []).filter(j => !j.next_due_at) };
}
