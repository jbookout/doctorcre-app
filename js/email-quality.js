import { readWithDeadline } from './current-read.mjs';

const LABELS = { phase_move: 'Phase changes', next_step: 'Next steps' };
const E = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const percent = value => value === null ? 'No resolved proposals' : `${Number((value * 100).toFixed(1))}%`;
const confidence = value => value === null ? 'Unavailable' : percent(value);
const ratio = value => value === null || (Number.isFinite(value) && value >= 0 && value <= 1);
function validReport(value) {
  return value?.schema_version === 'email-proposal-quality.v1' && value.days === 7 && value.send === false
    && Array.isArray(value.kinds) && value.kinds.length === 2 && new Set(value.kinds.map(row => row?.kind)).size === 2
    && value.kinds.every(row => Object.hasOwn(LABELS, row?.kind) && ['proposed', 'pending', 'confirmed', 'dismissed'].every(key => Number.isInteger(row[key]) && row[key] >= 0)
      && row.proposed === row.pending + row.confirmed + row.dismissed
      && ((row.confirmed + row.dismissed === 0) === (row.dismiss_rate === null))
      && ratio(row.dismiss_rate) && ratio(row.confirmed_confidence) && ratio(row.dismissed_confidence) && typeof row.over_threshold === 'boolean')
    && Array.isArray(value.corrections) && value.corrections.length <= 20
    && value.corrections.every(row => row && typeof row.id === 'string' && Object.hasOwn(LABELS, row.kind)
      && typeof row.deal_name === 'string' && typeof row.reason === 'string' && typeof row.resolved_at === 'string' && Number.isFinite(Date.parse(row.resolved_at)));
}

export function mountEmailQuality({ container, client }) {
  const win = container.ownerDocument.defaultView;
  let state = { status: 'loading', report: null }, epoch = 0, disposed = false;
  function render() {
    if (disposed) return;
    const hadFocus = container.contains(container.ownerDocument.activeElement);
    container.setAttribute('aria-busy', String(state.status === 'loading'));
    const notice = state.status === 'denied' ? '<p role="status">Sign in to view email proposal quality.</p>'
      : state.status === 'loading' ? '<p role="status">Updating email proposal quality…</p>'
        : state.status === 'error' ? `<p role="status">Could not load email proposal quality.${state.report ? ' Showing the last successful read.' : ''}</p><button type="button" class="home-outline" data-quality-retry>Retry email proposal quality</button>` : '';
    const report = state.report;
    container.innerHTML = `<header class="home-panel-head"><h2 tabindex="-1">Email proposal quality</h2></header>${notice}${report ? `<p>Proposals created in the last 7 days. Dismissal rate is the share of resolved proposals that were dismissed.</p>${report.kinds.every(row => row.proposed === 0) ? '<p class="home-empty">No email proposals created in this window.</p>' : ''}${report.kinds.map(row => `<article class="email-proposal" data-quality-kind="${row.kind}"><h3>${LABELS[row.kind]}</h3><p>Proposed: ${row.proposed} · Pending: ${row.pending} · Confirmed: ${row.confirmed} · Dismissed: ${row.dismissed}</p><p>Dismissal rate: ${percent(row.dismiss_rate)}</p><p>Confirmed confidence: ${confidence(row.confirmed_confidence)} · Dismissed confidence: ${confidence(row.dismissed_confidence)}</p>${row.over_threshold ? '<p class="email-warning">Above the 5% dismissal threshold with at least 10 resolved proposals. Advisory: keep this type propose-only for review.</p>' : ''}</article>`).join('')}<p>This report does not change automatic application settings.</p><h3>Recent corrections</h3><p>Up to 20 dismissals from proposals created in this window.</p>${report.corrections.length ? report.corrections.map(row => `<article class="email-proposal"><h4>${E(row.deal_name)} · ${LABELS[row.kind]}</h4><p>${E(row.reason)}</p><time datetime="${E(row.resolved_at)}">${E(new Date(row.resolved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</time></article>`).join('') : '<p class="home-empty">No corrections in this window.</p>'}` : ''}`;
    if (hadFocus) (container.querySelector('[data-quality-retry]') || container.querySelector('h2'))?.focus();
  }
  function retire() {
    epoch++;
    state = { status: 'denied', report: null };
    render();
  }
  async function refresh() {
    if (disposed || state.status === 'denied') return;
    const ticket = ++epoch;
    state = { status: 'loading', report: state.report };
    render();
    try {
      const report = await readWithDeadline(() => client.getEmailProposalQuality(), { timeoutMs: 10_000 });
      if (disposed || ticket !== epoch) return;
      if (!validReport(report)) throw Error('Invalid email proposal quality report');
      state = { status: 'ready', report };
    } catch (error) {
      if (disposed || ticket !== epoch) return;
      if ([401, 403].includes(error.status) || error.code === 'session_changed') return retire();
      state = { status: 'error', report: state.report };
    }
    render();
  }
  const click = event => { if (event.target?.closest('[data-quality-retry]')) return refresh(); };
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  return { refresh, dispose() { retire(); disposed = true; container.removeEventListener('click', click); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
