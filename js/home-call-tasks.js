import { toDay } from './calendar-model.js';

const text = value => typeof value === 'string' && value.trim().length > 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const owners = new Map([['joe', 'Joe'], ['dell', 'Dell']]);
const ownerLabel = owner => owners.get(owner);
const malformed = () => Object.assign(new Error('Call tasks unavailable'), { code: 'malformed_response' });

export async function readHomeCallTasks(client, { signal } = {}) {
  const payload = await client.getPostCallFollowups({ signal });
  if (!record(payload) || payload.schema_version !== 'post-call-followups.v1' || payload.send !== false
    || !Array.isArray(payload.candidates) || payload.candidates.length > 1000) throw malformed();
  const ids = new Set(), tasks = [];
  for (const row of payload.candidates) {
    if (!record(row) || !text(row.id) || ids.has(row.id) || !['assigned_action', 'email_draft'].includes(row.kind)
      || !text(row.session_id) || !text(row.deal_id) || !text(row.deal_name) || !record(row.payload)
      || row.payload.deal_id !== row.deal_id || !text(row.created_at) || !Number.isFinite(Date.parse(row.created_at))
      || !(row.evidence_quote === null || typeof row.evidence_quote === 'string')) throw malformed();
    ids.add(row.id);
    const p = row.payload;
    if (row.kind === 'email_draft') {
      if (!text(p.recipient_party_id) || !text(p.recipient_ref) || !text(p.subject) || !/^[a-f0-9]{64}$/.test(p.body_sha256)) throw malformed();
      continue;
    }
    if (!ownerLabel(p.assignee) || !text(p.action)
      || !(p.due_on === null || typeof p.due_on === 'string' && toDay(p.due_on) === p.due_on)) throw malformed();
    tasks.push({ candidateId: row.id, sessionId: row.session_id, dealId: row.deal_id, dealName: row.deal_name,
      owner: p.assignee, description: p.action, dueOn: p.due_on, evidence: row.evidence_quote || '' });
  }
  return tasks;
}

export function mountHomeCallTasks({ document, client, host, onChanged }) {
  let view = {}, actor = null, generation = 0, disposed = false, notice = '', noticeFresh = false, painted = '';
  const decisions = new Map();
  let commands;
  const admitted = () => !disposed && !view.signedOut && !view.busy && view.read?.state === 'read' && text(actor);
  const visible = () => {
    const tasks = new Map((view.tasks || []).map(task => [task.candidateId, task]));
    for (const [id, decision] of decisions) if (decision.state === 'uncertain' || decision.state === 'submitting') tasks.set(id, decision.task);
    return [...tasks.values()].filter(task => view.scope !== 'mine' || task.owner === actor);
  };
  const render = () => {
    if (disposed) return;
    const focused = host.contains(document.activeElement) ? document.activeElement?.dataset.callTaskKey : null;
    const tasks = view.signedOut ? [] : visible(), flags = [];
    const unavailable = view.read?.state === 'error' || view.scope === 'mine' && !actor;
    host.hidden = !tasks.length && !unavailable && !notice;
    host.setAttribute('aria-busy', String(Boolean(view.busy)));
    const markup = `<h3>Call tasks to review</h3>${notice ? `<p class="home-call-task-notice" role="status">${E(notice)}</p>` : ''}${unavailable ? '<p class="home-empty" role="status">Call tasks unavailable. Refresh Home to try again.</p>' : ''}${tasks.map(task => {
      const decision = decisions.get(task.candidateId);
      const disabled = !admitted() || ['submitting', 'resolved'].includes(decision?.state);
      const uncertain = decision?.state === 'uncertain';
      const date = task.dueOn ? new Date(`${task.dueOn}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date';
      return `<article class="home-call-task" data-call-task="${E(task.candidateId)}"><div><a href="/deals?deal=${encodeURIComponent(task.dealId)}">${E(task.dealName)}</a><p>${E(task.description)}</p><span>${E(ownerLabel(task.owner))} · ${task.dueOn ? `<time datetime="${E(task.dueOn)}">${E(date)}</time>` : date}</span>${task.evidence ? `<details><summary>Call evidence</summary><p>${E(task.evidence)}</p></details>` : ''}${uncertain ? '<p class="home-call-task-error" role="alert">Task outcome is unconfirmed. Check the original decision before changing it.</p>' : ''}</div><div class="home-call-task-controls"><button type="button" class="home-outline" data-call-task-id="${E(task.candidateId)}" data-call-task-accept="true" data-call-task-key="${E(task.candidateId)}:true"${(flags.push(disabled || uncertain && !decision.accept), '')}>${uncertain && decision.accept ? 'Check task outcome' : `Add ${ownerLabel(task.owner)} task`}</button><button type="button" class="home-outline" data-call-task-id="${E(task.candidateId)}" data-call-task-accept="false" data-call-task-key="${E(task.candidateId)}:false"${(flags.push(disabled || uncertain && decision.accept), '')}>${uncertain && !decision.accept ? 'Check task outcome' : 'Skip'}</button></div></article>`;
    }).join('')}`;
    if (markup !== painted) { host.innerHTML = markup; painted = markup; }
    host.querySelectorAll('[data-call-task-key]').forEach((node, index) => {
      if (flags[index]) node.setAttribute('aria-disabled', 'true'); else node.removeAttribute('aria-disabled');
    });
    if (focused) ([...host.querySelectorAll('[data-call-task-key]')].find(node => node.dataset.callTaskKey === focused) || document.getElementById('homePrimaryAction'))?.focus();
  };
  const decide = async event => {
    const button = event.target.closest('[data-call-task-id]');
    if (!button || button.getAttribute('aria-disabled') === 'true' || !admitted()) return;
    const id = button.dataset.callTaskId, accept = button.dataset.callTaskAccept === 'true';
    const prior = decisions.get(id), task = visible().find(row => row.candidateId === id);
    if (!task || prior?.state === 'submitting' || prior?.state === 'resolved' || prior?.state === 'uncertain' && prior.accept !== accept) return;
    const ticket = generation, binding = actor;
    decisions.set(id, { state: 'submitting', accept, task }); notice = ''; noticeFresh = false; render();
    try {
      if (!commands) {
        const { createRetainedCommands } = await import('./retained-commands.mjs');
        if (disposed || ticket !== generation || actor !== binding) return;
        commands ||= createRetainedCommands({ scope: () => actor });
      }
      const result = await commands.send(id, { candidate_id: id, accept }, async request => {
        const receipt = await client.resolvePostCallCandidate(request);
        const already = ['confirmed', 'skipped'].includes(receipt?.already);
        if (receipt?.ok !== true || receipt.candidate_id !== id
          || receipt.already !== undefined && !already
          || !(already || receipt.status === (accept ? 'confirmed' : 'skipped'))
          || accept && !already && (!text(receipt.ref) || receipt.assignee !== task.owner))
          throw Object.assign(new Error('Task outcome could not be verified'), { code: 'unknown_outcome' });
        return receipt;
      });
      if (disposed || ticket !== generation || actor !== binding) return;
      decisions.set(id, { state: 'resolved', accept, task });
      notice = result.already ? 'This proposal was already resolved. Refreshing Home.' : accept ? 'Task added' : 'Task skipped';
      noticeFresh = true;
      render();
      try { await onChanged(); } finally { noticeFresh = false; }
    } catch {
      if (disposed || ticket !== generation || actor !== binding) return;
      decisions.set(id, { state: 'uncertain', accept, task });
      render();
      await onChanged();
    }
  };
  const retire = () => { disposed = true; generation++; decisions.clear(); host.replaceChildren(); painted = ''; host.hidden = true; };
  host.addEventListener('click', decide);
  document.defaultView?.addEventListener('doctorcre-session-invalidated', retire);
  return {
    update(next) {
      if (disposed) return;
      if (next.signedOut || actor && text(next.actor) && actor !== next.actor) { retire(); return; }
      actor = next.actor || actor; view = next;
      if (view.read?.state === 'read' && !noticeFresh) notice = '';
      render();
    },
    dispose() { retire(); host.removeEventListener('click', decide); document.defaultView?.removeEventListener('doctorcre-session-invalidated', retire); },
  };
}
