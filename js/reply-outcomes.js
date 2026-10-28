import { readWithDeadline } from './current-read.mjs';

const PAGE_SIZE = 20;
const REASONS = {
  invalid_submission: 'The submitted reply was invalid.',
  submission_hash_mismatch: 'The submitted reply did not match the approved content.',
  submission_recipients_invalid: 'The submitted recipients were invalid.',
  aborted_before_dispatch: 'Sending stopped before dispatch.',
  unconfirmed_after_dispatch: 'Delivery could not be confirmed after dispatch.',
  delivery_failed: 'Delivery failed.',
};
const E = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initial = () => ({ status: 'idle', rows: [], more: false, cursor: null, loaded: false });
const partner = actor => ['joe', 'dell'].includes(actor);
function pageRows(value, stream, actor) {
  if (value?.schema_version !== (stream === 'recent' ? 'email-reply-outcomes.v1' : 'email-proposals.v1') || value.send !== false
    || !Array.isArray(value.proposals) || value.proposals.length > PAGE_SIZE || typeof value.more !== 'boolean'
    || (value.more ? !value.proposals.length || value.next_cursor !== value.proposals.at(-1)?.id : value.next_cursor !== null)
    || value.proposals.some(row => !row || typeof row.id !== 'string' || !row.id)
    || new Set(value.proposals.map(row => row.id)).size !== value.proposals.length) throw Error('Invalid reply outcomes page');
  const rows = stream === 'recent' ? value.proposals : value.proposals.filter(row => row.kind === 'reply_draft' && row.reply_draft?.owner === actor);
  return rows.map(row => {
    const subject = stream === 'recent' ? row.subject : row.submitted_email?.subject;
    if (typeof subject !== 'string' || !subject.trim() || typeof row.deal !== 'string' || !row.deal
      || (stream === 'recent' ? !['sent', 'failed'].includes(row.outcome) || typeof row.result_recorded_at !== 'string'
        || !Number.isFinite(Date.parse(row.result_recorded_at)) || (row.outcome === 'sent' ? row.failure_reason_code !== null : !Object.hasOwn(REASONS, row.failure_reason_code))
        : row.status !== 'approved_to_send' || row.send_result != null)) throw Error('Invalid reply outcome');
    return { id: row.id, deal: row.deal, subject, outcome: stream === 'recent' ? row.outcome : 'pending',
      recordedAt: stream === 'recent' ? row.result_recorded_at : null,
      reason: stream === 'recent' && row.outcome === 'failed' ? REASONS[row.failure_reason_code] : null };
  });
}

export function mountReplyOutcomes({ container, client }) {
  const win = container.ownerDocument.defaultView;
  let actor = null, retired = false, disposed = false, epoch = 0;
  let streams = { pending: initial(), recent: initial() };
  function render() {
    if (disposed) return;
    const focused = container.contains(container.ownerDocument.activeElement) ? container.ownerDocument.activeElement : null;
    const focusStream = focused?.dataset.replyRetry || focused?.dataset.replyMore;
    const focusReply = focused?.closest('[data-reply-outcome]')?.dataset.replyOutcome;
    const focusHref = focused?.getAttribute('href');
    container.setAttribute('aria-busy', String(Object.values(streams).some(state => state.status === 'loading')));
    const sections = Object.entries(streams).map(([name, state]) => {
      const rows = name === 'pending' ? state.rows.filter(row => !streams.recent.rows.some(outcome => outcome.id === row.id)) : state.rows;
      const title = name === 'recent' ? 'recent replies' : 'pending replies';
      return `<section aria-label="${name === 'recent' ? 'Recent replies' : 'Pending replies'}">
        <h3 tabindex="-1">${name === 'recent' ? 'Recent replies' : 'Pending replies'}</h3>
        ${state.status === 'loading' ? '<p class="home-empty" role="status">Updating replies…</p>' : ''}
        ${state.status === 'error' ? `<p role="status">Could not load ${title}.${state.loaded ? ' Showing the last successful read.' : ''}</p><button type="button" class="home-outline" data-reply-retry="${name}">Retry ${title}</button>` : ''}
        ${state.loaded && state.status === 'ready' && !rows.length ? `<p class="home-empty">${state.more ? 'No matching replies on this page. More replies are available.' : name === 'recent' ? 'No recent replies.' : 'No replies waiting to send.'}</p>` : ''}
        ${rows.map(row => `<article class="email-proposal" data-reply-outcome="${E(row.id)}">
          <h4>${E(row.subject)}</h4>
          <p>${row.outcome === 'sent' ? 'Sent' : row.outcome === 'failed' ? `Failed · ${E(row.reason)}` : 'Pending · Delivery is not yet confirmed.'}</p>
          ${row.recordedAt ? `<p>Result recorded <time datetime="${E(row.recordedAt)}">${E(new Date(row.recordedAt).toLocaleString())}</time></p>` : ''}
          <a href="/deals?deal=${encodeURIComponent(row.deal)}">Open deal</a>
        </article>`).join('')}
        ${state.more && state.status !== 'error' ? `<button type="button" class="home-outline" data-reply-more="${name}"${state.status === 'loading' ? ' disabled' : ''}>Load more ${name === 'recent' ? 'recent replies' : 'pending replies'}</button>` : ''}
      </section>`;
    }).join('');
    container.innerHTML = retired || !partner(actor) ? '<p role="status">Sign in as a partner to see your replies.</p>' : sections;
    if (focused) {
      const replyLink = focusReply && [...container.querySelectorAll('[data-reply-outcome]')].find(node => node.dataset.replyOutcome === focusReply)?.querySelector('a');
      (replyLink?.getAttribute('href') === focusHref ? replyLink : container.querySelector(`[data-reply-retry="${focusStream}"], [data-reply-more="${focusStream}"]`) || container.querySelector('h3'))?.focus();
    }
  }
  function retire() {
    epoch++; retired = true; streams = { recent: initial(), pending: initial() }; render();
  }
  async function load(name, append = false) {
    if (disposed || retired || !partner(actor)) return;
    if (client.selfActor !== actor) return retire();
    const current = streams[name];
    if (current.status === 'loading') return;
    const ticket = epoch;
    streams[name] = { ...current, status: 'loading' }; render();
    try {
      const value = await readWithDeadline(() => client.listEmailProposals({ ...(name === 'recent' ? { mode: 'recent_outcomes' } : { status: 'approved_to_send' }), limit: PAGE_SIZE, ...(append ? { cursor: current.cursor } : {}) }), { timeoutMs: 10_000 });
      if (disposed || retired || ticket !== epoch) return;
      if (client.selfActor !== actor) return retire();
      const rows = pageRows(value, name, actor);
      streams[name] = { status: 'ready', rows: append ? [...current.rows, ...rows.filter(row => !current.rows.some(old => old.id === row.id))] : rows,
        more: value.more, cursor: value.next_cursor, loaded: true };
    } catch (error) {
      if (disposed || retired || ticket !== epoch) return;
      if ([401, 403].includes(error.status) || error.code === 'session_changed' || client.selfActor !== actor) return retire();
      streams[name] = { ...current, status: 'error', failedAppend: append };
    }
    render();
  }
  async function refresh() {
    if (disposed || retired) return;
    if (actor && client.selfActor !== actor) return retire();
    actor = partner(client.selfActor) ? client.selfActor : null;
    epoch++; streams = Object.fromEntries(Object.entries(streams).map(([name, state]) => [name, { ...state, status: 'idle' }]));
    if (!actor) { render(); return; }
    await Promise.all([load('recent'), load('pending')]);
  }
  function syncActor() {
    if (!actor && partner(client.selfActor) && !retired) void refresh();
    else if (actor && client.selfActor !== actor) retire();
  }
  const click = event => {
    const retry = event.target?.closest('[data-reply-retry]');
    if (retry) void load(retry.dataset.replyRetry, streams[retry.dataset.replyRetry].failedAppend === true);
    const more = event.target?.closest('[data-reply-more]');
    if (more) void load(more.dataset.replyMore, true);
  };
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  return { refresh, syncActor, dispose() { retire(); disposed = true; container.removeEventListener('click', click); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
