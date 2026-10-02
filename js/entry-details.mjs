import { escapeText } from './change-receipts.mjs';

// A compact preview and the original entry, without manufacturing a summary.
export function entryDetailsHtml(value) {
  const original = String(value ?? '');
  const first = original.split(/(?<=[.!?])\s/)[0];
  const preview = first.length > 180 ? `${first.slice(0,179)}…` : first;
  return `<p>${escapeText(preview)}</p><details><summary>Details</summary><p class="entry-original">${escapeText(original)}</p></details>`;
}
