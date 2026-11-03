import type { InboxItem } from './inbox';
export const recordRoutes = {
  card: (id: string) => `/inbox/card/${encodeURIComponent(id)}`,
  source(item: InboxItem): string | null {
    const url = item.open_url;
    if (!url || !url.startsWith('/') || url.startsWith('//') || /[\\\s\x00-\x1f\x7f]/.test(url)) return null;
    const parsed = new URL(url, 'https://doctorcre.invalid');
    const supported = ['/deals', '/calls', '/updates', '/doc-chats'].includes(parsed.pathname);
    return parsed.origin === 'https://doctorcre.invalid' && supported ? url : null;
  },
};
