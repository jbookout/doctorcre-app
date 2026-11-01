import type { InboxItem } from './inbox';
// Stable inbox URL contract. IDs are encoded path segments, never credentials.
export const recordRoutes = {
  inbox: () => '/inbox',
  card: (id: string) => `/inbox/card/${encodeURIComponent(id)}`,
  /** The page that owns an inbox card's source record, or null when no page
   * opens it. Source types are the ones read-home-inbox emits; a card never
   * links back to itself. A next_action has no page that opens it by id (the
   * task board keys loops, and the card carries no deal), so it has no link. */
  source(item: InboxItem): string | null {
    switch (item.source_type) {
      case 'capture_session': case 'capture_post_call_action': return '/calls';
      case 'notification': return '/updates';
      default: return null;
    }
  },
};
