import { OWNER_FILTERS } from './local-deals-model.js';

export const briefOwnerLabel = row => OWNER_FILTERS.find(filter => filter.value !== 'all' && filter.value === row.owner_partner)?.label || '';
export const filterBriefOwners = (rows, owner = 'all') => rows.filter(row => owner === 'all' || row.owner_partner == null || row.owner_partner === owner);

export function mountBriefOwnerFilter(root, host, onChange) {
  const current = () => root.documentElement.dataset.briefOwner || 'all';
  host.className = 'brief-owner-filter';
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Brief owners');
  host.innerHTML = OWNER_FILTERS.map(({value,label}) => `<button type="button" data-brief-owner="${value}" aria-pressed="false">${label}</button>`).join('');
  const paint = () => { for (const button of host.children) button.setAttribute('aria-pressed', String(button.dataset.briefOwner === current())); };
  const changed = () => { paint(); onChange(current()); };
  host.onclick = event => {
    const button = event.target.closest('[data-brief-owner]');
    if (!button) return;
    root.documentElement.dataset.briefOwner = button.dataset.briefOwner;
    root.dispatchEvent(new root.defaultView.Event('doctorcre:brief-owner'));
  };
  root.addEventListener('doctorcre:brief-owner', changed);
  paint();
  return { current, dispose() { root.removeEventListener('doctorcre:brief-owner', changed); } };
}
