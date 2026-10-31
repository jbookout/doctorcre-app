import { workCard } from './work-card.js';
import { overdueLabel } from './deal-review-model.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export const openDealItems = deal => (Array.isArray(deal.items) ? deal.items : []).filter(item => item.status === 'open');
export const dealItemHref = (deal, item) => `/deals?deal=${encodeURIComponent(deal)}&item=${encodeURIComponent(item)}`;
export function shortDealName(deal) {
  return deal.short_name || deal.name || 'Deal';
}
export const monthDay = value => {
  const day = String(value || '').slice(0, 10), date = new Date(`${day}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
};
/** The one overdue treatment on board cards and list rows: a tappable age that opens the deal. */
export const renderOverdueFlag = (id, name, label) => label ? `<button type="button" class="attention-flag" data-open="${esc(id)}" aria-label="${esc(label)}, open ${esc(name)}">${esc(label)}</button>` : '';
export function renderDealAlert(deal, { today = '' } = {}) {
  return workCard({ className: 'home-flag deal-alert',
    title: `<a data-home-key="deal:${esc(deal.id)}" href="/deals?deal=${encodeURIComponent(deal.id)}">${esc(shortDealName(deal))}</a>`,
    meta: esc(({ joe: 'Joe', dell: 'Dell' })[deal.owner] || deal.owner || 'Unassigned'),
    status: overdueLabel(deal.overdue_since, today) || '', body: renderDealItems(deal, { today }) });
}

export function renderDealItems(deal, { today = '', buttons = false, empty = true, board = false } = {}) {
  const next = board ? nextOpenAction(deal) : null;
  const items = openDealItems(deal).filter(item => !next || item.title.trim() !== next.description.trim() || (item.due_on || null) !== (next.due_on || null));
  return items.length ? `<p class="deal-items-label">Still needed:</p><ol class="deal-items">${items.map(item => `<li data-overdue="${Boolean(item.due_on && item.due_on < today)}">${buttons ? `<button type="button" data-deal-item="${esc(item.id)}" data-item-deal="${esc(deal.id)}">${esc(item.title)}</button>` : `<a data-home-key="deal:${esc(deal.id)}:${esc(item.id)}" href="${esc(dealItemHref(deal.id, item.id))}">${esc(item.title)}</a>`}${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(monthDay(item.due_on) || item.due_on)}</time>` : ''}</li>`).join('')}</ol>` : empty ? '<p class="deal-items-empty">No action items recorded</p>' : '';
}

function shortDate(value, today) {
  const day = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (!today || day >= today) options.weekday = 'short';
  return date.toLocaleDateString('en-US', options).replace(',', '');
}

function nextOpenAction(deal) {
  return (deal.open_actions || []).filter(action => typeof action.description === 'string' && action.description.trim())
    .sort((a, b) => (a.due_on || '9999').localeCompare(b.due_on || '9999') || a.id.localeCompare(b.id))[0];
}

export function renderDealSummary(deal, { today = '', viewer = '', board = false, actorName = name => name } = {}) {
  const next = nextOpenAction(deal);
  const lines = [];
  if (next) {
    const date = next.due_on && next.due_on < today ? '' : shortDate(next.due_on, today);
    const owner = !board && next.owner && viewer && next.owner !== viewer ? ` · ${actorName(next.owner)}` : '';
    lines.push(`<span class="deal-summary-line"><span class="deal-summary-label">Next: </span><span class="deal-summary-text">${esc(next.description.trim())}</span><span class="deal-summary-facts">${date ? ` · <time data-overdue="${Boolean(next.due_on && next.due_on < today)}" datetime="${esc(next.due_on)}">${esc(date)}</time>` : ''}${esc(owner)}</span></span>`);
  } else {
    lines.push('<span class="deal-summary-line">No next step set</span>');
  }
  const last = deal.last_step;
  const lastDate = shortDate(last?.occurred_at, '');
  if (last?.summary?.trim() && lastDate) {
    lines.push(`<span class="deal-summary-line deal-summary-last"><span class="deal-summary-label">Last: </span><span class="deal-summary-text">${esc(last.summary.trim())}</span><span class="deal-summary-facts"> · <time datetime="${esc(last.occurred_at)}">${esc(lastDate)}</time></span></span>`);
  }
  return lines.join('');
}

export function renderDealItemDetail(item, { today = '' } = {}) {
  const overdue = item.status === 'open' && item.due_on && item.due_on < today;
  const sections = [['promised', 'What was promised'], ['call', 'From the call'], ['suggestion', 'Suggested next steps'], ['status', 'Status']];
  return `<div class="deal-item-date" data-overdue="${Boolean(overdue)}">${overdue ? 'Overdue' : 'Due'} ${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(monthDay(item.due_on) || item.due_on)}</time>` : 'date not recorded'}</div>${sections.map(([kind, label]) => {
    const bullets = (item.bullets || []).filter(bullet => bullet.kind === kind);
    return bullets.length ? `<section><h3>${label}</h3><ul>${bullets.map(bullet => `<li>${bullet.date ? `<time datetime="${esc(bullet.date)}">${esc(bullet.date)}</time> · ` : ''}${esc(bullet.text)}</li>`).join('')}</ul></section>` : '';
  }).join('')}<form data-item-instruction><label for="dealItemInstruction">Tell Dr. CRE</label><textarea id="dealItemInstruction" name="text" aria-label="Tell Dr. CRE" rows="3" maxlength="240" required></textarea><button type="submit" class="btn btn-primary" disabled>Save instruction</button><p>Not submitted. This control cannot send a request to Dr. CRE.</p></form><button type="button" class="btn" data-complete-item${item.status === 'done' ? ' disabled' : ''}>${item.status === 'done' ? 'Done' : 'Mark done'}</button><p role="status" data-item-status></p>`;
}
