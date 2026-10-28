import { escapeText as esc } from './change-receipts.mjs';

export function renderDealVendors(vendors = []) {
  if (!vendors.length) return '';
  const roles = new Map();
  const seen = new Set();
  for (const vendor of vendors) {
    const role = (vendor.role || '').trim();
    const company = (vendor.company?.name || '').trim();
    const contact = (vendor.contact?.name || '').trim();
    const key = JSON.stringify([role, company, contact].map(value => value.toLowerCase()));
    if (seen.has(key)) continue;
    seen.add(key);
    const roleKey = role.toLowerCase();
    if (!roles.has(roleKey)) roles.set(roleKey, { role, rows: [] });
    roles.get(roleKey).rows.push(vendor);
  }
  return `<dl class="deal-vendors" aria-label="Vendors">${[...roles.values()].map(({ role, rows }) => {
    const label = role.replaceAll('_', ' ');
    return `<div class="deal-vendor-group"><dt class="deal-vendor-role">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</dt><dd><ul>${rows.map(vendor => {
      const company = vendor.company?.name?.trim();
      const contact = vendor.contact?.name?.trim();
      const email = vendor.contact?.email?.trim();
      const phone = vendor.contact?.phone?.trim();
      const digits = phone?.replace(/\D/g, '');
      const phoneHref = digits ? `${phone.startsWith('+') ? '+' : ''}${digits}` : '';
      const name = contact || company || 'vendor';
      return `<li>${company ? `<span class="deal-vendor-company">${esc(company)}</span>` : ''}${contact ? `<span class="deal-vendor-contact">${esc(contact)}</span>` : ''}${email || phoneHref ? `<details class="deal-vendor-details"><summary>Contact details</summary>${email ? `<p>Email <a href="mailto:${esc(encodeURIComponent(email).replaceAll('%40', '@'))}" aria-label="${esc(`Email ${name}`)}">${esc(email)}</a></p>` : ''}${phoneHref ? `<p>Phone <a href="tel:${esc(phoneHref)}" aria-label="${esc(`Call ${name}`)}">${esc(phone)}</a></p>` : ''}</details>` : ''}</li>`;
    }).join('')}</ul></dd></div>`;
  }).join('')}</dl>`;
}
