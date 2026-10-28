import { escapeText as esc } from './change-receipts.mjs';

/** The "Client portal" link for a deal; empty when it has none. Only https links become anchors. */
export function renderClientPortalLink(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return '';
  return `<a class="client-portal-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Client portal<span class="sr-only"> (opens in a new tab)</span></a>`;
}
