// Scoped factual lookup evaluation, not an LLM score. The test verifies this
// allowlist against every synthetic page evaluation; unsupported pages stay off.
export const DOC_EVALUATED_PAGES = Object.freeze([
  'home', 'deals', 'leads', 'tours', 'clients', 'vendors', 'calendar', 'ideas', 'events',
  'control', 'progress', 'work', 'inventory', 'incidents', 'room', 'queue', 'updates',
  'chats', 'tasks', 'search', 'charts', 'status',
]);
