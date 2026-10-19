import { STAGES } from './progress-board-model.js';
import { boardPageUrl } from './progress-board-route.js';

export function hierarchyUrl(boardId, cardId = '') {
  return boardPageUrl(boardId) + (cardId ? `?card=${encodeURIComponent(cardId)}` : '');
}

export function hierarchyView(data, address = '') {
  const tree = data.hierarchy;
  const cards = data.tasks || {};
  const seen = new Set();
  while (tree.aliases?.[address] && !seen.has(address)) {
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

export function mountHierarchy({ container, window: win, boardId, onOpen }) {
  const doc = container.ownerDocument;
  let data;
  let firstRead = true;
  let lastSignature = '';
  let address = new URL(win.location.href).searchParams.get('card') || '';
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function navigate(id, replace = false) {
    address = id;
    win.history[replace ? 'replaceState' : 'pushState']({}, '', hierarchyUrl(boardId, id));
    render();
    const selected = hierarchyView(data, id).selected;
    if (selected) onOpen({ ...selected, title: selected.card_title, summary: selected.card_description });
  }
  function cardNode(card) {
    const article = node('article', '', 'hierarchy-card');
    article.dataset.hierarchyId = card.id;
    const button = node('button', card.card_title, 'hierarchy-card-title');
    button.type = 'button';
    button.addEventListener('click', () => navigate(card.id));
    article.addEventListener('click', event => { if (event.target === article) navigate(card.id); });
    article.append(button, node('p', card.card_description, 'hierarchy-description'));
    const counts = card.counts || card.pr_counts;
    if (counts) article.append(node('p', Object.entries(counts).map(([stage, count]) => `${count} ${stage}`).join(' · '), 'hierarchy-counts'));
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
    const heading = doc.getElementById('pipeline-title');
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
    for (const crumb of view.crumbs) {
      const link = node('a', crumb.label);
      link.href = hierarchyUrl(boardId, crumb.id);
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
    if (!view.active.length) grid.append(node('p', view.error || 'No active work at this level.', 'empty'));
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
    container.classList.add('hierarchy-board');
    container.replaceChildren(nav, jump, grid, completed);
    if (previous) [...container.querySelectorAll('[data-hierarchy-id]')].find(card => card.dataset.hierarchyId === previous)?.querySelector('button')?.focus();
  }
  const pop = () => { address = new URL(win.location.href).searchParams.get('card') || ''; render(); };
  win.addEventListener('popstate', pop);
  return { update(value) {
    const signature = JSON.stringify(value);
    if (signature === lastSignature) return;
    lastSignature = signature;
    data = value; render();
    if (firstRead) {
      firstRead = false;
      const selected = hierarchyView(data, address).selected;
      if (selected) onOpen({...selected, title:selected.card_title, summary:selected.card_description});
    }
  }, dispose() { win.removeEventListener('popstate', pop); } };
}
