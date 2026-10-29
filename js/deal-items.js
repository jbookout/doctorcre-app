import { overdueLabel } from './deal-review-model.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export const openDealItems = deal => (Array.isArray(deal.items) ? deal.items : []).filter(item => item.status === 'open');
export const dealItemHref = (deal, item) => `/deals?deal=${encodeURIComponent(deal)}&item=${encodeURIComponent(item)}`;
export function shortDealName(deal) {
  return deal.short_name || deal.name || 'Deal';
}
export function renderDealAlert(deal, { today = '', heading = 'h3', buttons = false, viewer = '', board = false } = {}) {
  const overdue = overdueLabel(deal.overdue_since, today);
  return `<${heading}>${buttons ? `<button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(shortDealName(deal))}</button>` : `<a data-home-key="deal:${esc(deal.id)}" href="/deals?deal=${encodeURIComponent(deal.id)}">${esc(shortDealName(deal))}</a>`}</${heading}>${overdue ? `<p class="deal-overdue">${overdue}</p>` : ''}${board ? renderDealSummary(deal, { today, viewer }) : ''}${renderDealItems(deal,{today,buttons, empty: !board})}`;
}
export function renderDealItems(deal, { today = '', buttons = false, empty = true } = {}) {
  const items = openDealItems(deal);
  return items.length ? `<p class="deal-items-label">Still needed:</p><ol class="deal-items">${items.map(item => `<li data-overdue="${Boolean(item.due_on && item.due_on < today)}">${buttons ? `<button type="button" data-deal-item="${esc(item.id)}" data-item-deal="${esc(deal.id)}">${esc(item.title)}</button>` : `<a data-home-key="deal:${esc(deal.id)}:${esc(item.id)}" href="${esc(dealItemHref(deal.id, item.id))}">${esc(item.title)}</a>`}${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(item.due_on)}</time>` : ''}</li>`).join('')}</ol>` : empty ? '<p class="deal-items-empty">No action items recorded</p>' : '';
}

function shortDate(value, today) {
  const day = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (!today || day >= today) options.weekday = 'short';
  return `${today && day < today ? 'overdue ' : ''}${date.toLocaleDateString('en-US', options).replace(',', '')}`;
}

export function renderDealSummary(deal, { today = '', viewer = '' } = {}) {
  const actions = (Array.isArray(deal.next_actions) ? deal.next_actions : [])
    .filter(action => action.status === 'open' && typeof action.description === 'string' && action.description.trim())
    .sort((a, b) => (a.due_on || '9999').localeCompare(b.due_on || '9999') || Number(b.owner === viewer) - Number(a.owner === viewer));
  const next = actions[0];
  const step = next?.description || (typeof deal.next_step === 'string' ? deal.next_step : deal.next_step?.text) || '';
  const date = shortDate(next ? next.due_on : deal.next_date, today);
  const actionOwner = next ? next.owner : deal.owner;
  const owner = actionOwner && viewer && actionOwner !== viewer ? ` · ${actionOwner.slice(0, 1).toUpperCase()}` : '';
  const completed = (Array.isArray(deal.next_actions) ? deal.next_actions : []).filter(row => row.status === 'done' && row.description && row.completed_at)
    .map(row => ({ summary: row.description, occurred_at: row.completed_at }));
  const activities = [...(Array.isArray(deal.activities) ? deal.activities : []), ...completed].filter(row => row.summary && row.occurred_at)
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const last = activities[0];
  const lastDate = shortDate(last?.occurred_at || deal.last_touch, '');
  const lines = [];
  if (step.trim()) lines.push(`Next: ${step.trim()}${date ? ` · ${date}` : ''}${owner}`);
  if (last || lastDate) lines.push(`Last: ${last?.summary || 'Contact recorded'}${lastDate ? ` · ${lastDate}` : ''}`);
  if (!lines.length) lines.push('No next step set');
  return lines.map(line => `<p class="deal-summary-line" title="${esc(line)}">${esc(line)}</p>`).join('');
}

export function renderDealItemDetail(item, { today = '' } = {}) {
  const overdue = item.status === 'open' && item.due_on && item.due_on < today;
  const sections = [['promised', 'What was promised'], ['call', 'From the call'], ['suggestion', 'Suggested next steps'], ['status', 'Status']];
  return `<div class="deal-item-date" data-overdue="${Boolean(overdue)}">${overdue ? 'Overdue' : 'Due'} ${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(item.due_on)}</time>` : 'date not recorded'}</div>${sections.map(([kind, label]) => {
    const bullets = (item.bullets || []).filter(bullet => bullet.kind === kind);
    return bullets.length ? `<section><h3>${label}</h3><ul>${bullets.map(bullet => `<li>${bullet.date ? `<time datetime="${esc(bullet.date)}">${esc(bullet.date)}</time> · ` : ''}${esc(bullet.text)}</li>`).join('')}</ul></section>` : '';
  }).join('')}<form data-item-instruction><label for="dealItemInstruction">Tell Dr. CRE</label><textarea id="dealItemInstruction" name="text" aria-label="Tell Dr. CRE" rows="3" maxlength="240" required></textarea><button type="submit" class="btn btn-primary">Save instruction</button></form><button type="button" class="btn" data-complete-item${item.status === 'done' ? ' disabled' : ''}>${item.status === 'done' ? 'Done' : 'Mark done'}</button><p role="status" data-item-status></p>`;
}
