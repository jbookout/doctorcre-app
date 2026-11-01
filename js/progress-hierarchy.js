import { STAGES } from './progress-board-model.js';
import { boardPageUrl } from './progress-board-route.js';
import { sectionForTab } from './control-room-queue-model.js';

export function hierarchyUrl(boardId, cardId = '') {
  return boardPageUrl(boardId) + (cardId ? `?card=${encodeURIComponent(cardId)}` : '');
}

export function hierarchyView(data, address = '') {
  const tree = data.hierarchy;
  const cards = data.tasks || {};
  const seen = new Set();
  // eslint-disable-next-line no-restricted-syntax -- Task aliases stop on a seen address or at the end of the finite alias chain; zero reads.
  while (!Object.hasOwn(cards, address) && tree.aliases?.[address] && !seen.has(address)) {
    seen.add(address);
    address = tree.aliases[address];
  }
  const selected = Object.hasOwn(cards, address) ? cards[address] : null;
  const sliceKey = selected?.parent_id || address;
  const slice = Object.hasOwn(tree.slices, sliceKey) ? tree.slices[sliceKey] : null;
  const requestKey = slice?.parent_id || address;
  const request = Object.hasOwn(tree.work_requests, requestKey) ? tree.work_requests[requestKey] : null;
  if (address && !selected && !slice && !request) return { error: 'Card not found.', active: [], completed: [], history: [], crumbs: [] };
  const values = slice ? slice.cards.map(id => cards[id]).filter(Boolean)
    : request ? request.slices.map(id => tree.slices[id]).filter(Boolean) : Object.values(tree.work_requests);
  const archived = card => card.archived || card.status === 'archived';
  const done = card => !archived(card) && (slice ? card.done === true : card.status === 'done');
  return { level: slice ? 'prs' : request ? 'slices' : 'requests', selected,
    active: values.filter(card => !done(card) && !archived(card)), completed: values.filter(done), history: values.filter(archived),
    parent: slice ? request.id : '',
    crumbs: [{ id: '', label: 'Work Requests' }, ...(request ? [{ id: request.id, label: request.card_title }] : []),
      ...(slice ? [{ id: slice.id, label: slice.card_title }] : [])] };
}

export function mountHierarchy({ container, window: win, onOpen, onClose }) {
  const doc = container.ownerDocument;
  let data;
  let firstRead = true;
  let lastSignature = '';
  let address = new URL(win.location.href).searchParams.get('card') || '';
  const inBoards = () => win.location.pathname !== '/control-room' ||
    sectionForTab(new URLSearchParams(win.location.search).get('tab')) === 'boards';
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function selectionUrl(id) {
    const url = new URL(win.location.href);
    if (id) url.searchParams.set('card', id);
    else url.searchParams.delete('card');
    return url.href;
  }
  function navigate(id) {
    address = id;
    win.history.pushState({}, '', selectionUrl(id));
    render();
    openSelected();
    if (!hierarchyView(data, address).selected) focusDestination();
  }
  function focusDestination(origin = '') {
    const trigger = [...container.querySelectorAll('[data-hierarchy-id]')]
      .find(card => card.dataset.hierarchyId === origin)?.querySelector('button');
    // eslint-disable-next-line no-restricted-syntax -- Opens one details ancestor per iteration until the finite DOM ancestor chain ends; zero reads.
    for (let details = trigger?.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
    (trigger || doc.getElementById('pipeline-title'))?.focus();
  }
  function openSelected() {
    if (!inBoards()) { onClose?.(); return; }
    const selected = hierarchyView(data, address).selected;
    if (selected) {
      focusDestination(selected.id);
      onOpen({ ...selected, title: selected.card_title, summary: selected.card_description });
    }
    else onClose?.();
  }
  function cardNode(card) {
    const article = node('article', '', 'hierarchy-card');
    article.dataset.hierarchyId = card.id;
    const button = node('button', card.card_title, 'hierarchy-card-title');
    button.type = 'button';
    button.addEventListener('click', () => navigate(card.id));
    article.addEventListener('click', event => { if (event.target === article) navigate(card.id); });
    article.append(button, node('p', card.card_description, 'hierarchy-description'));
    if (card.status === 'blocked' || card.health === 'blocked' || card.status === 'question-for-orchestrator') {
      article.dataset.blocked = 'true';
      article.append(node('p', 'Blocked', 'hierarchy-status'));
      article.append(node('p', `Next action: ${card.next_action || card.blocked_reason || 'Open details to review what is needed.'}`, 'hierarchy-next-action'));
    }
    const counts = card.counts || card.pr_counts;
    if (counts) article.append(node('p', Object.entries(counts).map(([stage, count]) => `${count} ${stage}`).join(' · '), 'hierarchy-counts'));
    if (card.job_counts && Object.keys(card.job_counts).length)
      article.append(node('p', Object.entries(card.job_counts).map(([stage, count]) => `${count} jobs ${stage}`).join(' · '), 'hierarchy-counts'));
    if (card.updated_at) {
      const time = node('time', `Latest activity ${new Date(card.updated_at).toLocaleString()}`, 'hierarchy-activity');
      time.dateTime = card.updated_at;
      article.append(time);
    }
    const details = node('details', '', 'hierarchy-details');
    details.append(node('summary', 'Details'), node('p', card.id));
    for (const field of ['work_request', 'repo', 'pr', 'branch', 'pr_head', 'merge_sha', 'executor', 'model', 'evidence', 'reason', 'blocked_reason', 'next_action']) {
      if (card[field]) details.append(node('p', `${field.replaceAll('_', ' ')} · ${card[field]}`));
    }
    if (card.repo && card.pr && /^[\w.-]+\/[\w.-]+$/.test(card.repo) && /^\d+$/.test(String(card.pr))) {
      const link = node('a', 'Open pull request');
      link.href = `https://github.com/${card.repo}/pull/${card.pr}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      details.append(link);
    }
    article.append(details);
    return article;
  }
  function render() {
    const view = hierarchyView(data, address);
    const counter = doc.getElementById('task-count');
    if (counter) counter.textContent = [
      `${view.active.length} active`,
      ...(view.completed.length ? [`${view.completed.length} completed`] : []),
      ...(view.history.length ? [`${view.history.length} in history`] : [])
    ].join(' · ');
    const heading = doc.getElementById('pipeline-title');
    if (heading) heading.tabIndex = -1;
    if (heading) heading.textContent = ({requests:'Work Requests', slices:'Slices', prs:'Pull requests'})[view.level] || 'Work Requests';
    const previous = doc.activeElement?.closest('[data-hierarchy-id]')?.dataset.hierarchyId;
    const nav = node('nav', '', 'hierarchy-breadcrumbs');
    nav.setAttribute('aria-label', 'Work Request breadcrumbs');
    if (view.level && view.level !== 'requests') {
      const back = node('button', 'Back');
      back.id = 'hierarchy-back';
      back.type = 'button';
      back.addEventListener('click', () => navigate(view.parent));
      nav.append(back);
    }
    for (const [index, crumb] of view.crumbs.entries()) {
      const link = node('a', crumb.label);
      link.href = selectionUrl(crumb.id);
      if (index === view.crumbs.length - 1) link.setAttribute('aria-current', 'page');
      link.addEventListener('click', event => { event.preventDefault(); navigate(crumb.id); });
      nav.append(link);
    }
    const jump = node('form');
    jump.id = 'hierarchy-jump';
    const label = node('label', 'Jump to card ID');
    const input = node('input');
    input.name = 'card';
    input.placeholder = 'WR14.S2.J1.app#316';
    label.append(input);
    const submit = node('button', 'Go');
    submit.type = 'submit';
    jump.append(label, submit);
    jump.addEventListener('submit', event => { event.preventDefault(); navigate(input.value.trim()); });
    const tools = node('details', '', 'hierarchy-tools');
    tools.append(node('summary', 'Find by ID'), jump);
    const toolbar = node('div', '', 'hierarchy-toolbar');
    toolbar.append(nav, tools);
    const grid = node('div', '', view.level === 'prs' ? 'columns' : 'hierarchy-grid');
    if (view.level === 'prs') {
      for (const stage of STAGES.filter(stage => !['merged', 'live'].includes(stage.id))) {
        const active = view.active.filter(card => (card.stage || ({running:'build', blocked:'review', failed:'ci'}[card.status]) || card.status || 'queued') === stage.id);
        if (!active.length) continue;
        const column = node('section', '', 'column');
        column.dataset.stage = stage.id;
        column.style.setProperty('--stage-accent', stage.color);
        column.append(node('h3', `${stage.label} · ${active.length}`, 'column-head'));
        const body = node('div', '', 'column-body');
        body.append(...active.map(cardNode));
        column.append(body);
        grid.append(column);
      }
    } else grid.append(...view.active.map(cardNode));
    const completed = node('div');
    completed.id = 'hierarchy-completed';
    for (const [label, items] of [['Completed', view.completed], ['History', view.history]]) {
      if (!items.length) continue;
      const disclosure = node('details');
      disclosure.append(node('summary', `${label} · ${items.length}`));
      const history = node('div', '', 'hierarchy-grid');
      history.append(...items.map(cardNode));
      disclosure.append(history);
      completed.append(disclosure);
    }
    if (!view.active.length) {
      const noun = ({ requests: 'Work Requests', slices: 'slices', prs: 'pull requests' })[view.level];
      const place = ({ requests: 'on this board', slices: 'in this Work Request', prs: 'in this slice' })[view.level];
      const empty = node('div', '', 'hierarchy-empty');
      empty.append(node('p', view.error || (view.completed.length && !view.history.length
        ? `All ${noun} ${place} are completed.` : `There are no active ${noun} ${place}.`)));
      const action = node('button', view.completed.length ? `View completed ${noun}` : view.history.length ? 'View history'
        : view.level === 'requests' ? 'Refresh board' : view.parent ? 'Back to slices' : 'Back to Work Requests');
      action.type = 'button';
      action.addEventListener('click', () => {
        const disclosure = completed.querySelector('details');
        if (disclosure) { disclosure.open = true; disclosure.querySelector('summary').focus(); }
        else if (view.level === 'requests') doc.getElementById('board-retry')?.click();
        else navigate(view.parent || '');
      });
      empty.append(action);
      grid.append(empty);
    }
    container.classList.add('hierarchy-board');
    container.replaceChildren(toolbar, grid, completed);
    if (previous) focusDestination(previous);
  }
  const pop = () => {
    if (!inBoards()) { onClose?.(); return; }
    const origin = address;
    address = new URL(win.location.href).searchParams.get('card') || '';
    render();
    openSelected();
    if (!hierarchyView(data, address).selected) focusDestination(origin);
  };
  win.addEventListener('popstate', pop);
  return { update(value) {
    const signature = JSON.stringify(value);
    if (signature !== lastSignature) {
      lastSignature = signature;
      data = value; render();
      if (firstRead) {
        firstRead = false;
        openSelected();
      }
    }
    return hierarchyView(data, address).selected;
  }, dispose() { win.removeEventListener('popstate', pop); } };
}
