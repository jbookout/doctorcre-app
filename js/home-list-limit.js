export function homeListLimit(win, unlimited = false) {
  let count = unlimited ? Infinity : win?.matchMedia?.('(max-width: 700px)').matches ? 1 : 2;
  return {
    visible: rows => rows.slice(0, count),
    count: rows => Math.min(count, rows.length),
    remaining: rows => Math.max(0, rows.length - count),
    showAll: rows => { count = rows.length; },
  };
}
