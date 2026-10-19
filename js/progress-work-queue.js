import { boardPageUrl } from './progress-board-route.js';

const duration = seconds => seconds == null ? 'Not recorded' : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
const recorded = value => value === '' || value == null ? 'Not recorded' : String(value);

export function queueError(queue) {
  if (queue == null) return null;
  const board = queue.board;
  if (queue.schema !== 'room-work-queue/v1' || board?.schema !== 'room-work-queue-board/v1'
      || !Array.isArray(board.order) || !board.nodes || !Array.isArray(queue.items))
    return 'The published work queue is incomplete.';
  const seen = new Set();
  const visit = (id, parent) => {
    const node = Object.hasOwn(board.nodes, id) ? board.nodes[id] : null;
    if (!node || node.id !== id || seen.has(id) || node.parent_id !== parent) return false;
    seen.add(id);
    return node.kind === 'job' || (Array.isArray(node.children) && node.children.every(child => visit(child, id)));
  };
  return board.order.every(id => visit(id, null)) ? null : 'The published work queue order is invalid.';
}

export function mountWorkQueue({ container, window: win, boardId }) {
  const doc = container.ownerDocument;
  const records = new Map();
  const root = doc.createElement('div');
  root.className = 'queue-root';
  root.dataset.queueRoot = '';
  const note = doc.createElement('p');
  note.className = 'queue-status';
  const empty = doc.createElement('p');
  empty.textContent = 'No work is queued.';
  container.replaceChildren(note, root, empty);
  container.classList.add('queue-board');
  let queue;
  let lastRevision;
  let lastAddress;
  const node = (tag, text, className) => {
    const result = doc.createElement(tag);
    if (text != null) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const address = () => new URL(win.location.href).searchParams.get('card');
  const url = id => `${boardPageUrl(boardId)}?card=${encodeURIComponent(id)}`;
  function row(list, label, value) {
    list.append(node('dt', label), node('dd', recorded(value)));
  }
  function logLink(parent, href, text, key) {
    const link = node('a', text);
    link.href = href;
    link.dataset[key] = '';
    parent.append(link);
  }
  function detail(record, card) {
    const signature = JSON.stringify(card);
    if (record.signature === signature) return;
    record.signature = signature;
    const focused = record.body.contains(doc.activeElement) ? doc.activeElement.dataset : null;
    record.body.replaceChildren();
    const list = node('dl', null, 'queue-facts');
    row(list, 'Card ID', card.id);
    if (card.kind !== 'job') {
      for (const [label, value] of [['Jobs', card.totals.jobs], ['Pull requests', card.totals.prs],
        ['Total time', duration(card.totals.total_time_s)], ['Review rounds', card.totals.review_rounds],
        ['Findings opened', card.totals.findings_opened], ['Findings resolved', card.totals.findings_resolved]]) row(list, label, value);
      row(list, 'Stages', Object.entries(card.totals.stages).map(([stage, count]) => `${count} ${stage}`).join(' · '));
      const totals = node('details', null, 'queue-rollup');
      totals.append(node('summary', 'Rolled-up totals'), list);
      record.body.append(totals);
      return;
    }
    for (const [label, value] of [['Desk', card.desk], ['Agent', card.agent], ['Model used', card.model],
      ['Effort', card.effort], ['Stage', card.stage], ['Total time', card.timing_unknown ? null : duration(card.total_time_s)],
      ['Review round', `${card.review_round} of 3`], ['Findings opened', card.findings_opened],
      ['Findings resolved', card.findings_resolved], ['CI', card.ci_state],
      ['Merge-stage position', card.merge_position ?? 'Outside merge stage']]) row(list, label, value);
    record.body.append(node('p', card.description, 'queue-description'), list);
    const times = node('dl', null, 'queue-facts');
    for (const stage of card.stages) row(times, `${stage.stage}${stage.finished_at ? '' : ' · current'}`, stage.started_at ? duration(stage.elapsed) : 'Not started');
    record.body.append(node('h4', 'Time per stage'), times, node('h4', 'Review findings'));
    const findings = node('ul', null, 'queue-findings');
    for (const finding of card.findings) findings.append(node('li', `${finding.level} · ${finding.summary} · ${finding.resolved ? 'Resolved' : 'Open'}`));
    if (!card.findings.length) findings.append(node('li', 'No findings recorded.'));
    record.body.append(findings, node('h4', 'Recent priority changes'));
    for (const event of card.priority_changes) record.body.append(node('p', `${event.at} · ${event.actor} · ${event.reason} · ${event.from.position} to ${event.to.position}`));
    if (!card.priority_changes.length) record.body.append(node('p', 'No priority changes recorded.'));
    const last = card.last_event;
    record.body.append(node('p', last ? `Last event · ${last.at} · ${last.kind} · ${last.reason}` : 'Last event · Not recorded'));
    const links = node('nav', null, 'queue-links');
    links.setAttribute('aria-label', 'Job links');
    for (const pr of card.prs) {
      if (/^[\w.-]+\/[\w.-]+$/.test(pr.repo) && Number.isSafeInteger(pr.number) && pr.number > 0)
        logLink(links, `https://github.com/${pr.repo}/pull/${pr.number}`, `${pr.repo.split('/')[1]} #${pr.number}`, 'pr');
    }
    logLink(links, url(card.id), 'Link to card', 'cardLink');
    const logId = `queue-log-${card.id}`;
    logLink(links, `${url(card.id)}#${encodeURIComponent(logId)}`, 'Job log', 'jobLog');
    record.body.append(links);
    const log = node('details', null, 'queue-log');
    log.id = logId;
    log.append(node('summary', 'Job event log'));
    const events = queue.history.filter(event => event.card_id === card.id);
    const eventList = node('ol');
    for (const event of events) eventList.append(node('li', `${event.at} · ${event.kind} · ${event.actor} · ${event.reason}`));
    log.append(node('p', 'Audited queue events. Raw executor prompts and transcripts stay local.'), eventList);
    record.body.append(log);
    links.querySelector('[data-job-log]').addEventListener('click', event => {
      event.preventDefault(); log.open = true; win.history.replaceState({}, '', `${url(card.id)}#${encodeURIComponent(logId)}`);
      log.querySelector('summary').focus({ preventScroll: true });
    });
    if (win.location.hash === `#${encodeURIComponent(logId)}`) log.open = true;
    if (focused) {
      const key = ['pr', 'cardLink', 'jobLog'].find(key => key in focused);
      if (key) record.body.querySelector(`[data-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}]`)?.focus({ preventScroll: true });
    }
  }
  function ensure(card) {
    let record = records.get(card.id);
    if (!record) {
      const element = node('details', null, `queue-card queue-${card.kind}`);
      element.dataset.queueId = card.id;
      element.dataset.queueDetail = card.id;
      const summary = node('summary');
      const title = node('span', '', 'queue-title');
      const state = node('span', '', 'queue-state');
      summary.append(title, state);
      const body = node('div', null, 'queue-detail-body');
      const children = node('div', null, 'queue-children');
      element.append(summary, body, children);
      record = { element, title, state, body, children, signature: '' };
      records.set(card.id, record);
      element.open = card.kind === 'request';
      summary.addEventListener('click', event => {
        event.preventDefault(); element.open = !element.open;
        if (element.open) win.history.pushState({}, '', url(card.id));
      });
    }
    record.title.textContent = card.title || card.id;
    record.state.textContent = card.kind === 'job' ? `${card.stage} · ${duration(card.total_time_s)}`
      : `${card.totals.jobs} jobs · ${card.totals.prs} PRs · ${duration(card.totals.total_time_s)} · ${card.totals.findings_opened - card.totals.findings_resolved} open findings`;
    detail(record, card);
    return record;
  }
  function reveal() {
    let id = address();
    while (id && records.has(id)) {
      records.get(id).element.open = true;
      id = queue.board.nodes[id].parent_id;
    }
  }
  const pop = () => reveal();
  win.addEventListener('popstate', pop);
  return { update(value) {
    queue = value;
    const active = doc.activeElement;
    const left = win.scrollX, top = win.scrollY;
    const positions = new Map([...records].map(([id, r]) => [id, r.element.getBoundingClientRect()]));
    const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const seen = new Set();
    function place(ids, parent) {
      ids.forEach((id, index) => {
        const card = queue.board.nodes[id];
        seen.add(id);
        const record = ensure(card);
        if (parent.children[index] !== record.element) {
          if (parent.moveBefore && record.element.isConnected) parent.moveBefore(record.element, parent.children[index] || null);
          else parent.insertBefore(record.element, parent.children[index] || null);
        }
        if (card.kind !== 'job') place(card.children, record.children);
      });
    }
    place(queue.board.order, root);
    for (const [id, record] of records) if (!seen.has(id)) { record.element.remove(); records.delete(id); }
    if (address() !== lastAddress) { reveal(); lastAddress = address(); }
    if (active?.isConnected && doc.activeElement !== active) active.focus({ preventScroll: true });
    if (win.scrollX !== left || win.scrollY !== top) win.scrollTo(left, top);
    if (!reduced && lastRevision !== undefined && lastRevision !== queue.revision) {
      for (const [id, before] of positions) {
        const element = records.get(id)?.element;
        if (!element || !before.height) continue;
        const after = element.getBoundingClientRect();
        const dy = before.top - after.top;
        if (dy && after.height) element.animate?.([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 240, easing: 'ease-out' });
      }
    }
    if (reduced) for (const animation of root.getAnimations?.({ subtree: true }) || []) animation.cancel();
    lastRevision = queue.revision;
    empty.hidden = queue.board.order.length > 0;
    note.textContent = `Queue revision ${queue.revision} · Priority order comes from the orchestrator's work queue.`;
    if (queue.omitted?.finished || queue.omitted?.events)
      note.textContent += ` ${queue.omitted.finished} finished jobs and ${queue.omitted.events} older events omitted.`;
  }, dispose() { win.removeEventListener('popstate', pop); } };
}
