import { createDocContext, docPage, DOC_PAGES } from './doc-context-model.js';

// One memory-only store per document. Server-side tests/imports have no ambient
// context and leave adapters untouched. It never persists business data.
export const pageDocContext = typeof document === 'undefined' ? null : createDocContext({ page: docPage(globalThis.location) });

const observed = new WeakMap();
function remember(payload) {
  if (!payload || typeof payload !== 'object') return;
  const at = Date.now(); observed.set(payload, at);
  for (const rows of Object.values(payload)) if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object') observed.set(row, at);
}

export function observeDocClient(client, context = pageDocContext) {
  if (!context) return client;
  const reads = new Set(Object.values(DOC_PAGES).flatMap(page => page.reads));
  for (const method of reads) {
    if (typeof client[method] !== 'function') continue;
    const original = client[method];
    client[method] = async function (...args) {
      const ticket = context.begin(method, args);
      try { const payload = await original.apply(this, args); remember(payload); context.finish(ticket, payload); return payload; }
      catch (error) { context.fail(ticket, error); throw error; }
    };
  }
  return client;
}

export function publishDocRead(method, payload, args = [], { observedAt } = {}) {
  if (!pageDocContext) return;
  const rows = payload?.deals || payload?.leads;
  const known = rows?.length ? rows.map(row => observed.get(row)).filter(Boolean) : [];
  const at = observedAt || observed.get(payload) || (known.length === rows?.length ? Math.min(...known) : Date.now());
  pageDocContext.finish(pageDocContext.begin(method, args), payload, { at: Number.isFinite(at) ? at : Date.now() });
}
export function selectDocRecord(kind, id) { pageDocContext?.select(kind, id); }

export async function observeDocRead(method, args, read, context = pageDocContext) {
  const ticket = context?.begin(method, args);
  try { const result = await read(); remember(result); context?.finish(ticket, result); return result; }
  catch (error) { context?.fail(ticket, error); throw error; }
}

export function setDocFilters(filters) {
  if (pageDocContext && JSON.stringify(pageDocContext.snapshot().filters) !== JSON.stringify(filters)) pageDocContext.filter(filters);
}
