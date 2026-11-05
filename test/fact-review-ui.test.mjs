import test from 'node:test';
import assert from 'node:assert/strict';
import { FACT_TERMS } from '../js/client.js';
import { JSDOM } from 'jsdom';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { readFile } from 'node:fs/promises';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const { mountFactReview } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
import { createFactReviewFixture } from '../data/fixtures/fact-review.mjs';

for (const expiry of ['invalid', undefined, null, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
  test(`excerpt visibility requires a finite future expiry (${expiry})`, async t => {
    const originalNow = Date.now;
    Date.now = () => Date.parse('2026-02-01T00:00:00Z');
    t.after(() => { Date.now = originalNow; });
    const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const root = dom.window.document.querySelector('#terms');
    const client = createFactReviewFixture({ canonicalHistory: true });
    const list = client.listFactReview.bind(client);
    client.listFactReview = async args => {
      const page = await list(args);
      for (const item of page.items) for (const observation of item.observations) {
        observation.source.cited_text = 'Synthetic clause';
        observation.source.cited_text_expires_at = expiry;
      }
      return page;
    };
    const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
    t.after(() => { panel.dispose(); dom.window.close(); });
    await panel.refresh();
    const visible = expiry === '2099-01-01T00:00:00Z';
    assert.equal(root.querySelectorAll('blockquote').length > 0, visible);
    assert.equal(root.querySelectorAll('.fact-observation .fact-excerpt-unavailable').length === 0, visible);
    assert.match(root.textContent, /Demo Amendment.pdf · Page 3/);
    const currentHistory = [...root.querySelectorAll('[data-canonical-history] li')].at(-1);
    assert.equal(currentHistory.textContent.includes('Excerpt no longer available'), !visible);
  });
}

test('terms show how values were read and retain the review reason after a conflict', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.FormData = dom.window.FormData;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  client.resolveFactReview = async () => { throw Object.assign(new Error('stale'), { payload: { error: 'version_conflict' } }); };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(root.textContent, /OCR · verify/);
  assert.match(root.textContent, /\$24\/SF\/yr/);
  const form = root.querySelector('[data-fact-review]');
  form.elements.decision.value = 'reject';
  form.elements.decision.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  form.elements.reason.value = 'Keep this reason';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(root.querySelector('[data-fact-review] [name=reason]').value, 'Keep this reason');
});

test('terms use the deal document list for citations and source choices', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.FormData = dom.window.FormData;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.textContent, /Demo Lease\.pdf/);
  assert.match(root.querySelector('[data-fact-record] select[name=document_ref]').textContent, /Demo Lease\.pdf.*2026/);
});

test('document refresh reloads paginated documents and unavailable documents leave review usable', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.FormData = dom.window.FormData;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const all = (await client.listDealDocuments({ deal_id: 'd14' })).documents;
  let calls = 0;
  client.listDealDocuments = async ({ cursor }) => {
    calls++;
    return { ok: true, schema_version: 'deal-documents.v1', documents: cursor ? all.slice(1) : all.slice(0, 1), has_more: !cursor, next_cursor: cursor ? null : 'next' };
  };
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.textContent, /Demo Amendment\.pdf/);
  all.push({ id: "new-document", display_name: "New Lease.pdf", stored_at: "2026-01-01" });
  await panel.refresh();
  assert.equal(calls, 4);
  assert.match(root.querySelector("[data-fact-record]").textContent, /New Lease\.pdf/);
  const input = root.querySelector('[data-fact-record] input[name=value]');
  input.value = '42';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  root.querySelector('[data-refresh-terms]').click();
  await panel.refresh();
  assert.equal(calls, 4);
  assert.equal(input.value, '42');
  panel.dispose();
  client.listDealDocuments = async () => { throw new Error('unavailable'); };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.textContent, /Stored documents unavailable/);
  assert.match(root.textContent, /Document name unavailable/);
  assert.equal(root.querySelector('[data-fact-record]'), null);
  assert.equal(root.querySelector('option[value=correct]').disabled, true);
});

test('rent schedules show period values, OCR provenance, and human review', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const list = client.listFactReview.bind(client);
  const field = (value, method = 'ocr') => ({ value, source: { page: 1, region_id: 'row-1', method } });
  client.listFactReview = async args => {
    const page = await list(args);
    page.items.push({ entity_ref: 'd14', fact_key: 'rent_schedule', canonical_version: 0, review_version: '0'.repeat(64), pending: true, priority: 'normal', reasons: ['human_review'], review_history: [], canonical_fact: null,
      observations: [{ id: 'schedule', method: 'ocr', confidence_tier: 'human_review', unit: 'schedule', source: { document_ref: '00000000-0000-4000-8000-000000000030', page_start: 1, page_end: 1, cited_text: 'Year 1 | $24 | NNN', cited_text_expires_at: '2099-01-01T00:00:00Z' }, value: [
        { start_month: field(1), end_month: field(12), rate: field('24'), unit: field('USD/SF/year'), expense_basis: field('nnn'), escalation_percent: field(null) },
        { start_month: field(13), end_month: field(24), rate: field('24.72'), unit: field('USD/SF/year'), expense_basis: field('nnn'), escalation_percent: field('3') },
      ] }] });
    return page;
  };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const schedule = root.querySelector('[data-fact-key="rent_schedule"]');
  assert.ok(schedule.querySelector('table'));
  assert.match(schedule.textContent, /1.*12/s);
  assert.match(schedule.textContent, /\$24\.72\/SF\/yr/);
  assert.match(schedule.textContent, /3%/);
  assert.match(schedule.textContent, /NNN/);
  assert.match(schedule.textContent, /OCR · verify/);
  assert.match(schedule.textContent, /Human review required/);
  assert.equal((schedule.textContent.match(/OCR · verify/g) || []).length, 1);
  assert.match(schedule.textContent, /Year 1 \| \$24 \| NNN/);
  assert.doesNotMatch(schedule.textContent, /auto.*promot/i);
  assert.equal(schedule.querySelector('option[value=correct]').disabled, true);
});


test('abstentions explain OCR failures without offering an unavailable value', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const list = client.listFactReview.bind(client);
  client.listFactReview = async args => {
    const page = await list(args);
    for (const [fact_key, reason] of [['rent_schedule', 'ocr_disagreement'], ['term_months', 'unsupported_ocr']]) {
      page.items = page.items.filter(item => item.fact_key !== fact_key);
      page.items.push({ entity_ref: 'd14', fact_key, canonical_version: 0, review_version: '0'.repeat(64), pending: true, priority: 'high', reasons: [reason], review_history: [], canonical_fact: null, observations: [], extraction_abstentions: [{ status: 'unreadable', reason }] });
    }
    return page;
  };
  mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const schedule = root.querySelector('[data-fact-key="rent_schedule"]');
  assert.match(schedule.textContent, /OCR disagreement/);
  assert.equal(schedule.querySelector('[name=decision]').value, 'reject');
  assert.match(root.querySelector('[data-fact-key="term_months"]').textContent, /OCR could not read this/);
});

test('a failed in-flight refresh preserves a review draft', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  let rejectRead, started;
  const reading = new Promise(resolve => { started = resolve; });
  client.listFactReview = () => new Promise((resolve, reject) => { rejectRead = reject; started(); });
  const refresh = panel.refresh();
  await reading;
  const reason = root.querySelector('[data-fact-review] [name=reason]');
  reason.value = 'Keep my draft';
  reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  rejectRead(new Error('offline'));
  await refresh;
  assert.equal(root.querySelector('[data-fact-review] [name=reason]').value, 'Keep my draft');
  assert.ok(root.querySelector('[data-fact-review] button[type=submit]'));
  assert.match(root.querySelector('[data-terms-status]').textContent, /unavailable/i);
  panel.dispose();
});

test('schedule choices identify the corresponding observations with distinct rates', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const list = client.listFactReview.bind(client);
  const field = value => ({ value });
  client.listFactReview = async args => {
    const page = await list(args);
    const observations = ['24', '26'].map((rate, i) => ({ id: `schedule-${i}`, method: 'ocr', confidence_tier: 'human_review', unit: 'schedule', source: { document_ref: '00000000-0000-4000-8000-000000000030', page_start: 1, page_end: 1, cited_text: 'Rent', cited_text_expires_at: '2099-01-01T00:00:00Z' }, value: [{ start_month: field(1), end_month: field(12), rate: field(rate), unit: field('USD/SF/year'), expense_basis: field('nnn'), escalation_percent: field(null) }] }));
    page.items.push({ entity_ref: 'd14', fact_key: 'rent_schedule', pending: true, reasons: ['conflict'], canonical_fact: null, observations, review_history: [], canonical_version: 0, review_version: '0'.repeat(64) });
    return page;
  };
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const schedule = root.querySelector('[data-fact-key=rent_schedule]');
  const options = [...schedule.querySelectorAll('[name=observation_id] option')].slice(1);
  const observations = [...schedule.querySelectorAll('.fact-observation')];
  assert.match(options[0].textContent, /Schedule schedule-0.*1–12.*\$24\.00\/SF\/yr/);
  assert.match(options[1].textContent, /Schedule schedule-1.*1–12.*\$26\.00\/SF\/yr/);
  assert.match(observations[0].textContent, /Schedule schedule-0/);
  assert.match(observations[1].textContent, /Schedule schedule-1/);
  panel.dispose();
});


test('canonical history shows three recorded versions without another read or changing the review draft', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture({ canonicalHistory: true });
  const read = client.listFactReview.bind(client);
  let reads = 0;
  client.listFactReview = args => { reads++; return read(args); };
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const history = root.querySelector('[data-canonical-history]');
  assert.ok(history, 'the term has an expandable canonical history');
  assert.equal(history.open, false);
  history.querySelector('summary').click();
  const rows = [...history.querySelectorAll('li')];
  assert.deepEqual(rows.map(row => row.querySelector('.fact-state').textContent), ['Version 1 · Superseded', 'Version 2 · Superseded', 'Version 3 · Current']);
  for (const [i, value] of ['24', '25', '26'].entries()) assert.ok(rows[i].textContent.includes(`$${value}/SF/yr`));
  assert.match(rows[0].textContent, /Historical citation unavailable/);
  assert.match(rows[0].textContent, /Independent agreement/);
  assert.match(rows[1].textContent, /Demo Counteroffer.pdf · Page 2/);
  assert.equal(rows[1].querySelector('time').dateTime, '2026-01-02T12:00:00Z');
  assert.match(rows[1].textContent, /Jan 2, 2026, 6:00 AM CST/);
  assert.match(rows[1].textContent, /Human review/);
  assert.match(rows[1].textContent, /Excerpt no longer available/);
  assert.match(rows[2].textContent, /Demo Amendment.pdf · Page 3/);
  const reason = root.querySelector('[name=reason]');
  reason.value = 'Keep this unsaved reason';
  reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await panel.refresh();
  assert.equal(root.querySelector('[name=reason]').value, 'Keep this unsaved reason');
  assert.equal(reads, 1);
  assert.equal((await read({ entity_ref: 'd14', include_resolved: true })).items[0].canonical_version, 3);
  panel.dispose();
  assert.equal(root.textContent, '');
});

test('session expiry clears canonical history and ignores a delayed refresh', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture({ canonicalHistory: true });
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const history = root.querySelector('[data-canonical-history]');
  history.querySelector('summary').focus();
  let finish;
  const reply = await client.listFactReview({ entity_ref: 'd14', include_resolved: true });
  client.listFactReview = () => new Promise(resolve => { finish = resolve; });
  const refreshing = panel.refresh();
  await new Promise(resolve => setTimeout(resolve, 10));
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  assert.doesNotMatch(root.textContent, /\$26|Demo Amendment/);
  assert.equal(root.querySelector('[data-canonical-history]'), null);
  assert.equal(dom.window.document.activeElement, root);
  finish(reply);
  await refreshing;
  assert.equal(root.querySelector('[data-canonical-history]'), null);
  panel.dispose();
});

for (const status of [401, 403]) test(`a ${status} history refresh clears old terms`, async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture({ canonicalHistory: true });
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  client.listFactReview = async () => { throw Object.assign(new Error('refused'), { status }); };
  await panel.refresh();
  assert.equal(root.querySelector('[data-canonical-history]'), null);
  assert.match(root.textContent, /Sign in again/);
  panel.dispose();
});

test('empty canonical history is explicit and an unavailable refresh retains the recorded snapshot', async () => {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = dom.window.document.querySelector('#terms');
  const client = createFactReviewFixture();
  const panel = mountFactReview(root, { terms: FACT_TERMS, client, entityRef: 'd14' });
  await new Promise(resolve => setTimeout(resolve, 30));
  root.querySelector('[data-canonical-history] summary').click();
  assert.match(root.textContent, /No canonical history recorded/);
  client.listFactReview = async () => { throw new Error('offline'); };
  await panel.refresh();
  assert.match(root.textContent, /Terms unavailable/);
  assert.match(root.textContent, /No canonical history recorded/);
  panel.dispose();
});
