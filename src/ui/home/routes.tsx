import type { InboxItem } from './inbox';
// Stable record-level URL contract. IDs are encoded path segments, never credentials.
export const recordRoutePatterns = { home: '/home', card: '/home/card/:item_id', deal: '/deals/:id', contact: '/contacts/:id', task: '/tasks/:id' } as const;
export const recordRoutes = {
  home: () => '/home',
  card: (id: string) => `/home/card/${encodeURIComponent(id)}`,
  deal: (id: string) => `/deals/${encodeURIComponent(id)}`,
  contact: (id: string) => `/contacts/${encodeURIComponent(id)}`,
  task: (id: string) => `/tasks/${encodeURIComponent(id)}`,
  source(item: InboxItem) {
    if (item.source_type === 'task') return this.task(item.source_id);
    if (item.source_type === 'deal') return this.deal(item.source_id);
    if (item.source_type === 'contact') return this.contact(item.source_id);
    return this.card(item.item_id);
  },
};
