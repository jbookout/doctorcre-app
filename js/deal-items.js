import { overdueLabel } from './deal-review-model.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export const openDealItems = deal => (Array.isArray(deal.items) ? deal.items : []).filter(item => item.status === 'open');
export const dealItemHref = (deal, item) => `/deals?deal=${encodeURIComponent(deal)}&item=${encodeURIComponent(item)}`;
export function shortDealName(deal) {
  return deal.short_name || deal.name || 'Deal';
}
export function renderDealAlert(deal, { today = '', heading = 'h3', buttons = false } = {}) {
  const overdue = overdueLabel(deal.overdue_since, today);
  return `<${heading}>${buttons ? `<button class="card-open" type="button" data-open="${esc(deal.id)}">${esc(shortDealName(deal))}</button>` : `<a data-home-key="deal:${esc(deal.id)}" href="/deals?deal=${encodeURIComponent(deal.id)}">${esc(shortDealName(deal))}</a>`}</${heading}>${overdue ? `<p class="deal-overdue">${overdue}</p>` : ''}${renderDealItems(deal,{today,buttons})}`;
}
export function renderDealItems(deal, { today = '', buttons = false } = {}) {
  const items = openDealItems(deal);
  return items.length ? `<p class="deal-items-label">Still needed:</p><ol class="deal-items">${items.map(item => `<li data-overdue="${Boolean(item.due_on && item.due_on < today)}">${buttons ? `<button type="button" data-deal-item="${esc(item.id)}" data-item-deal="${esc(deal.id)}">${esc(item.title)}</button>` : `<a data-home-key="deal:${esc(deal.id)}:${esc(item.id)}" href="${esc(dealItemHref(deal.id, item.id))}">${esc(item.title)}</a>`}${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(item.due_on)}</time>` : ''}</li>`).join('')}</ol>` : '<p class="deal-items-empty">No action items recorded</p>';
}

export function renderDealItemDetail(item, { today = '' } = {}) {
  const overdue = item.status === 'open' && item.due_on && item.due_on < today;
  const sections = [['promised', 'What was promised'], ['call', 'From the call'], ['suggestion', 'Suggested next steps'], ['status', 'Status']];
  return `<div class="deal-item-date" data-overdue="${Boolean(overdue)}">${overdue ? 'Overdue' : 'Due'} ${item.due_on ? `<time class="deal-item-due" datetime="${esc(item.due_on)}">${esc(item.due_on)}</time>` : 'date not recorded'}</div>${sections.map(([kind, label]) => {
    const bullets = (item.bullets || []).filter(bullet => bullet.kind === kind);
    return bullets.length ? `<section><h3>${label}</h3><ul>${bullets.map(bullet => `<li>${bullet.date ? `<time datetime="${esc(bullet.date)}">${esc(bullet.date)}</time> · ` : ''}${esc(bullet.text)}</li>`).join('')}</ul></section>` : '';
  }).join('')}<form data-item-instruction><label for="dealItemInstruction">Tell Dr. CRE</label><textarea id="dealItemInstruction" name="text" aria-label="Tell Dr. CRE" rows="3" maxlength="240" required></textarea><button type="submit" class="btn btn-primary">Save instruction</button></form><button type="button" class="btn" data-complete-item${item.status === 'done' ? ' disabled' : ''}>${item.status === 'done' ? 'Done' : 'Mark done'}</button><p role="status" data-item-status></p>`;
}
