import { correspondenceState, meetingEvidence, readinessRequest, readinessState, threadReferences, unavailableEvidence } from './correspondence-model.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const when = value => new Date(value).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

function evidenceGroup(title, state) {
  const group = title === 'Threads' ? 'threads' : 'meetings';
  const items = [...state.items].sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
  return `<div class="evidence-group" data-evidence-group="${group}"><h4>${title}</h4><ol class="evidence-timeline">${items.map(item => `<li class="evidence-item" data-kind="${esc(item.kind)}"><details><summary><span>${esc(item.title)}</span><time datetime="${esc(item.when)}">${esc(when(item.when))}</time></summary><p>${item.kind === 'thread' ? 'Email' : 'Meeting'}</p></details></li>`).join('')}</ol></div>`;
}
export function renderEvidence(view = {}) {
  const groups = [['Threads',view.threads],['Meetings',view.meetings]].filter(([,state]) => state?.state === 'ready' && state.items?.length);
  return groups.length ? `<section class="correspondence-evidence" aria-label="Evidence"><h3>Evidence</h3>${groups.map(([title,state]) => evidenceGroup(title,state)).join('')}</section>` : '';
}
async function boundedRead(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } catch { return null; } finally { clearTimeout(timer); }
}
export async function loadEvidence(client, detail = {}, { timeoutMs = 8000 } = {}) {
  const readiness = readinessState(await boundedRead(() => client.correspondenceReadiness(readinessRequest()), timeoutMs));
  const { references, complete } = threadReferences(detail);
  // No discovery verb exists. The get-deal-room activity pointer is the link to
  // THIS deal; native ids are never inferred from names, note ids or deal ids.
  const results = await Promise.all(references.map(async identity => correspondenceState(
    await boundedRead(() => client.readCorrespondenceThread(identity), timeoutMs), identity)));
  const items = results.flatMap(result => result.items);
  const failed = results.some(result => result.state !== 'ready');
  const threads = !complete ? unavailableEvidence('thread_coverage_unavailable')
    : !references.length ? unavailableEvidence(readiness.reason === 'adapter_unavailable' ? readiness.reason : 'native_identity_unavailable')
    : failed ? unavailableEvidence(results.find(result => result.state !== 'ready').reason)
      : { state: 'ready', count: items.length, items };
  return { threads, meetings: meetingEvidence(detail.activities) };
}
export function mountEvidence(root, { client, detail = {}, timeoutMs } = {}) {
  let disposed = false;
  root.innerHTML = renderEvidence({meetings:meetingEvidence(detail.activities)});
  loadEvidence(client, detail, { timeoutMs }).then(view => {
    if (disposed) return;
    const section = root.querySelector('.correspondence-evidence');
    if (!section) { root.innerHTML = renderEvidence(view); return; }
    if (view.threads.state === 'ready' && view.threads.items.length)
      section.insertAdjacentHTML('beforeend',evidenceGroup('Threads',view.threads));
  });
  return () => { disposed = true; };
}
