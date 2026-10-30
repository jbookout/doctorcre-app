import { newestFirst } from './change-receipts.mjs';
import { sourceTime } from './email-source-line.js';
import { correspondenceState, meetingEvidence, readinessRequest, readinessState, threadReferences, unavailableEvidence } from './correspondence-model.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function evidenceGroup(title, state) {
  const group = title === 'Threads' ? 'threads' : 'meetings';
  if (state.state === 'refused') return `<div class="evidence-group" data-evidence-group="${group}" data-state="refused"><h4>${title} unavailable</h4><a href="/auth/login">Sign in</a></div>`;
  if (state.state !== 'ready') return `<div class="evidence-group" data-evidence-group="${group}" data-state="${esc(state.state)}"><h4>${title} ${state.state === 'loading' ? 'loading…' : 'unavailable'}</h4>${state.state === 'loading' ? '' : '<button type="button" data-evidence-retry>Retry evidence</button>'}</div>`;
  if (!state.items?.length) return `<div class="evidence-group" data-evidence-group="${group}"><h4>${title}</h4><p>No linked evidence</p></div>`;
  return `<div class="evidence-group" data-evidence-group="${group}"><h4>${title}</h4><ol class="evidence-timeline">${state.items.map(item => `<li class="evidence-item" data-kind="${item.kind === 'email-thread' ? 'thread' : esc(item.kind)}"><details><summary><span>${esc(item.title)}</span><time datetime="${esc(item.when)}">${esc(item.kind === 'thread' ? 'Read ' : '')}${esc(sourceTime(item.when))}</time></summary><p>${item.kind === 'thread' || item.kind === 'email-thread' ? 'Email' : 'Meeting'}</p></details></li>`).join('')}</ol></div>`;
}
export function renderEvidence(view = {}) {
  const groups = [['Threads',view.threads],['Meetings',view.meetings]].filter(([,state]) => state?.state);
  return groups.length ? `<section class="correspondence-evidence" aria-label="Evidence"><h3>Evidence</h3>${groups.map(([title,state]) => evidenceGroup(title,state)).join('')}</section>` : '';
}
async function boundedRead(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } catch (error) { if ([401,403].includes(error?.status)) throw error; return null; } finally { clearTimeout(timer); }
}
export async function loadEvidence(client, detail = {}, { timeoutMs = 8000 } = {}) {
  if (Array.isArray(detail.email_threads)) {
    const items = newestFirst(detail.email_threads.map(row => ({ kind: 'email-thread', title: row.subject || '(No subject)', when: row.latest_message_at })), item => item.when);
    return { threads: { state: 'ready', count: items.length, items }, meetings: meetingEvidence(detail.activities) };
  }
  try {
    const readiness = readinessState(await boundedRead(() => client.correspondenceReadiness(readinessRequest()), timeoutMs));
    const { references, complete } = threadReferences(detail);
    // No discovery verb exists. The get-deal-room activity pointer is the link to
    // THIS deal; native ids are never inferred from names, note ids or deal ids.
    const results = await Promise.all(references.map(async identity => correspondenceState(
      await boundedRead(() => client.readCorrespondenceThread(identity), timeoutMs), identity)));
    const items = newestFirst(results.flatMap(result => result.items), item => item.when);
    const failed = results.some(result => result.state !== 'ready');
    const threads = !complete ? unavailableEvidence('thread_coverage_unavailable')
      : !references.length ? unavailableEvidence(readiness.reason === 'adapter_unavailable' ? readiness.reason : 'native_identity_unavailable')
      : failed ? unavailableEvidence(results.find(result => result.state !== 'ready').reason)
        : { state: 'ready', count: items.length, items };
    return { threads, meetings: meetingEvidence(detail.activities) };
  } catch (error) {
    if (![401,403].includes(error?.status)) throw error;
    const refused = {state:'refused',items:[],count:null,status:error.status};
    return {threads:refused,meetings:refused};
  }
}
export function mountEvidence(root, { client, detail = {}, timeoutMs, onDenied, initialView } = {}) {
  let disposed = false, generation = 0;
  async function refresh() {
    const current = ++generation;
    // Replace only the thread group so meeting disclosures and focus survive.
    paint({threads:{state:'loading',items:[]},meetings:meetingEvidence(detail.activities)});
    const view = await loadEvidence(client, detail, {timeoutMs});
    if (disposed || current !== generation) return;
    if (view.threads.state === 'refused') { root.innerHTML = renderEvidence(view); onDenied?.({status:view.threads.status}); return; }
    paint(view);
  }
  function paint(view) {
    if (!root.querySelector('.correspondence-evidence')) { root.innerHTML = renderEvidence(view); return; }
    for (const [group, title] of [['threads','Threads'],['meetings','Meetings']]) {
      const node = root.querySelector(`[data-evidence-group="${group}"]`);
      if (group === 'meetings' && node && view.meetings.state === 'ready') continue;
      if (node) node.outerHTML = evidenceGroup(title,view[group]);
      else root.querySelector('.correspondence-evidence').insertAdjacentHTML('beforeend',evidenceGroup(title,view[group]));
    }
  }
  const click = event => { if (event.target.closest('[data-evidence-retry]')) void refresh(); };
  root.addEventListener('click',click);
  if (initialView) root.innerHTML = renderEvidence(initialView);
  else void refresh();
  return () => { disposed = true; ++generation; root.removeEventListener('click',click); };
}
