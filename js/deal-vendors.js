import { escapeText as esc } from './change-receipts.mjs';

export function renderDealVendors(vendors = []) {
  if (!vendors.length) return '';
  const roles = new Map();
  for (const vendor of vendors) {
    if (!roles.has(vendor.role)) roles.set(vendor.role, []);
    roles.get(vendor.role).push(vendor);
  }
  return `<dl class="deal-vendors" aria-label="Vendors">${[...roles].map(([role, rows]) => {
    const label = role.replaceAll('_', ' ');
    return `<div class="deal-vendor-group"><dt class="deal-vendor-role">${esc(label[0].toUpperCase() + label.slice(1))}</dt><dd><ul>${rows.map(vendor => {
      const email = vendor.contact.email?.trim();
      const phone = vendor.contact.phone?.trim();
      return `<li><span class="deal-vendor-company">${esc(vendor.company.name)}</span><span class="deal-vendor-contact">${esc(vendor.contact.name)}</span>${email || phone ? `<details class="deal-vendor-details"><summary>Contact details</summary>${email ? `<p>Email <span>${esc(email)}</span></p>` : ''}${phone ? `<p>Phone <span>${esc(phone)}</span></p>` : ''}</details>` : ''}</li>`;
    }).join('')}</ul></dd></div>`;
  }).join('')}</dl>`;
}
