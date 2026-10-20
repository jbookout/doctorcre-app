import { GOVERNANCE_LANES, validGovernanceQueuePayload, validScheduleBoardPayload, formatScheduleDateTime } from './operations-model.js';

const recordedText = value => typeof value === 'string' && value.trim() ? value : null;

export function jobFacts(task) {
  const ownHolder = task.kind === 'work_request' ? task.held : null;
  return {
    id: task.id, task, title: task.title || task.name || 'Untitled work',
    state: task.status || task.state || 'unknown',
    owner: recordedText(task.owner) || recordedText(ownHolder?.owner) || 'unknown',
    agent: recordedText(ownHolder?.executor) || (!task.kind ? recordedText(task.executor) : null) || 'unknown',
    model: recordedText(task.model) || 'unknown', effort: recordedText(task.effort) || 'unknown',
    blocker: recordedText(task.blocked_reason) || recordedText(task.blocker?.detail) || recordedText(ownHolder?.blocker?.detail) || 'unknown',
    progress: recordedText(task.last_progress) || (!task.kind ? recordedText(task.note) : null) || 'unknown',
    updatedAt: recordedText(task.updated_at),
    linked: task.held && !ownHolder ? {
      owner: recordedText(task.held.owner) || 'unknown',
      agent: recordedText(task.held.executor) || 'unknown',
      blocker: recordedText(task.held.blocker?.detail) || 'unknown',
    } : null,
  };
}

export function resolveJobTasks(tasks) {
  const unique = new Map();
  for (const task of tasks.filter(task => task.id)) {
    const previous = unique.get(task.id);
    const at = Date.parse(task.updated_at || task.last_activity_at);
    const before = Date.parse(previous?.updated_at || previous?.last_activity_at);
    const preferNext = Number.isFinite(at) && Number.isFinite(before) && at !== before
      ? at > before
      : Number((task.status || task.state) === 'failed') >= Number((previous?.status || previous?.state) === 'failed');
    if (!previous) { unique.set(task.id, task); continue; }
    const [current, other] = preferNext ? [task, previous] : [previous, task];
    const facts = jobFacts(current), recorded = jobFacts(other);
    unique.set(task.id, { ...current,
      ...(facts.blocker === 'unknown' && recorded.blocker !== 'unknown' ? { blocked_reason: recorded.blocker } : {}),
      ...(facts.progress === 'unknown' && recorded.progress !== 'unknown' ? { last_progress: recorded.progress } : {}),
    });
  }
  return [...unique.values()];
}

export function attentionTasks(tasks) {
  return resolveJobTasks(tasks).filter(task => ['failed', 'blocked', 'needs_joe'].includes(task.status || task.state)
    || task.health === 'blocked').map(jobFacts).sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed'));
}

export function governanceTasks(payload) {
  if (!validGovernanceQueuePayload(payload)) return null;
  return GOVERNANCE_LANES.flatMap(lane => payload[lane.id].map(row => ({
    ...row, id: `governance:${lane.id}:${row[lane.idField]}`, kind: 'governance_item',
    governance: { lane: lane.id, ref: row[lane.idField], entry: row },
    title: row.statement || row.reason || row.staging_key || 'Retrieval proposal',
    status: 'review', stage: 'review', updated_at: row[lane.sinceField],
    note: row.admission_reason || row.reason || '',
  })));
}

export function withGovernance(board, tasks) {
  if (!tasks) return board;
  // An exact census reference carries bindings; the queue carries the original
  // approval entry and Review placement. Keep both on one card.
  const remaining = new Map(tasks.map(task => [task.governance.ref, task]));
  const reviews = [];
  const stages = board.stages.map(stage => ({ ...stage, tasks: stage.tasks.filter(task => {
    const ref = task.governance?.ref || (task.kind === 'governance_item' ? task.id.replace(/^governance_item:/, '') : null);
    const entry = remaining.get(ref);
    if (!entry) return !tasks.some(row => row.governance.ref === ref);
    reviews.push({ ...task, ...entry, ...Object.fromEntries(['work_request','work_request_ref','human_ref','related','pr','pr_url'].filter(key => entry[key] == null && task[key] != null).map(key => [key, task[key]])) });
    remaining.delete(ref);
    return false;
  }) }));
  const review = stages.find(stage => stage.id === 'review');
  if (review) review.tasks.push(...reviews, ...remaining.values());
  return { ...board, stages };
}

// Both scheduler surfaces carry observation coverage and the same timing words.
export function automationSchedule(payload) {
 if(!validScheduleBoardPayload(payload))return {jobs:null,notice:'Automations unavailable'};
 const unknown=payload.sources.filter(source=>source.state!=='read').map(source=>source.owner);
 const jobs=payload.jobs.map(job=>({...job,source_state:payload.sources.find(source=>source.owner===job.owner)?.state==='read'?'read':'unknown'}));
 const notice=unknown.length?jobs.length?`Automations unavailable for sources: ${unknown.join(', ')}`:'Automations unavailable':payload.overall_state==='unknown'?'Automations unavailable':'';
 return {jobs,notice};
}
export function automationTiming(job,{compact=false}={}) {
 if(!job.next_due_at)return job.schedule?job.state==='paused'?'Next time unknown while paused':'Next time unavailable':'Unscheduled';
 const prefix=job.next_due_basis==='cadence_deadline'?'Expected by':'Next';
 const time=compact?new Date(job.next_due_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}):formatScheduleDateTime(job.next_due_at);
 return `${prefix} ${time}`;
}

export function automationMonth(payload, year, month) {
  const {jobs,notice} = automationSchedule(payload);
  const start = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  return { label: start.toLocaleDateString('en-US', {month:'long', year:'numeric'}), jobs, notice,
    blanks: start.getDay(), days: Array.from({length:days}, (_, i) => {
      const date = new Date(year,month,i+1), key = dateKey(date);
      return { day:i+1, key, jobs: (jobs || []).filter(j => j.next_due_at && dateKey(new Date(j.next_due_at)) === key) };
    }), undated: (jobs || []).filter(j => !j.next_due_at) };
}
