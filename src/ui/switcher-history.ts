const RECENTS = 'doctorcre.quick-switcher.recents.v1';

export function recentIds(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(RECENTS) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 8) : [];
  } catch { return []; }
}
export function rememberDestination(id: string) {
  try { sessionStorage.setItem(RECENTS, JSON.stringify([id, ...recentIds().filter(previous => previous !== id)].slice(0, 8))); } catch { /* Optional browsing convenience. */ }
}
export function clearRecents() {
  try { sessionStorage.removeItem(RECENTS); } catch {}
}
export function rememberAddress(address: string) {
  const url = new URL(address);
  const deal = url.searchParams.get('deal');
  const node = url.searchParams.get('node');
  if (url.pathname === '/deals' && deal) rememberDestination(`deal:${deal}`);
  else if (url.pathname === '/relationships' && node) rememberDestination(node);
  else rememberDestination(`page:${url.pathname}${url.pathname === '/ideas-events' ? `?tab=${url.searchParams.get('tab') === 'events' ? 'events' : 'ideas'}` : ''}`);
}
