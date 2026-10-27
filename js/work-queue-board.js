// The system board: every queued job as a card in its derived stage column, read live from the
// record layer. One work-queue read per refresh, through the shared idle-aware refresh clock.
import { mountAutoRefresh } from './auto-refresh.mjs';
import { queueBoard, prLinks, QUEUE_STAGES, QUEUE_REFRESH_MS, QUEUE_IDLE_MS } from './work-queue-board-model.js';

export function mountQueueBoard({ container, client, document: doc, window: win, onJobs = () => {},
  intervalMs = QUEUE_REFRESH_MS, idleMs = QUEUE_IDLE_MS }) {
  const node = (tag, className, text, attributes = {}) => {
    const result = doc.createElement(tag);
    if (className) result.className = className;
    if (text != null) result.textContent = String(text);
    for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, String(value));
    return result;
  };
  const status = node('p', 'queue-board-status', 'Reading the work queue…', { role: 'status' });
  const notices = node('ul', 'queue-board-notices');
  const columns = node('div', 'queue-board-columns');
  container.classList.add('queue-board');
  container.replaceChildren(status, notices, columns);
  let signature = '';

  function card(job) {
    const article = node('article', 'board-card queue-job', null, { 'data-card-id': job.card_id, 'data-stage': job.stage,
      'data-stale': String(job.stale) });
    article.style.cssText = `--stage-accent:${QUEUE_STAGES.find(stage => stage.id === job.stage).color}`;
    const top = node('div', 'card-top');
    top.append(node('strong', 'card-id', job.card_id), node('span', 'card-title', job.card_title || ''));
    if (job.stale) top.append(node('span', 'flag-stale', 'stale', { title: 'No dispatch pickup or push for a day or more' }));
    article.append(top);
    if (job.description) article.append(node('p', 'card-summary', job.description, { title: job.description }));
    article.append(node('p', 'card-model', [job.executor, job.model, job.effort].filter(Boolean).join(' · ')));
    const links = prLinks(job);
    const prs = node('p', 'card-meta');
    if (!links.length) prs.append(node('span', 'card-pr', 'No PR'));
    for (const link of links) {
      const anchor = node('a', 'card-pr', `${link.label} · ${link.state}`, { href: link.href, target: '_blank', rel: 'noopener noreferrer' });
      prs.append(anchor);
    }
    article.append(prs);
    return article;
  }

  function draw(board) {
    const next = JSON.stringify(board.jobs) + board.notices.join();
    if (next === signature) return;
    signature = next;
    const focused = columns.contains(doc.activeElement) ? doc.activeElement.getAttribute('href') : null;
    notices.replaceChildren(...board.notices.map(text => node('li', '', text)));
    columns.replaceChildren(...board.stages.map(stage => {
      const column = node('section', 'column', null, { 'data-stage': stage.id, 'aria-label': `${stage.label}: ${stage.count}` });
      column.style.cssText = `--stage-accent:${stage.color}`;
      const head = node('div', 'column-head');
      head.append(node('h3', 'stage-label', stage.label), node('span', 'stage-count', stage.count));
      const body = node('div', 'column-body');
      if (!stage.count) body.append(node('p', 'empty', stage.meaning));
      for (const group of stage.groups) {
        body.append(node('h4', 'queue-group', group.title ? `${group.work_request} · ${group.title}` : group.work_request,
          { 'data-work-request': group.work_request }));
        for (const job of group.jobs) body.append(card(job));
      }
      column.append(head, body);
      return column;
    }));
    if (focused) [...columns.querySelectorAll('a[href]')].find(anchor => anchor.getAttribute('href') === focused)?.focus();
  }

  async function refresh({ signal } = {}) {
    let board;
    try { board = queueBoard(await client.workQueue({}, { signal })); }
    catch (cause) {
      if (signal?.aborted) throw cause;
      status.textContent = cause?.status === 401 ? 'Sign in to see the work queue.'
        : cause?.status === 403 ? 'You do not have access to the work queue.' : 'The work queue could not be read. Retrying.';
      onJobs([], { state: cause?.status === 401 ? 'signed-out' : 'unknown' });
      throw cause;
    }
    draw(board);
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date());
    status.textContent = `${board.jobs.length} ${board.jobs.length === 1 ? 'job' : 'jobs'} · ${board.stale} stale`
      + ` (no progress for ${board.staleAfterHours} hours while queued or building) · read ${time}`;
    onJobs(board.jobs, { state: 'read' });
  }

  const auto = mountAutoRefresh({ document: doc, window: win, refresh, intervalMs, idleMs });
  auto.refresh().catch(() => {});
  return { refresh: () => auto.refresh(), dispose() { auto.dispose(); container.classList.remove('queue-board'); } };
}
