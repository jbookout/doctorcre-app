import { escapeText as esc } from './change-receipts.mjs';
import { uuidv4 } from './uuid.js';

import { FACT_TERMS } from './client.js';
import { invoiceMoney } from './invoice-tracker-model.js';

const BASES = { nnn: 'NNN', modified_gross: 'Modified gross', full_service_gross: 'Full service gross', gross: 'Gross' };

function valueText(value) {
  if (value.unit === 'schedule' || value.canonical_unit === 'schedule') return 'Rent schedule';
  const amount = value.canonical_unit ? value.normalized_value : value.value;
  const unit = value.canonical_unit || value.unit;
  const units = { 'USD/SF/year': '/SF/yr', 'USD/SF/month': '/SF/mo', 'USD/SF': '/SF', USD: '' };
  const formatted = Object.hasOwn(units, unit) ? `${invoiceMoney(Number(amount))}${units[unit]}` : `${amount} ${unit}`;
  return `${formatted}${value.expense_basis ? ` · ${BASES[value.expense_basis] || value.expense_basis}` : ''}`;
}
function readLabel(observation) {
  const method = { text_layer: 'Text', ocr: 'OCR', human: 'Typed by a partner' }[observation.method] || 'Read method unavailable';
  if (observation.method === 'ocr') return 'OCR · verify';
  const confidence = { auto_accept: 'high', verify_band: 'verify', human_review: 'review' }[observation.confidence_tier];
  return confidence ? `${method} · ${confidence}` : method;
}
function reviewLabel(item) {
  if (!item.pending) return 'Reviewed';
  return `${item.priority === 'high' ? 'High priority · ' : ''}${[...new Set(item.reasons.map(reason => ({ ocr_disagreement: 'OCR disagreement', unsupported_ocr: 'OCR could not read this', no_text_layer: 'No text layer', ambiguous: 'Ambiguous value', absent: 'Value not found', conflict: 'Conflicting values', verify_band: 'Verify confidence', human_review: 'Human review required' }[reason] || 'Review required')))].join(' · ') || 'Review required'}`;
}
function documentName(observation, documents) {
  return documents.find(doc => doc.id === observation.source.document_ref)?.display_name || 'Document name unavailable';
}
function sourceHtml(observation, documents) {
  const source = observation.source;
  const expired = !source.cited_text || Date.parse(source.cited_text_expires_at) <= Date.now();
  return `<p class="fact-source">${esc(documentName(observation, documents))} · ${source.page_start === source.page_end ? 'Page' : 'Pages'} ${esc(source.page_start)}${source.page_start === source.page_end ? '' : `–${esc(source.page_end)}`}</p>
    ${expired ? '<p class="fact-excerpt-unavailable">Excerpt no longer available</p>' : `<blockquote>${esc(source.cited_text)}</blockquote>`}`;
}
function entryHtml(documents, factKey, prefix) {
  return `<div class="fact-entry">
    ${factKey ? '' : `<label>Term<select aria-label="Term" name="fact_key">${Object.entries(FACT_TERMS).map(([key, term]) => `<option value="${key}">${term.label}</option>`).join('')}</select></label>`}
    <label>Value<input name="value" inputmode="decimal" pattern="(?:0|[1-9][0-9]{0,29})(?:[.][0-9]{1,18})?" maxlength="49" required></label>
    <label>Unit<select aria-label="Unit" name="unit">${Object.keys(FACT_TERMS[factKey || 'base_rent_per_sf'].units).map(unit => `<option>${esc(unit)}</option>`).join('')}</select></label>
    <label data-expense-basis${factKey && factKey !== 'base_rent_per_sf' ? ' hidden' : ''}>Expense basis<select aria-label="Expense basis" name="expense_basis">${Object.entries(BASES).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
    <label class="fact-wide">Document<select aria-label="Document" name="document_ref" required>${documents.map(doc => `<option value="${esc(doc.id)}">${esc(doc.display_name)} · ${esc(doc.stored_at.slice(0, 10))}</option>`).join('')}</select></label>
    <label>First page<input name="page_start" type="number" min="1" max="100000" value="1" required></label>
    <label>Last page<input name="page_end" type="number" min="1" max="100000" value="1" required></label>
    <label class="fact-wide">Cited text<textarea name="cited_text" rows="2" maxlength="4000" required aria-describedby="${prefix}-source-hint"></textarea></label>
    <small id="${prefix}-source-hint" class="fact-wide">Transcribe the clause from the stored document. This entry does not verify the document text.</small></div>`;
}
function reviewHtml(item, documents, index, scheduleHtml) {
  const schedule = item.fact_key === 'rent_schedule';
  return `<article class="fact-term" data-fact-key="${esc(item.fact_key)}"><header><h3>${esc(FACT_TERMS[item.fact_key]?.label || (schedule ? 'Rent schedule' : item.fact_key.replaceAll('_', ' ')))}</h3><span class="fact-state">${esc(reviewLabel(item))}</span></header>
    <div class="fact-canonical"><small>Canonical value</small>${schedule && item.canonical_fact ? scheduleHtml(item.canonical_fact.normalized_schedule, false) : `<p${item.canonical_fact ? '' : ' class="fact-empty"'}>${item.canonical_fact ? esc(valueText(item.canonical_fact)) : 'No canonical value recorded'}</p>`}</div>
    <div class="fact-observations">${item.observations.map(o => `<section class="fact-observation">${schedule ? scheduleHtml(o.value, true) : `<strong>${esc(valueText(o))}</strong>`}${item.canonical_fact?.observation_ids?.includes(o.id) ? '<span class="fact-state"> · Settled value</span>' : ''}<p class="fact-read">${esc(readLabel(o))}</p>${sourceHtml(o, documents)}</section>`).join('')}</div>
    <button type="button" class="btn" data-review-term${item.pending ? ' hidden' : ''}>Review term</button>
    <form data-fact-review="${index}"${item.pending ? '' : ' hidden'}>
      <label>Decision<select aria-label="Decision" name="decision"><option value="approve"${item.observations.length ? '' : ' disabled'}>Approve a sourced value</option><option value="correct"${documents.length && !schedule ? '' : ' disabled'}>Correct with a source</option><option value="reject"${item.observations.length ? '' : ' selected'}>Reject this review</option></select></label>
      <label data-choose-value${item.observations.length ? '' : ' hidden'}>Choose a value<select aria-label="Choose a value" name="observation_id" required${item.observations.length ? '' : ' disabled'}><option value="">Choose a sourced value</option>${item.observations.map(o => `<option value="${esc(o.id)}">${esc(valueText(o))} · ${esc(documentName(o, documents))}${schedule ? ` · ${esc(o.method === 'ocr' ? 'OCR' : o.method === 'text_layer' ? 'Text' : o.method)} · Page ${esc(o.source.page_start)}${o.source.page_start === o.source.page_end ? '' : `–${esc(o.source.page_end)}`}` : ''}</option>`).join('')}</select></label>
      <fieldset data-correction hidden disabled><legend>Corrected term</legend>${schedule ? '' : entryHtml(documents, item.fact_key, `correction-${index}`)}</fieldset>
      <label>Reason<textarea name="reason" rows="2" maxlength="2000" required></textarea></label><button type="submit" class="btn btn-primary">Save review</button><p role="status" data-write-status></p>
    </form>
    ${item.review_history.length ? `<details class="fact-history"><summary>Review history</summary><ul>${item.review_history.map(row => `<li><strong>${esc({ approve: 'Approved', correct: 'Corrected', reject: 'Rejected' }[row.decision] || row.decision)}</strong><p>${esc(row.reason)}</p></li>`).join('')}</ul></details>` : ''}
  </article>`;
}

export function mountFactReview(root, { client, entityRef } = {}) {
  let disposed = false, generation = 0, items = [], writing = false, dirty = false;
  let documents = [];
  const pending = new Map();
  root.innerHTML = '<h2>Terms</h2><p role="status" data-terms-status>Loading terms…</p><div data-terms-list></div><div data-terms-record></div><button type="button" class="btn" data-refresh-terms>Refresh terms</button>';
  const status = root.querySelector('[data-terms-status]');
  const list = root.querySelector('[data-terms-list]');
  function setDocuments(result) {
    documents = result || [];
    const record = root.querySelector('[data-terms-record]');
    if (record.dataset.documents === JSON.stringify(documents)) return;
    record.dataset.documents = JSON.stringify(documents);
    record.innerHTML = documents.length ? `<details><summary>Record a term</summary><form data-fact-record>${entryHtml(documents, null, 'record-term')}<button class="btn" type="submit">Record term</button><p role="status" data-write-status></p></form></details>`
      : `<p>${result ? 'No stored documents for this deal.' : 'Stored documents unavailable. Recording and corrections are unavailable.'}</p>`;
  }
  setDocuments(null);
  const documentLoad = (async () => {
    try {
      const loaded = []; let cursor;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await client.listDealDocuments({ deal_id: entityRef, limit: 100, ...(cursor ? { cursor } : {}) });
        if (page.ok !== true || page.schema_version !== 'deal-documents.v1' || !Array.isArray(page.documents)
          || page.documents.some(doc => !doc.id || !doc.display_name || typeof doc.stored_at !== 'string')
          || typeof page.has_more !== 'boolean') throw new Error('Documents unavailable');
        loaded.push(...page.documents);
        if (!page.has_more) return loaded;
        if (!page.next_cursor || page.next_cursor === cursor) throw new Error('Documents unavailable');
        cursor = page.next_cursor;
      }
    } catch { /* The server may not yet provide document metadata. */ }
    return null;
  })();
  async function refresh(message = '') {
    if (disposed || writing || pending.size || dirty) return;
    const current = ++generation;
    status.textContent = 'Loading terms…';
    try {
      const loaded = []; let cursor;
      const listedDocuments = await documentLoad;
      if (disposed || current !== generation) return;
      setDocuments(listedDocuments);
      do {
        const page = await client.listFactReview({ entity_ref: entityRef, include_resolved: true, limit: 100, ...(cursor ? { cursor } : {}) });
        if (disposed || current !== generation) return;
        if (page.schema_version !== 'fact-review.v1' || !Array.isArray(page.items) || page.items.some(item => item.entity_ref !== entityRef)) throw new Error('Terms unavailable');
        loaded.push(...page.items);
        if (page.has_more && (!page.next_cursor || page.next_cursor === cursor)) throw new Error('Terms unavailable');
        cursor = page.has_more ? page.next_cursor : null;
      } while (cursor);
      const scheduleHtml = loaded.some(item => item.fact_key === 'rent_schedule') ? (await import('./rent-schedule.js')).scheduleHtml : null;
      if (disposed || current !== generation) return;
      items = loaded;
      list.innerHTML = items.map((item, index) => reviewHtml(item, documents, index, scheduleHtml)).join('') || '<p>No sourced terms recorded.</p>';
      status.textContent = message;
    } catch {
      if (!disposed && current === generation) {
        list.innerHTML = '';
        status.textContent = 'Terms unavailable. Refresh terms to try again.';
      }
    }
  }
  function markDirty() { dirty = true; }
  function change(event) {
    const form = event.target.closest('form');
    if (!form) return;
    if (event.target.name === 'decision') {
      const correcting = event.target.value === 'correct';
      form.querySelector('[data-correction]').hidden = !correcting;
      form.querySelector('[data-correction]').disabled = !correcting;
      form.querySelector('[data-choose-value]').hidden = event.target.value !== 'approve';
      form.elements.observation_id.disabled = event.target.value !== 'approve';
    }
    if (event.target.name === 'fact_key') {
      const key = event.target.value;
      const units = Object.keys(FACT_TERMS[key].units);
      if ([...form.elements.unit.options].map(option => option.value).join('|') !== units.join('|'))
        form.elements.unit.innerHTML = units.map(unit => `<option>${esc(unit)}</option>`).join('');
      form.querySelector('[data-expense-basis]').hidden = key !== 'base_rent_per_sf';
      form.elements.expense_basis.disabled = key !== 'base_rent_per_sf';
    }
  }
  function humanFact(form, factKey) {
    const data = new FormData(form);
    const key = factKey || data.get('fact_key');
    const source = { document_ref: data.get('document_ref'), page_start: Number(data.get('page_start')), page_end: Number(data.get('page_end')), cited_text: String(data.get('cited_text')).trim() };
    if (!documents.some(doc => doc.id === source.document_ref)) throw new Error('Choose a stored document of this deal.');
    if (source.page_end < source.page_start) throw new Error('Last page must follow the first page.');
    if (!source.cited_text) throw new Error('Enter the cited text.');
    return { fact_key: key, value: String(data.get('value')).trim(), unit: data.get('unit'),
      ...(key === 'base_rent_per_sf' ? { expense_basis: data.get('expense_basis') } : {}), source };
  }
  async function submit(event) {
    const form = event.target;
    if (!form.matches('[data-fact-review], [data-fact-record]')) return;
    event.preventDefault();
    if (writing) return;
    const output = form.querySelector('[data-write-status]');
    const button = form.querySelector('button[type="submit"]');
    let request = pending.get(form);
    try {
      if (!request) {
        if (!form.reportValidity()) return;
        const args = { idempotency_key: uuidv4(), entity_ref: entityRef };
        if (form.matches('[data-fact-record]')) request = { method: 'recordHumanFact', args: { ...args, observation: humanFact(form) } };
        else {
          const item = items[Number(form.dataset.factReview)], data = new FormData(form);
          const decision = data.get('decision'), reason = String(data.get('reason')).trim();
          if (!reason) throw new Error('Enter a reason for this review.');
          request = { method: 'resolveFactReview', args: { ...args, fact_key: item.fact_key, base_version: item.canonical_version, review_version: item.review_version,
            decision, reason, ...(decision === 'approve' ? { observation_id: data.get('observation_id') } : {}),
            ...(decision === 'correct' ? { correction: humanFact(form, item.fact_key) } : {}) } };
        }
        pending.set(form, request);
      }
      writing = true; generation++;
      for (const control of root.querySelectorAll('input, select, textarea, button')) control.disabled = true;
      output.textContent = 'Saving…';
      const result = await client[request.method](request.args);
      if (result.ok !== true || result.schema_version !== 'fact-review.v1') throw new Error('Receipt unavailable');
      pending.delete(form);
      dirty = false;
      if (form.matches('[data-fact-record]')) form.reset();
      writing = false;
      await refresh(request.method === 'recordHumanFact' ? 'Term recorded for review.' : 'Review saved.');
    } catch (error) {
      if (disposed) return;
      writing = false;
      if (error.payload?.error === 'version_conflict') {
        const factKey = items[Number(form.dataset.factReview)]?.fact_key;
        const reason = form.elements.reason?.value;
        pending.delete(form);
        dirty = false;
        await refresh('Terms changed since you opened this review. Refreshed terms; review them again.');
        const refreshed = [...list.querySelectorAll('[data-fact-key]')].find(term => term.dataset.factKey === factKey);
        if (refreshed && reason) {
          refreshed.querySelector('[name=reason]').value = reason;
          refreshed.querySelector('[data-fact-review]').hidden = false;
          refreshed.querySelector('[data-review-term]').hidden = true;
          dirty = true;
        }
      } else if (error.payload?.error && !['internal_error', 'offline', 'DEPENDENCY_UNAVAILABLE'].includes(error.payload.error) && !error.pendingRequest || (error.status === 401 || error.status === 403) && !error.pendingRequest) {
        pending.delete(form);
        output.textContent = error.status === 401 || error.status === 403 ? 'Sign in again before reviewing terms.' : 'Term not saved. Check the value, source and reason, then try again.';
      } else if (pending.has(form)) {
        if (error.pendingRequest) request.args = error.pendingRequest;
        output.textContent = 'Save not confirmed. Keep this tab open. Check outcome retries the same request.';
        button.textContent = 'Check outcome';
      } else output.textContent = error.message;
    } finally {
      writing = false;
      if (!disposed) {
        for (const control of root.querySelectorAll('input, select, textarea, button')) control.disabled = false;
        root.querySelector('[data-refresh-terms]').disabled = pending.size > 0;
        for (const form of root.querySelectorAll('[data-fact-review]')) change({ target: form.elements.decision });
        for (const form of root.querySelectorAll('form')) {
          if (form.elements.fact_key) change({ target: form.elements.fact_key });
          if (pending.has(form)) for (const control of form.querySelectorAll('input, select, textarea')) control.disabled = true;
        }
      }
    }
  }
  function click(event) {
    if (event.target.closest('[data-refresh-terms]')) { dirty = false; void refresh(); }
    const button = event.target.closest('[data-review-term]');
    if (button) { button.hidden = true; button.nextElementSibling.hidden = false; }
  }
  root.addEventListener('submit', submit);
  root.addEventListener('change', change);
  root.addEventListener('change', markDirty);
  root.addEventListener('input', markDirty);
  root.addEventListener('click', click);
  void refresh();
  return { refresh, dispose() {
    disposed = true; generation++;
    root.removeEventListener('submit', submit); root.removeEventListener('change', change); root.removeEventListener('click', click);
    root.removeEventListener('change', markDirty); root.removeEventListener('input', markDirty);
  } };
}
