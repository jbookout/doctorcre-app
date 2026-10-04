export const BOARD_ROUTE = '/control-room/progress/board/:boardId';
const PREFIX = '/control-room/progress/board/';
export const boardPageUrl = id => PREFIX + encodeURIComponent(id);
export function boardIdFromPath(pathname) {
  const segment = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : '';
  if (!segment || segment.includes('/')) return null;
  try { return decodeURIComponent(segment); } catch { return null; }
}
export function legacyBoardDestination(url) {
  if (!['/control-room/progress', '/progress-board', '/progress-board.html'].includes(url.pathname)) return null;
  const board = url.searchParams.get('board');
  if (!board) return null;
  const destination = new URL(boardPageUrl(board), url);
  destination.search = url.search;
  destination.searchParams.delete('board');
  destination.hash = url.hash;
  return destination;
}
