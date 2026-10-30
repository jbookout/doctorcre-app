import { escapeText as esc } from './change-receipts.mjs';
import { FACT_TERMS } from './client.js';
import { uuidv4 } from './uuid.js';

import { COMPARISON_ROWS as ROWS } from './terms-comparison-fields.js';
const fieldLink = key => `<a href="#term-${key}" data-comparison-field="${key}">${esc(FACT_TERMS[key].label)}</a>`;
const versionLabel = fact => `v${fact.version}${fact.promoted_at && Number.isFinite(Date.parse(fact.promoted_at)) ? ` · ${new Date(fact.promoted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : ''}`;

function draftHtml(plan, fields, items) {
  const edits = new Map(plan.edits.map(edit => [edit.where, edit.text]));
  const cell = address => edits.get(`cell:LOI Grid!${address}`);
  return `<article class="terms-draft" data-comparison-draft aria-label="Terms comparison draft">
    <header><h3>${esc(plan.template.name)}</h3><span class="fact-state">Draft</span></header>
    <p class="terms-draft-note">${esc(plan.human_gate)}</p>
    ${fields.map(ref => {
      const history = items.find(item => item.fact_key === ref.fact_key).canonical_history;
      return `<p class="terms-versions"><strong>${esc(FACT_TERMS[ref.fact_key].label)}</strong> · Prior: ${esc(versionLabel(history.find(f => f.version === ref.prior_version)))} · Current: ${esc(versionLabel(history.find(f => f.version === ref.current_version)))}</p>`;
    }).join('')}
    <div class="terms-draft-groups">${[['B', 'Prior'], ['C', 'Current']].map(([column, label]) => `<section><h4>${label}</h4><dl>${fields.map(ref => {
      const row = ROWS[ref.fact_key];
      return `<div><dt>${esc(cell(`A${row}`))}</dt><dd><strong>${esc(cell(`${column}${row}`))}</strong><small>${esc(cell(`${column}4`)?.replace(`${label} - `, ''))}</small></dd></div>`;
    }).join('')}</dl></section>`).join('')}</div>
    <h4>Remaining work</h4><ul>${plan.remaining.map(text => `<li>${esc(text)}</li>`).join('')}${Object.keys(ROWS).filter(key => !fields.some(ref => ref.fact_key === key)).map(key => `<li>${fieldLink(key)} · Missing confirmed versions for comparison.</li>`).join('')}</ul>
  </article>`;
}

export function mountTermsComparison(root, { client, entityRef }) {
  let disposed = false, state = 'ready', request = null, snapshot = [];
  root.innerHTML = '<button type="button" class="btn" data-prepare-comparison>Prepare terms comparison</button><div data-comparison-result aria-live="polite"></div>';
  const button = root.querySelector('button');
  const result = root.querySelector('[data-comparison-result]');
  async function prepare() {
    if (state === 'loading') return;
    state = 'loading'; button.disabled = true;
    result.innerHTML = '<p role="status">Preparing terms comparison…</p>';
    try {
      if (!request) {
        snapshot = []; let cursor;
        do {
          const page = await client.listFactReview({ entity_ref: entityRef, include_resolved: true, limit: 100, ...(cursor ? { cursor } : {}) });
          if (disposed) return;
          if (page.schema_version !== 'fact-review.v1' || !Array.isArray(page.items) || page.items.some(item => item.entity_ref !== entityRef)
            || page.has_more && (!page.next_cursor || page.next_cursor === cursor)) throw new Error('Terms unavailable');
          snapshot.push(...page.items);
          cursor = page.has_more ? page.next_cursor : null;
        } while (cursor);
        const referenced = snapshot.filter(item => Object.hasOwn(ROWS, item.fact_key) && item.canonical_version > 0
          && item.canonical_history.some(fact => fact.version < item.canonical_version));
        if (!referenced.length) {
          const keys = Object.keys(ROWS);
          result.innerHTML = `<p>Confirm prior and current versions before preparing the comparison.</p><ul>${keys.map(key => `<li>${fieldLink(key)} · Missing confirmed prior or current version.</li>`).join('')}</ul>`;
          return;
        }
        const fields = referenced.sort((a, b) => ROWS[a.fact_key] - ROWS[b.fact_key]).map(item => ({ fact_key: item.fact_key,
          prior_version: Math.max(...item.canonical_history.filter(fact => fact.version < item.canonical_version).map(fact => fact.version)), current_version: item.canonical_version }));
        request = { idempotency_key: uuidv4(), deal_id: entityRef, fields };
      }
      const plan = await client.prepareTermsComparison(request);
      if (disposed) return;
      result.innerHTML = draftHtml(plan, request.fields, snapshot);
      request = null; button.textContent = 'Prepare again';
    } catch (error) {
      if (disposed) return;
      const payload = error.payload;
      if (payload?.reason === 'stale_snapshot' || payload?.error === 'stale_snapshot') {
        request = null;
        result.innerHTML = '<p>A fact changed since this snapshot. Prepare again to compare the latest confirmed versions.</p>';
        button.textContent = 'Prepare again';
      } else if (payload?.error === 'comparison_fact_blocked' && Object.hasOwn(ROWS, payload.field)) {
        request = null;
        const reason = { missing: 'Missing confirmed fact', unresolved: 'Unresolved fact', missing_version: 'Missing confirmed version', source_not_permitted: 'Source not permitted', invalid_value: 'Value needs review' }[payload.reason] || 'Fact needs review';
        result.innerHTML = `<p>Review the named field before preparing the comparison.</p><ul><li>${fieldLink(payload.field)} · ${reason}.</li></ul>`;
        button.textContent = 'Prepare again';
      } else {
        const unavailable = !client.prepareTermsComparison || [404, 405, 501, 503].includes(error.status) || payload?.error === 'comparison_template_unavailable';
        result.innerHTML = `<p>${unavailable ? 'Terms comparison unavailable. The server or reviewed template may not be deployed yet.' : error.status === 401 || error.status === 403 ? 'Sign in again before preparing a terms comparison.' : 'Could not prepare the terms comparison.'}${error.pendingRequest ? ' Keep this tab open. Check outcome retries the same request.' : ' Try again.'}</p>`;
        request = error.pendingRequest || null;
        button.textContent = request ? 'Check outcome' : 'Prepare again';
      }
    } finally {
      state = 'ready';
      if (!disposed) button.disabled = false;
    }
  }
  function click(event) {
    if (event.target.closest('[data-prepare-comparison]')) void prepare();
    const link = event.target.closest('[data-comparison-field]');
    if (link) {
      event.preventDefault();
      event.stopPropagation();
      const target = root.ownerDocument.getElementById(`term-${link.dataset.comparisonField}`);
      target?.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    }
  }
  root.addEventListener('click', click);
  return { dispose() { disposed = true; root.removeEventListener('click', click); } };
}
