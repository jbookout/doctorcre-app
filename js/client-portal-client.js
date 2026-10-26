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
  const portal = payload?.portal, roadmap = portal?.roadmap;
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const phases = roadmap?.phases, materials = portal?.materials;
  if (payload.schema_version !== 'client-portal.v1' || portal?.slug !== slug ||
      !Array.isArray(phases) || !phases.length || !phases.every(phase => text(phase?.slug) && text(phase?.label)) ||
      new Set(phases.map(phase => phase.slug)).size !== phases.length ||
      !phases.some(phase => phase.slug === roadmap.current_phase) ||
      !Array.isArray(materials) || materials.length > 100 || !materials.every(material =>
        ['document', 'tour', 'report'].includes(material?.kind) && text(material?.title) && text(material?.content)))
    throw new Error('Portal unavailable. Check the portal name and password, then try again.');
  return {
    slug: portal.slug,
    roadmap: { current_phase: roadmap.current_phase, phases: phases.map(({ slug, label }) => ({ slug, label })) },
    materials: materials.map(({ kind, title, content }) => ({ kind, title, content })),
  };
}
