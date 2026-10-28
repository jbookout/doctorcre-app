import { escapeText as esc } from './change-receipts.mjs';

export function renderDealVendors(vendors = []) {
  if (!vendors.length) return '';
  const roles = new Map();
  const seen = new Map();
  for (const vendor of vendors) {
    const role = (vendor.role || '').trim();
    const company = (vendor.company?.name || '').trim();
    const contact = (vendor.contact?.name || '').trim();
    const key = JSON.stringify([role.toLowerCase(), vendor.party_id || null, vendor.company?.id || company.toLowerCase(), vendor.contact?.id || contact.toLowerCase()]);
    if (seen.has(key)) {
      const existing = seen.get(key);
      for (const field of ['email', 'phone']) {
        if (!existing.contact?.[field]?.trim() && vendor.contact?.[field]?.trim()) existing.contact = { ...existing.contact, [field]: vendor.contact[field] };
      }
      continue;
    }
    const row = { ...vendor, contact: vendor.contact && { ...vendor.contact } };
    seen.set(key, row);
    const roleKey = role.toLowerCase();
    if (!roles.has(roleKey)) roles.set(roleKey, { role, rows: [] });
    roles.get(roleKey).rows.push(row);
  }
  return `<dl class="deal-vendors" aria-label="Vendors">${[...roles.values()].map(({ role, rows }) => {
    const label = role.replaceAll('_', ' ');
    return `<div class="deal-vendor-group"><dt class="deal-vendor-role">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</dt><dd><ul>${rows.map(vendor => {
      const company = vendor.company?.name?.trim();
      const contact = vendor.contact?.name?.trim();
      const email = vendor.contact?.email?.trim();
      const phone = vendor.contact?.phone?.trim();
      const extension = phone?.match(/(?:ext\.?|x)\s*(\d+)\s*$/i);
      const digits = (extension ? phone.slice(0, extension.index) : phone)?.replace(/\D/g, '');
      const phoneHref = digits ? `${phone.startsWith('+') ? '+' : ''}${digits}${extension ? `;ext=${extension[1]}` : ''}` : '';
      return `<li>${company ? `<span class="deal-vendor-company">${esc(company)}</span>` : ''}${contact ? `<span class="deal-vendor-contact">${esc(contact)}</span>` : ''}${email || phone ? `<details class="deal-vendor-details"><summary>Contact details</summary>${email ? `<p>Email <a href="mailto:${esc(encodeURIComponent(email).replaceAll('%40', '@'))}">${esc(email)}</a></p>` : ''}${phone ? `<p>Phone ${phoneHref ? `<a href="tel:${esc(phoneHref)}">${esc(phone)}</a>` : esc(phone)}</p>` : ''}</details>` : ''}</li>`;
    }).join('')}</ul></dd></div>`;
  }).join('')}</dl>`;
}
