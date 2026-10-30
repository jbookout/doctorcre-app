import { escapeText } from './change-receipts.mjs';

/** Slots contain caller-escaped HTML. Record attributes keep each surface's commands local. */
export function workCard({ title, meta, status = '', body = '', actions = '', variant = 'stack', className = '', attributes = '', heading = 'h3' }) {
  return `<article class="work-card work-card--${variant} ${className}" ${attributes}><${heading} class="work-card-title">${title}</${heading}><div class="work-card-meta">${meta}</div>${status ? `<span class="work-card-status">${escapeText(status)}</span>` : ''}${body.trim() ? `<div class="work-card-body">${body}</div>` : ''}${actions ? `<div class="work-card-actions">${actions}</div>` : ''}</article>`;
}
