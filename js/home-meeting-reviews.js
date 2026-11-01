import { workCard } from './work-card.js';
import { BUSINESS_TIME_ZONE } from './business-date.js';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const text = value => typeof value === 'string' && value.trim().length > 0;
const instant = value => text(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
/** The well-formed meeting reviews in a brief calendar section, newest first. */
export function meetingReviews(calendar) {
  const rows = Array.isArray(calendar?.follow_up_reviews) ? calendar.follow_up_reviews : [];
  return rows.filter(row => row?.state === 'needs_review' && row.confirmed !== true && row.dismissed !== true && typeof row.key === 'string' && /^[a-f0-9]{16}$/.test(row.key)
    && text(row.title) && instant(row.start) !== null && instant(row.end) !== null && instant(row.end) > instant(row.start))
    .map(row => ({ key: row.key, title: row.title.trim(), start: row.start, end: row.end }))
    .sort((a, b) => instant(b.end) - instant(a.end) || a.key.localeCompare(b.key));
}

const when = review => {
  const options = { timeZone: BUSINESS_TIME_ZONE, hour: 'numeric', minute: '2-digit' };
  const day = new Date(review.start).toLocaleDateString(undefined, { timeZone: BUSINESS_TIME_ZONE, month: 'short', day: 'numeric' });
  return `${day}, ${new Date(review.start).toLocaleTimeString(undefined, options)} to ${new Date(review.end).toLocaleTimeString(undefined, { ...options, timeZoneName: 'short' })}`;
};

export function mountHomeMeetingReviews({ document, client, host }) {
  let view = {}, actor = null, handled = new Set(), generation = 0, disposed = false, notice = '', commands;
  const decisions = new Map(), choices = new Map();
  const deals = () => {
    const rows = (view.deals || []).filter(deal => text(deal?.id) && text(deal?.name));
    return [...rows.filter(deal => deal.owner === actor), ...rows.filter(deal => deal.owner !== actor)];
  };
  const visible = () => view.signedOut || !text(actor) ? []
    : meetingReviews(view.calendar).filter(review => !handled.has(review.key) || decisions.get(review.key)?.state === 'uncertain');
  const render = () => {
    if (disposed) return;
    const focused = host.contains(document.activeElement) ? document.activeElement?.dataset.homeKey : null;
    const reviews = visible(), options = deals();
    host.hidden = !reviews.length && !notice;
    if (host.hidden) { host.replaceChildren(); return; }
    const rows = reviews.map(review => {
      const decision = decisions.get(review.key);
      const busy = decision?.state === 'submitting', uncertain = decision?.state === 'uncertain';
      const dismissing = decision?.action === 'dismiss' && (busy || uncertain);
      const chosen = decision?.dealId || choices.get(review.key) || '';
      const select = options.length
        ? `<label>Deal <select data-review-deal="${E(review.key)}" data-home-key="review:${E(review.key)}:deal"${busy || uncertain ? ' disabled' : ''}><option value="">Choose a deal</option>${options.map(deal => `<option value="${E(deal.id)}"${deal.id === chosen ? ' selected' : ''}>${E(deal.name)}</option>`).join('')}</select></label>`
        : '<span>No open deals to log this meeting on.</span>';
      return workCard({ className: 'home-call-task home-meeting-review', attributes: `data-review="${E(review.key)}"`,
        title: E(review.title), meta: `<time datetime="${E(review.start)}">${E(when(review))}</time>`, status: uncertain ? 'Unconfirmed' : '',
        body: `${decision?.error ? `<p class="home-call-task-error" role="alert">${E(decision.error)}</p>` : ''}`,
        actions: `${select}<button type="button" class="home-outline" data-review-log="${E(review.key)}" data-home-key="review:${E(review.key)}:log"${busy || dismissing || !chosen ? ' disabled' : ''}>${decision?.action === 'log' && uncertain ? 'Check meeting log' : decision?.action === 'log' && busy ? 'Logging…' : 'It happened'}</button><button type="button" class="home-outline" data-review-dismiss="${E(review.key)}" data-home-key="review:${E(review.key)}:dismiss"${busy || uncertain && !dismissing ? ' disabled' : ''}>${dismissing && uncertain ? 'Check dismissal' : dismissing && busy ? 'Saving…' : 'Dismiss'}</button>` });
    }).join('');
    host.innerHTML = `<header class="home-panel-head"><h2>Did these meetings happen?</h2><span class="home-period">Last 24 hours</span></header><p class="home-empty">From your Outlook calendar. Pick the deal and log the meeting, or dismiss it.</p>${notice ? `<p class="home-call-task-notice" role="status">${E(notice)}</p>` : ''}${rows}`;
    if (focused) ([...host.querySelectorAll('[data-home-key]')].find(node => node.dataset.homeKey === focused) || document.getElementById('homePrimaryAction'))?.focus();
  };
  const answer = async (review, action = 'log') => {
    const prior = decisions.get(review.key);
    const dealId = prior?.dealId || choices.get(review.key);
    const deal = deals().find(row => row.id === dealId);
    if ((action === 'log' && !deal) || prior?.state === 'submitting') return;
    const ticket = generation, binding = actor;
    decisions.set(review.key, { state: 'submitting', dealId, action }); notice = ''; render();
    try {
      if (!commands) {
        const { createRetainedCommands } = await import('./retained-commands.mjs');
        commands ||= createRetainedCommands({ scope: () => actor });
      }
      const request = action === 'dismiss'
        ? { board_id: 'calendar-agenda', question_id: review.key, base_version: 1, answer_text: 'Dismiss' }
        : { ref: deal.id, kind: 'meeting', summary: `Meeting: ${review.title}`,
          occurred_at: new Date(review.start).toISOString(), calendar_event_key: review.key };
      await commands.send(`meeting-review:${review.key}`, request, async args => {
        const receipt = action === 'dismiss' ? await client.answerBoardQuestion(args) : await client.logActivity(args);
        if (receipt?.ok !== true || (action === 'dismiss'
          ? receipt.answer?.question_id !== review.key || receipt.answer?.answer_text !== 'Dismiss'
          : !text(receipt.activity_id)))
          throw Object.assign(new Error('Meeting answer could not be verified'), { code: 'unknown_outcome' });
        return receipt;
      });
      if (disposed || ticket !== generation || actor !== binding) return;
      decisions.delete(review.key); handled.add(review.key);
      notice = action === 'dismiss' ? '' : `Meeting logged on ${deal.name}.`;
    } catch (error) {
      if (disposed || ticket !== generation || actor !== binding) return;
      if (error.pendingRequest) decisions.set(review.key, { state: 'uncertain', dealId, action, error: action === 'dismiss' ? 'Dismissal not confirmed yet. Check dismissal before choosing again.' : 'Not confirmed yet. Check the meeting log before choosing again.' });
      else decisions.set(review.key, { state: 'failed', action, error: action === 'dismiss' ? 'The meeting was not dismissed. Try again.' : 'The meeting was not logged. Try again or choose another deal.' });
    }
    render();
  };
  const onClick = event => {
    const logButton = event.target.closest('[data-review-log]'), dismiss = event.target.closest('[data-review-dismiss]');
    const key = logButton?.dataset.reviewLog || dismiss?.dataset.reviewDismiss;
    const review = key && visible().find(row => row.key === key);
    if (!review || (logButton || dismiss).disabled) return;
    if (logButton) { void answer(review); return; }
    void answer(review, 'dismiss');
  };
  const onChange = event => {
    const select = event.target.closest('[data-review-deal]');
    if (!select) return;
    choices.set(select.dataset.reviewDeal, select.value);
    if (decisions.get(select.dataset.reviewDeal)?.state === 'failed') decisions.delete(select.dataset.reviewDeal);
    render();
  };
  const retire = () => { generation++; decisions.clear(); choices.clear(); notice = ''; actor = null; handled = new Set(); commands = null; host.replaceChildren(); host.hidden = true; };
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  return {
    update(next) {
      if (disposed) return;
      if (next.signedOut || actor && text(next.actor) && actor !== next.actor) retire();
      if (!actor && text(next.actor) && !next.signedOut) { actor = next.actor; }
      view = next;
      render();
    },
    dispose() { retire(); disposed = true; host.removeEventListener('click', onClick); host.removeEventListener('change', onChange); },
  };
}
