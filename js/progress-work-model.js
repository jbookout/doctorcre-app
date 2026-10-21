import { jobLinks } from './progress-board-model.js';
import { escapeText as escape } from './change-receipts.mjs';
import { validCanonicalEngineeringPassport, passportProjectionDigest } from './job-passport.js';
// Exact reference joins; titles and shared seats never establish task identity.
export const PROGRESS_WORK_PATH = '/control-room/progress/work';
export function workDetailUrl({ board = 'carr-v5', task, workRequest, session, view } = {}) {
  const query = new URLSearchParams({ board });
  for (const [key, value] of [['task', task], ['work_request', workRequest], ['session', session], ['view', view]]) if (value) query.set(key, value);
  return `${PROGRESS_WORK_PATH}?${query}`;
}
export function workScope(search = '') {
  const query = new URLSearchParams(search);
  return { board: query.get('board') || 'carr-v5', task: query.get('task') || query.get('task_id'),
    workRequest: query.get('work_request') || query.get('work-request'), session: query.get('session') || query.get('session_id'), view: query.get('view') || 'wire' };
}
export function workTaskId(task) {
  if (task.governance?.ref) return `governance_item:${task.governance.ref}`;
  if (task.kind && task.id?.startsWith(`${task.kind}:`)) return task.id;
  return task.task_id || jobLinks(task).prLabel ? task.id || null : null;
}
const lineageFields = [
  ['Work Request', 'work_request', []],
  ['Plan', 'plan', ['plan_ref', 'plan_id']],
  ['Slice', 'slice', ['slice_ref', 'slice_id']],
  ['Task', 'task', ['task_ref', 'task_id']],
  ['Job', 'job', ['job_ref', 'job_id']],
];
export function workLineage(task, board = 'carr-v5', taskId = workTaskId(task)) {
  const workRequest = jobLinks(task).workRequest;
  return lineageFields.map(([label, kind, fields]) => {
    const related = (Array.isArray(task.related) ? task.related : []).filter(row => row?.kind === kind).map(row => row.id);
    const refs = [...new Set((kind === 'work_request' ? [workRequest] : [fields.map(field => task[field]).find(ref => typeof ref === 'string' && ref.trim()), ...related])
      .filter(ref => typeof ref === 'string' && ref.trim() && !/[\u0000-\u001f]/.test(ref)))];
    if (kind === 'task' && !refs.length && taskId) refs.push(taskId);
    const entries = refs.map(ref => {
      const target = `work-lineage-${kind}-${ref}`;
      const destination = kind === 'work_request' ? workDetailUrl({board, workRequest: ref})
        : kind === 'task' && ref === taskId ? workDetailUrl({board, task: taskId, workRequest}) : null;
      return {ref, target, href: destination ? `${destination}#${encodeURIComponent(target)}` : null};
    });
    return {label, kind, entries};
  });
}
export function workLineageHtml(task, board, {linked = true, targets = false, taskId = workTaskId(task)} = {}) {
  const missingState=workDependencies(task,board,{linked}).state==='unlinked'?'Unlinked':'Unavailable';
  return `<section class="work-lineage" aria-label="Linked work"><h3>Linked work</h3><dl>${workLineage(task, board, taskId).map(row =>
    `<div><dt>${row.label}</dt><dd>${row.entries.length ? row.entries.map(({ref, href, target}) => {
      const tag = linked && href ? 'a' : 'span';
      return `<${tag}${targets ? ` id="${escape(target)}"${tag === 'a' ? '' : ' tabindex="-1"'}` : ''}${tag === 'a' ? ` data-job-control="lineage-${row.kind}-${escape(ref)}" href="${escape(href)}"` : ''}>${escape(ref)}</${tag}>`;
    }).join(' · ') : `<span data-missing>${missingState}</span>`}</dd></div>`).join('')}</dl></section>`;
}
const progressScope = scope => scope && typeof scope.plan_ref === 'string' && scope.plan_ref.trim()
  && Number.isSafeInteger(scope.revision) && scope.revision > 0 && /^sha256:[a-f0-9]{64}$/.test(scope.digest);
const progressHistory = history => Array.isArray(history) && history.every(scope => progressScope(scope) && Number.isSafeInteger(scope.total_checks) && scope.total_checks > 0);
export function workProgress(read, workRequest) {
  const unavailable = reason => ({state:'unavailable',label:'Progress unavailable',reason,
    scope:read?.work_request === workRequest && progressScope(read?.scope) ? read.scope : null,checks:[],history:[]});
  if (!workRequest) return unavailable('No canonical Work Request is linked.');
  if (read === undefined) return {state:'loading',label:'Reading acceptance checks…',checks:[],history:[]};
  if (read?.schema !== 'engineering-progress.v1' || read.work_request !== workRequest)
    return unavailable('Acceptance scope could not be verified.');
  if (read.state === 'unavailable') return {...unavailable(({current_accepted_plan_unavailable:'No accepted scope is available.',current_scope_binding_invalid:'The current scope could not be verified.',current_registered_plan_unavailable:'Acceptance checks are unavailable for this scope.',registered_plan_stale:'Acceptance checks belong to an earlier scope.'})[read.reason] || 'The acceptance scope is unavailable.'),history:progressHistory(read.history) ? read.history : []};
  const checks = read.checks;
  if (read.state !== 'available' || !progressScope(read.scope) || !Number.isSafeInteger(read.total) || read.total < 1
    || !Number.isSafeInteger(read.completed) || !Array.isArray(checks) || checks.length !== read.total
    || checks.some(check => !check || typeof check.slice_ref !== 'string' || !check.slice_ref.trim()
      || typeof check.check_ref !== 'string' || !check.check_ref.trim() || typeof check.objective !== 'string' || !check.objective.trim() || !['verified','remaining'].includes(check.state))
    || new Set(checks.map(check => JSON.stringify([check.slice_ref,check.check_ref]))).size !== checks.length
    || checks.filter(check => check.state === 'verified').length !== read.completed)
    return unavailable('The acceptance check count is unavailable.');
  if (!progressHistory(read.history))
    return unavailable('Scope history could not be verified.');
  return {...read,label:`${read.completed} of ${read.total} acceptance checks verified`,remaining:read.total-read.completed};
}
const readableCheck = ref => {
  const words = ref.replace(/^check:/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_:./]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const checkKey = check => JSON.stringify([check.slice_ref,check.check_ref]);
function checkReceiptHtml(check, passport, planned, workRequest) {
  const receipt = passport?.current_receipts.find(row => row.slice_ref === check.slice_ref);
  const result = receipt?.checks.find(row => row.check_ref === check.check_ref);
  const review = receipt && passport.current_reviewer_facts.find(row => row.slice_ref === receipt.slice_ref && row.attempt_id === receipt.attempt_id);
  const claimTime = result ? Date.parse(receipt.executor_claim.claimed_at) : NaN;
  const field = (label,value) => `<div><dt>${label}</dt><dd>${escape(value || 'Not recorded')}</dd></div>`;
  return `<h4>${escape(readableCheck(check.check_ref))}</h4>
    ${planned ? `<p>Fails if ${escape(planned.failure_condition)}</p>` : '<p>The exact acceptance criterion is unavailable for this scope.</p>'}
    <dl class="work-check-receipt">${field('Receipt result',result ? ({passed:'Passed',failed:'Failed',blocked:'Blocked',not_run:'Not run'})[result.state] : check.state === 'verified' ? 'Verified in progress record' : 'Awaiting verification')}
    ${field('Recorded by',result ? receipt.attribution.actor_ref : null)}${field('Recorded via',result ? receipt.attribution.adapter_ref : null)}
    ${field('Claim recorded',Number.isFinite(claimTime) ? new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Chicago'}).format(claimTime) + ' CT' : null)}
    </dl><p class="work-check-review">Independent review · ${escape(review ? `${readableCheck(review.state)} · ${review.reviewer_ref}` : 'Not recorded')}<br>Independent verification time · Not recorded</p>
    <h5>Evidence</h5>${result?.evidence_refs.length ? `<ul class="work-check-evidence">${result.evidence_refs.map(item => `<li>${escape(item.ref)}<small>${escape(item.redaction_class.replaceAll('_',' '))}</small></li>`).join('')}</ul>` : `<p>${check.state === 'verified' ? 'The progress record verifies this check. Its receipt is unavailable for this scope.' : 'No verification receipt is recorded for this check.'}</p>`}
    <details class="work-check-raw"><summary data-job-control="raw-${escape(checkKey(check))}">Receipt and Passport JSON</summary><pre tabindex="0" data-job-control="raw-content-${escape(checkKey(check))}" aria-label="Receipt JSON">${escape(JSON.stringify({check:result || check,receipt:result ? receipt : null,review:review || null,passport_scope:passport?.accepted_plan_revision || null},null,2))}</pre><a data-job-control="passport-${escape(checkKey(check))}" href="${escape(workDetailUrl({workRequest}))}#workCanonicalPassport">Open Engineering Passport</a></details>`;
}
export function workProgressHtml(read, workRequest, passport, selectedKey) {
  const progress = workProgress(read,workRequest);
  const history = progress.history || [];
  const accepted = passport?.accepted_plan_revision;
  const exactPassport = canonicalPassport(passport) && progress.scope?.plan_ref === accepted.id
    && progress.scope.revision === accepted.revision && progress.scope.digest === accepted.digest ? passport : null;
  const planned = check => exactPassport?.slice_plan.slices.find(slice => slice.slice_ref === check.slice_ref)?.planned_checks.find(row => row.check_ref === check.check_ref);
  const selected = progress.checks.find(check => checkKey(check) === selectedKey) || progress.checks[0];
  const historyHtml = `<details class="work-scope-history" open><summary data-job-control="progress-history">Scope history</summary>${history.length ? `<ol>${history.map((scope,index) => {
    const prior = history[index-1], delta = prior ? scope.total_checks-prior.total_checks : null;
    const change = prior ? delta === 0 ? `Total unchanged since revision ${prior.revision}.` : `Total ${delta > 0 ? 'increased' : 'decreased'} by ${Math.abs(delta)} check${Math.abs(delta) === 1 ? '' : 's'} since revision ${prior.revision}.` : 'Initial registered scope.';
    return `<li><strong>Revision ${scope.revision}</strong> · ${scope.total_checks} acceptance checks<p>${change}</p></li>`;
  }).join('')}</ol>` : '<p>No registered scope history is available.</p>'}</details>`;
  const inspector = `<div class="work-progress-inspector">${progress.checks.map((check,index) => `<section id="work-check-${index}" data-check-evidence="${escape(checkKey(check))}" aria-label="${escape(readableCheck(check.check_ref))} evidence"${check === selected ? '' : ' hidden'}>${checkReceiptHtml(check,exactPassport,planned(check),workRequest)}</section>`).join('')}${historyHtml}</div>`;
  return `<section class="work-progress" aria-label="Acceptance progress" data-progress-state="${progress.state}"><h3>Acceptance checks</h3>
    <div class="work-progress-overview"><p class="work-progress-summary">${escape(progress.label)}</p>
    ${progress.state === 'available' ? `<span>${progress.remaining} remaining</span><progress max="${progress.total}" value="${progress.completed}" aria-label="Verified acceptance checks"></progress>` : `<p>${escape(progress.reason || '')}</p>`}</div>
    ${progress.scope ? `<p class="work-progress-scope">Scope revision ${progress.scope.revision} · ${escape(progress.scope.plan_ref)}</p>` : ''}
    ${selected ? `<div class="work-progress-layout"><ul class="work-progress-checks">${progress.checks.map((check,index) => `<li data-check-state="${check.state}">
      ${index === 0 || progress.checks[index-1].slice_ref !== check.slice_ref ? `<p class="work-check-objective">${escape(check.objective)}</p>` : ''}<button type="button" data-progress-check="${escape(checkKey(check))}" data-job-control="check-${escape(check.slice_ref)}-${escape(check.check_ref)}" aria-expanded="${check === selected}" aria-controls="work-check-${index}"><span class="work-check-criterion">${escape(readableCheck(check.check_ref))}</span><strong>${check.state === 'verified' ? 'Verified' : 'Remaining'}</strong></button>${check === selected ? inspector : ''}</li>`).join('')}</ul></div>` : historyHtml}</section>`;
}
const workFields = new Set(['work_request','work_request_id','work_request_ref','canonical_work_ref']);
const taskFields = new Set(['task_id','task_ref']);
const jobFields = new Set(['job_ref','job_id']);
const attemptFields = new Set(['attempt_id','attempt_ref','latest_attempt_ref']);
const bindingFields = new Set([...taskFields,...workFields,'session_id','canonical_session_id','session_ref','native_session_ref']);
function exactReference(value, refs, depth = 0) {
  if (depth > 12 || value == null) return false;
  if (typeof value === 'string') return refs.has(value);
  if (Array.isArray(value)) return value.some(item => typeof item === 'object' && exactReference(item, refs, depth + 1));
  if (typeof value === 'object') {
    if (refs.has(value.session_status?.claimed) || refs.has(value.assignment?.ref)) return true;
    return Object.entries(value).some(([key,item]) =>
    bindingFields.has(key) ? typeof item === 'string' ? refs.has(item) : key === 'work_request' && refs.has(item?.id)
      : typeof item === 'object' && exactReference(item, refs, depth + 1));
  }
  return false;
}
// Attempt numbers are local to a job. Retain their validated envelope identity
// rather than widening the set of globally sufficient references.
export function passportAttempts(passport) {
  const envelopes = new Map(passport.execution_envelopes.map(envelope => [passportProjectionDigest(envelope), envelope]));
  return passport.receipts.map(receipt => ({ attemptId: receipt.attempt_id, envelopeDigest: receipt.envelope_digest,
    jobRef: envelopes.get(receipt.envelope_digest).request.job_ref }));
}
function evidenceIdentity(value, scope) {
  const refs = scopeRefs(scope), attempts = scope.attempts || [];
  if (!scope.task && !scope.workRequest) return {contradicts:false,boundAttempt:false};
  let contradicts = false, boundAttempt = false;
  function visit(value, inherited = {}, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item,inherited,depth+1)); return; }
    const context = {...inherited};
    // Read the work binding first; JSON member order cannot change a join.
    for (const [key,item] of Object.entries(value)) {
      const ref = typeof item === 'string' ? item : key === 'work_request' ? item?.id : null;
      if ((workFields.has(key) || taskFields.has(key)) && refs.has(ref)) context.workBound = true;
    }
    for (const [key,item] of Object.entries(value)) {
      const ref = typeof item === 'string' ? item : key === 'work_request' ? item?.id : null;
      if (!ref) continue;
      if (workFields.has(key) || taskFields.has(key)) {
        if (!refs.has(ref)) contradicts = true;
      } else if (jobFields.has(key)) {
        context.jobRef = ref;
        if (!attempts.some(attempt => attempt.jobRef === ref) && !refs.has(ref)) contradicts = true;
      } else if (key === 'envelope_digest') {
        context.envelopeDigest = ref;
        if (!context.workBound && !attempts.some(attempt => attempt.envelopeDigest === ref)) contradicts = true;
      }
    }
    for (const [key,item] of Object.entries(value)) {
      if (attemptFields.has(key) && typeof item === 'string' && (context.jobRef || context.envelopeDigest)) {
        const matched = attempts.some(attempt => attempt.attemptId === item
          && (!context.jobRef || attempt.jobRef === context.jobRef)
          && (!context.envelopeDigest || attempt.envelopeDigest === context.envelopeDigest));
        if (matched) boundAttempt = true;
        // An explicit work binding can include older envelopes not in the
        // current read. It never authorizes a tuple from a different known job.
        else if (!(context.workBound && !context.jobRef && !attempts.some(attempt => attempt.envelopeDigest === context.envelopeDigest))) contradicts = true;
      } else if (typeof item === 'object') visit(item,context,depth+1);
    }
  }
  visit(value);
  return {contradicts,boundAttempt};
}
export function sourceSequence(value) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value))) return null;
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}
function sequenceJoin(value, scope) {
  const seq = sourceSequence(value);
  return seq !== null && (scope.sourceSeqs || []).some(item => sourceSequence(item) === seq);
}
// Conversation mentions remain visible but cannot establish executor links.
export function executionTurn(turn, scope) {
  let body;
  try { body = JSON.parse(turn.body); } catch { /* raw conversation has no structured identity */ }
  const value = {...turn, body}, identity = evidenceIdentity(value,scope);
  if (identity.contradicts) return false;
  return identity.boundAttempt || sequenceJoin(turn.seq,scope) || exactReference(value,scopeRefs(scope));
}
function scopeRefs(scope) {
  return new Set([scope.task, scope.workRequest, scope.session, ...(scope.refs || [])].filter(Boolean)
    .flatMap(ref => [ref, `job:${ref}`]));
}
export function scopedTurn(turn, scope) {
  if (!scope.task && !scope.workRequest && !scope.session) return true;
  if (executionTurn(turn,scope)) return true;
  const refs = scopeRefs(scope);
  try { JSON.parse(turn.body); return false; } catch { /* raw conversation below */ }
  // Explicit reference tokens in raw turns identify their topic; they never
  // promote an outcome or establish an executor/session relationship.
  const tokens = String(turn.body || '').split(/[^A-Za-z0-9_:.-]+/);
  return tokens.some(token => refs.has(token.replace(/[.:]+$/, '')));
}
export function scopedQueueCard(card, scope) {
  if (!scope.task && !scope.workRequest && !scope.session) return true;
  const identity = evidenceIdentity(card,scope);
  return !identity.contradicts && (identity.boundAttempt || exactReference(card,scopeRefs(scope)) || sequenceJoin(card.source_seq,scope));
}

// The canonical HTTP/MCP read includes current-generation arrays. The wire
// renderer's sealed historical form is a separate contract and stays strict.
export function canonicalPassport(value) {
  try { return validCanonicalEngineeringPassport(value); } catch { return false; }
}

const linkageText=value=>typeof value==='string'&&!!value.trim()&&!/[\u0000-\u001f]/.test(value);
const linkageRelations=new Set(['blocked_by','parent','work_request','pull_request','plan','slice','job','related']);
function validLinkageReference(ref) {
 if(!ref||!linkageRelations.has(ref.relation)||!linkageText(ref.ref)||!linkageText(ref.title)||!['resolved','unresolved','unavailable'].includes(ref.state))return false;
 if(ref.state!=='resolved')return ref.target===null;
 const target=ref.target;
 if(!target||typeof target!=='object'||Array.isArray(target))return false;
 const keys=Object.keys(target).sort().join(',');
 if(keys==='board_id,task_id')return ['blocked_by','parent','related'].includes(ref.relation)&&linkageText(target.board_id)&&linkageText(target.task_id)&&target.task_id===ref.ref;
 if(keys==='work_request')return ref.relation==='work_request'&&/^WR-[0-9]{1,12}$/.test(target.work_request)&&target.work_request===ref.ref;
 if(keys==='url')return ref.relation==='pull_request'&&target.url===ref.ref&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(target.url);
 return false;
}

export function workDependencies(task,board,{linked=true}={}) {
 const read=task?.linkage;
 const source=task?.linkage_source || {board_id:task?.identity?.board_id||board,task_id:task?.kind==='progress_task'?task.identity?.task_id:task?.id,version:task?.version};
 if(!linked||read?.schema!=='work-linkage.v1'||read.state!=='complete'||!Array.isArray(read.references)
  ||read.subject?.board_id!==source.board_id||read.subject?.task_id!==source.task_id
  ||!Number.isSafeInteger(source.version)||source.version<1||read.subject?.version!==source.version||read.reason!==null||!read.references.every(validLinkageReference)||read.references.some(ref=>ref.target?.board_id&&ref.target.board_id!==source.board_id)
  ||task.linkage_metadata_unavailable!=null||['dependency_refs','depends_on','blocked_by','blocker_ref','blocker_task_id','parent_refs','related_refs','dependencies'].some(key=>task[key]!=null)||task.held?.blocker!=null
  ||!read.references.length&&['work_request','work_request_ref','work_request_id','canonical_work_ref','human_ref','parent_task_id','parent_ref','parent_id','parent','plan_ref','plan_id','plan','slice_ref','slice_id','slice','job_ref','job_id','pr','pr_url','pr_links','blocked_by_task_ids','related'].some(key=>task[key]!=null&&(!Array.isArray(task[key])||task[key].length>0)))
  return {state:'unavailable',references:[],reason:!linked?'The source record is unavailable. Its dependencies cannot be verified.':'No verified dependency observation is available for this work record.'};
 const references=[...new Map(read.references.map(reference=>[JSON.stringify([reference.relation,reference.ref]),reference])).values()].map(reference=>{
  const self=reference.target?.board_id===source.board_id&&reference.target?.task_id===source.task_id;
  const state=self?'unresolved':reference.state;
  const target=self?null:reference.target;
  const href=state==='resolved'&&target
   ? target.task_id?workDetailUrl({board:target.board_id,task:target.task_id})
    : target.work_request?workDetailUrl({board,workRequest:target.work_request}):target.url||null:null;
  return {...reference,state,target,href};
 });
 return {state:references.some(ref=>ref.state==='unavailable')?'unavailable':references.some(ref=>ref.state==='unresolved')?'unresolved':references.length?'linked':'unlinked',references};
}
export function workDependenciesHtml(task,board,options) {
 const model=workDependencies(task,board,options);
 const label={linked:'Linked',unlinked:'Unlinked',unavailable:'Unavailable',unresolved:'Unresolved'}[model.state];
 const labels={blocked_by:'Blocked by',parent:'Parent',work_request:'Work Request',pull_request:'Pull request',plan:'Plan',slice:'Slice',job:'Job',related:'Related work'};
 const rows=model.references.map(ref=>`<li><span class="work-dependency-relation">${labels[ref.relation]}</span><${ref.href?'a':'span'}${ref.href?` data-job-control="dependency-${escape(ref.relation)}-${escape(ref.ref)}" href="${escape(ref.href)}"`:''}>${escape(ref.title||ref.ref)}</${ref.href?'a':'span'}>${ref.title&&ref.title!==ref.ref?`<small>${escape(ref.ref)}</small>`:''}${ref.state!=='resolved'?`<span class="work-dependency-state">${ref.state==='unresolved'?'Unresolved':'Unavailable'}</span><p>${ref.state==='unresolved'?'This reference has no verified destination. Ask the work owner to repair the link.':'This linked record could not be read. Refresh this page to retry, then ask the work owner to check access if it remains unavailable.'}</p>`:''}</li>`).join('');
 return `<section class="work-dependencies" aria-label="Dependencies and linkage" data-linkage-state="${model.state}"><h3>Dependencies and linkage</h3><p>${label}</p>${model.reason?`<p>${escape(model.reason)}</p><p>Refresh this page to retry. If it remains unavailable, ask the work owner to republish its linkage.</p>`:''}${rows?`<ul>${rows}</ul>`:''}${model.state==='unlinked'?'<p>No recorded linkage on this fully observed work record.</p>':''}</section>`;
}
