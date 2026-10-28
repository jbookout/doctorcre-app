import { escapeText as esc } from './change-receipts.mjs';

function phoneParts(phone) {
  const extension = phone.match(/(?:extension|ext\.?|x|#)\s*(\d+)\s*$/i);
  const digits = (extension ? phone.slice(0, extension.index) : phone).replace(/\D/g, '');
  return { digits, extension: extension?.[1] || '' };
}

export function renderDealVendors(vendors = []) {
  if (!vendors.length) return '';
  const roles = new Map();
  const seen = new Map();
  for (const vendor of vendors) {
    const role = (vendor.role || '').trim();
    const company = (vendor.company?.name || '').trim();
    const contact = (vendor.contact?.name || '').trim();
    const key = JSON.stringify([role.toLowerCase(), company.toLowerCase(), contact.toLowerCase()]);
    const matches = seen.get(key) || [];
    const existing = matches.find(row => ['email', 'phone'].every(field => {
      const a = row.contact?.[field]?.trim().toLowerCase();
      const b = vendor.contact?.[field]?.trim().toLowerCase();
      if (!a || !b) return true;
      if (field === 'email') return a === b;
      const first = phoneParts(a);
      const second = phoneParts(b);
      return first.digits && second.digits ? first.digits === second.digits && first.extension === second.extension : a === b;
    }));
    if (existing) {
      for (const field of ['email', 'phone']) {
        if (!existing.contact?.[field]?.trim() && vendor.contact?.[field]?.trim()) existing.contact = { ...existing.contact, [field]: vendor.contact[field] };
      }
      continue;
    }
    const row = { ...vendor, contact: vendor.contact && { ...vendor.contact } };
    matches.push(row);
    seen.set(key, matches);
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
      const { digits, extension } = phoneParts(phone || '');
      const phoneHref = digits ? `${phone.startsWith('+') ? '+' : ''}${digits}${extension ? `;ext=${extension}` : ''}` : '';
      return `<li>${company ? `<span class="deal-vendor-company">${esc(company)}</span>` : ''}${contact ? `<span class="deal-vendor-contact">${esc(contact)}</span>` : ''}${email || phone ? `<details class="deal-vendor-details"><summary>Contact details</summary>${email ? `<p>Email <a href="mailto:${esc(encodeURIComponent(email).replaceAll('%40', '@'))}">${esc(email).replaceAll('@', '<wbr>@').replaceAll('.', '<wbr>.')}</a></p>` : ''}${phone ? `<p>Phone ${phoneHref ? `<a href="tel:${esc(phoneHref)}">${esc(phone)}</a>` : esc(phone)}</p>` : ''}</details>` : ''}</li>`;
    }).join('')}</ul></dd></div>`;
  }).join('')}</dl>`;
}
