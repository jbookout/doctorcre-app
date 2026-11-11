import { createMcpRequests } from './mcp-requests.mjs';

export function createClientPortalClient(options = {}) {
  const request = createMcpRequests(options);
  return {
    async read({ slug, password }, { signal } = {}) {
      const result = await request('read-client-portal', { slug, password }, { signal, timeoutMs: options.timeoutMs || 10_000 });
      if (result.kind !== 'payload' || result.isError || result.payload?.ok !== true)
        throw new Error('Portal unavailable. Check the portal name and password, then try again.');
      return portalFrom(result.payload, slug);
    },
  };
}

function portalFrom(payload, slug) {
  const portal = payload?.portal;
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const materials = portal?.materials;
  const publications = portal?.publications === undefined ? [] : portal.publications;
  const publication = row => text(row?.title) && (row?.kind === 'deliverable' ? text(row.deliverable?.id) && text(row.deliverable?.filename) && text(row.deliverable?.mime) && Number.isSafeInteger(row.deliverable?.bytes) && row.deliverable.bytes >= 0 : ['milestone','document','tour','report'].includes(row?.kind) && text(row.content));
  if (payload.schema_version !== 'client-portal.v1' || portal?.slug !== slug ||
      (!Array.isArray(publications) || publications.length > 100 || !publications.every(publication)) ||
      !Array.isArray(materials) || materials.length > 100 || !materials.every(material =>
        ['document', 'tour', 'report'].includes(material?.kind) && text(material?.title) && text(material?.content)))
    throw new Error('Portal unavailable. Check the portal name and password, then try again.');
  return {
    slug: portal.slug,
    roadmap: { current_phase: null, phases: [] },
    publications: publications.map(row => row.kind === 'deliverable' ? {kind:row.kind,title:row.title,deliverable:{id:row.deliverable.id,filename:row.deliverable.filename,mime:row.deliverable.mime,bytes:row.deliverable.bytes}} : {kind:row.kind,title:row.title,content:row.content}),
    materials: materials.map(({ kind, title, content }) => ({ kind, title, content })),
  };
}
