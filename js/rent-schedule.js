import { escapeText as esc } from './change-receipts.mjs';

const bases = { nnn: 'NNN', modified_gross: 'Modified gross', full_service_gross: 'Full service gross', gross: 'Gross' };
const units = { 'USD/SF/year': '/SF/yr', 'USD/SF/month': '/SF/mo', 'USD/SF': '/SF', USD: '' };

function money(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}

export function scheduleHtml(periods, sourced) {
  const value = field => sourced ? field.value : field;
  const label = (...fields) => sourced && fields.some(field => field.source.method === 'ocr') ? '<small class="fact-read">OCR · verify</small>' : '';
  return `<table class="fact-schedule"><thead><tr><th>Period</th><th>Rate</th><th>Escalation</th><th>Expense basis</th></tr></thead><tbody>${periods.map(p => `<tr>
    <td data-label="Period"><span>${esc(value(p.start_month))}–${esc(value(p.end_month))} months${label(p.start_month, p.end_month)}</span></td>
    <td data-label="Rate"><span>${esc(money(value(p.rate)))}${esc(units[value(p.unit)] ?? ` ${value(p.unit)}`)}${label(p.rate, p.unit)}</span></td>
    <td data-label="Escalation"><span>${esc(value(p.escalation_percent) == null ? '—' : `${value(p.escalation_percent)}%`)}${label(p.escalation_percent)}</span></td>
    <td data-label="Expense basis"><span>${esc(bases[value(p.expense_basis)] ?? value(p.expense_basis))}${label(p.expense_basis)}</span></td></tr>`).join('')}</tbody></table>`;
}
