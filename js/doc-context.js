import { createDocContext, docPage, DOC_PAGES } from './doc-context-model.js';

// One memory-only store per document. Server-side tests/imports have no ambient
// context and leave adapters untouched. It never persists business data.
export const pageDocContext = typeof document === 'undefined' ? null : createDocContext({ page: docPage(globalThis.location) });

export function observeDocClient(client, context = pageDocContext) {
  if (!context) return client;
  const reads = new Set(Object.values(DOC_PAGES).flatMap(page => page.reads));
  for (const method of reads) {
    if (typeof client[method] !== 'function') continue;
    const original = client[method];
    client[method] = async function (...args) {
      const ticket = context.begin(method, args);
      try { const payload = await original.apply(this, args); context.finish(ticket, payload); return payload; }
      catch (error) { context.fail(ticket, error); throw error; }
    };
  }
  return client;
}

export function publishDocRead(method, payload, args = []) {
  if (!pageDocContext) return;
  return pageDocContext.project(method,payload,args);
}
export function selectDocRecord(kind, id) { pageDocContext?.select(kind, id); }

export async function observeDocRead(method, args, read, context = pageDocContext) {
  const ticket = context?.begin(method, args);
  try { const result = await read(); context?.finish(ticket, result); return result; }
  catch (error) { context?.fail(ticket, error); throw error; }
}

export function setDocFilters(filters) {
  if (pageDocContext && JSON.stringify(pageDocContext.snapshot().filters) !== JSON.stringify({...pageDocContext.snapshot().filters,...filters})) pageDocContext.filter({...pageDocContext.snapshot().filters,...filters});
}
