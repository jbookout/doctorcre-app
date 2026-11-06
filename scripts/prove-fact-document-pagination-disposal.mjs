import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function observePagination({ mountFactReview, document }) {
  const assertions = [];
  const check = (condition, name) => { if (!condition) throw Error(name); assertions.push(name); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const terms = { base_rent_per_sf: { label: 'Base rent', units: { 'USD/SF/year': 1 } } };
  const page = (cursor = null) => {
    const result = { ok: true, schema_version: 'deal-documents.v1', documents: [{ id: '00000000-0000-4000-8000-000000000030', display_name: 'Synthetic Lease.pdf', document_type: 'application/pdf', page_count: null, content_hash: 'a'.repeat(64), stored_at: '2026-01-01T00:00:00Z' }], has_more: cursor !== null, next_cursor: cursor };
    if (result.schema_version !== 'deal-documents.v1' || result.documents.some(doc => !/^[0-9a-f-]{36}$/.test(doc.id) || typeof doc.display_name !== 'string' || !Number.isFinite(Date.parse(doc.stored_at)) || !/^[a-f0-9]{64}$/.test(doc.content_hash))) throw Error('Document fixture violates pinned fact_review.json contract');
    return result;
  };
  let writes = 0;
  for (const stop of ['disposed', 'expired', 'stale']) {
    for (const later of [false, true]) {
      for (const reject of [false, true]) {
        const root = document.body.appendChild(document.createElement('div'));
        const waiting = [];
        let documentCalls = 0, factCalls = 0;
        const client = {
          listDealDocuments: () => {
            documentCalls++;
            if (later && documentCalls === 1) return Promise.resolve(page('second'));
            return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
          },
          listFactReview: async () => { factCalls++; return { ok: true, schema_version: 'fact-review.v1', items: [], has_more: false, next_cursor: null }; },
          prepareTermsComparison: async () => { writes++; throw Error('Write refused'); },
          recordHumanFact: async () => { writes++; throw Error('Write refused'); },
          resolveFactReview: async () => { writes++; throw Error('Write refused'); },
        };
        const panel = mountFactReview(root, { client, entityRef: 'synthetic', terms });
        try {
          await tick();
          check(waiting.length === 1, 'deferred-page-started');
          let fresh;
          if (stop === 'disposed') panel.dispose();
          if (stop === 'expired') document.defaultView.dispatchEvent(new document.defaultView.Event('doctorcre-session-invalidated'));
          if (stop === 'stale') {
            fresh = panel.refresh();
            await tick();
          }
          const before = root.innerHTML, calls = documentCalls;
          if (reject) waiting[0].reject(Error('Late rejection'));
          else waiting[0].resolve(page('obsolete-next'));
          await tick();
          check(documentCalls === calls, `${stop}-${later ? 'later' : 'first'}${reject ? '-rejection' : ''}`);
          check(factCalls === 0 && root.innerHTML === before, 'obsolete-read-cannot-publish');
          if (fresh) { waiting[1].resolve(page()); await fresh; check(factCalls === 1, 'newest-refresh-completes'); }
        } finally { panel.dispose(); root.remove(); }
      }
    }
  }
  for (const mode of ['healthy', 'repeated', 'capacity', 'unavailable', 'invalid']) {
    const root = document.body.appendChild(document.createElement('div'));
    let documentCalls = 0, factCalls = 0;
    const client = {
      listDealDocuments: async () => {
        documentCalls++;
        if (mode === 'unavailable') throw Error('Offline');
        if (mode === 'invalid') return { ...page(), schema_version: 'wrong' };
        return page(mode === 'capacity' ? `page-${documentCalls}` : mode === 'repeated' || documentCalls === 1 ? 'second' : null);
      },
      listFactReview: async () => { factCalls++; return { ok: true, schema_version: 'fact-review.v1', items: [], has_more: false, next_cursor: null }; },
    };
    const panel = mountFactReview(root, { client, entityRef: 'synthetic', terms });
    try {
      await tick();
      check(documentCalls === (mode === 'capacity' ? 100 : ['healthy', 'repeated'].includes(mode) ? 2 : 1), `${mode}-bounded-reads`);
      check(factCalls === 1 && root.textContent.includes('No sourced terms recorded.'), `${mode}-fact-review-usable`);
      check(mode === 'healthy' ? !!root.querySelector('[data-fact-record]') : root.textContent.includes('Stored documents unavailable'), `${mode}-document-availability`);
      if (mode === 'healthy') { await panel.refresh(); check(factCalls === 2, 'reviewing-refresh'); }
    } finally { panel.dispose(); root.remove(); }
  }
  check(writes === 0, 'no-writes');
  return { assertions, synthetic_write_calls: writes };
}
