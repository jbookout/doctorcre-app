import type { InboxItem } from './inbox';
// Stable record-level URL contract. IDs are encoded path segments, never credentials.
export const recordRoutePatterns = { home: '/home', card: '/home/card/:item_id', deal: '/deals/:id', contact: '/contacts/:id', task: '/tasks/:id' } as const;
export const recordRoutes = {
  home: () => '/home',
  card: (id: string) => `/home/card/${encodeURIComponent(id)}`,
  deal: (id: string) => `/deals/${encodeURIComponent(id)}`,
  contact: (id: string) => `/contacts/${encodeURIComponent(id)}`,
  task: (id: string) => `/tasks/${encodeURIComponent(id)}`,
  /** The page that owns an inbox card's source record, or null when no page
   * does. Source types are the ones read-home-inbox emits; a card never links
   * back to itself. */
  source(item: InboxItem): string | null {
    switch (item.source_type) {
      case 'next_action': return this.task(item.source_id);
      case 'capture_session': case 'capture_post_call_action': return '/calls';
      case 'notification': return '/updates';
      default: return null;
    }
  },
};
