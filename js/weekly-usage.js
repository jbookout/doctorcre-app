import { FEATURES, USAGE_SCHEMA } from './usage-contract.v1.js';

const date = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
function summaryRows(value, sha) {
  if (value?.schema !== USAGE_SCHEMA || value.release_sha !== sha || !['since_release', 'retained_window'].includes(value.coverage) || !Array.isArray(value.features) || value.features.length !== FEATURES.length) throw new Error('Invalid summary');
  return FEATURES.map(feature => {
    const rows = value.features.filter(row => row.id === feature.id);
    const row = rows[0];
    if (rows.length !== 1 || ['joe', 'dell'].some(partner => !Number.isSafeInteger(row.uses?.[partner]) || row.uses[partner] < 0 || !date(row.last_used?.[partner]) || ![true, false, null].includes(row.never_used?.[partner]))) throw new Error('Invalid feature');
    return { ...feature, uses: row.uses, last_used: row.last_used, never_used: row.never_used };
  });
}

export function mountWeeklyUsage({ host, fetch: request = (...args) => globalThis.fetch(...args) }) {
  const root = host.ownerDocument;
  if (!root.querySelector('link[data-usage-style]')) {
    const link = root.createElement('link'); link.rel = 'stylesheet'; link.href = '/css/usage-signals.css'; link.dataset.usageStyle = ''; root.head.append(link);
  }
  host.classList.add('weekly-usage');
  const make = (tag, text) => { const node = root.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const header = make('header'); header.append(make('h3', 'Weekly feature use'));
  const filter = make('select'); filter.setAttribute('aria-label', 'Feature type');
  for (const [key, label] of [['view', 'Screens'], ['action', 'Actions'], ['doc', 'Doc and search'], ['error', 'Errors']]) { const option = make('option', label); option.value = key; filter.append(option); }
  const refreshButton = make('button', '↻'); refreshButton.type = 'button'; refreshButton.setAttribute('aria-label', 'Refresh usage');
  header.append(filter, refreshButton);
  const status = make('p', 'Updating…'); status.setAttribute('role', 'status');
  const chart = make('div'), details = make('details'), tableHost = make('div'); details.append(make('summary', 'Last use and never used'), tableHost);
  host.append(header, status, chart, details);
  let value = null, rows = [], disposed = false, epoch = 0;
  const last = timestamp => timestamp ? new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const state = (row, partner) => row.never_used[partner] === true ? 'Never used' : row.never_used[partner] === null ? 'Unknown' : 'Used';
  const paint = () => {
    const shown = rows.filter(row => filter.value === 'doc' ? ['chat_opened', 'chat_sent', 'search_used'].includes(row.event_name) : row.id.endsWith(`:${filter.value}`));
    chart.replaceChildren(); tableHost.replaceChildren();
    const svg = root.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const active = shown.filter(row => row.uses.joe + row.uses.dell > 0).sort((a, b) => b.uses.joe + b.uses.dell - a.uses.joe - a.uses.dell);
    const narrow = host.clientWidth > 0 && host.clientWidth < 600, rowHeight = narrow ? 60 : 42;
    svg.setAttribute('viewBox', `0 0 ${narrow ? 360 : 620} ${Math.max(48, active.length * rowHeight)}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Feature uses in the last seven days. Orange: Joe. Blue: Dell.');
    const maximum = Math.max(1, ...active.flatMap(row => Object.values(row.uses)));
    const draw = (tag, attrs, text) => { const node = root.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; svg.append(node); };
    if (!active.length) draw('text', { x: 0, y: 24, class: 'usage-label' }, 'No captures this week');
    active.forEach((row, index) => {
      const y = index * rowHeight;
      draw('text', { x: 0, y: y + 17, class: 'usage-label' }, row.label);
      for (const [partner, offset] of [['joe', 2], ['dell', 18]]) draw('rect', { x: narrow ? 0 : 210, y: y + offset + (narrow ? 22 : 0), width: row.uses[partner] / maximum * (narrow ? 210 : 235), height: 11, class: `usage-bar usage-${partner}` });
      draw('text', { x: narrow ? 225 : 460, y: y + (narrow ? 41 : 19), class: 'usage-count' }, `Joe ${row.uses.joe} · Dell ${row.uses.dell}`);
    });
    chart.append(svg);
    const table = make('table'), head = make('thead'), tr = make('tr');
    for (const label of ['Feature', 'Joe uses', 'Dell uses', 'Joe last use', 'Dell last use', 'Joe since release', 'Dell since release']) tr.append(make('th', label));
    head.append(tr); table.append(head);
    const body = make('tbody');
    for (const row of shown) { const tr = make('tr'); for (const text of [row.label, row.uses.joe, row.uses.dell, last(row.last_used.joe), last(row.last_used.dell), state(row, 'joe'), state(row, 'dell')]) tr.append(make('td', text)); body.append(tr); }
    table.append(body); tableHost.append(table);
    status.textContent = `Last seven days · ${value.enabled ? 'Capture on' : 'Capture off'} · ${value.coverage === 'retained_window' ? '180-day history · Earlier release use unknown' : 'Never-used history since release'}`;
  };
  const refresh = async () => {
    const current = ++epoch;
    try {
      const releaseResponse = await request('/app-release', { cache: 'no-store' });
      if (!releaseResponse.ok) throw new Error('Release unavailable');
      const release = await releaseResponse.json(), sha = release.source_commit;
      if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Release unavailable');
      const params = new URLSearchParams({ release_sha: sha });
      const started = release.provider_version_created_at;
      if (typeof started === 'string' && Number.isFinite(Date.parse(started)) && Date.parse(started) <= Date.now()) params.set('release_started_at', new Date(started).toISOString());
      const response = await request(`/api/v1/usage-signals?${params}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Usage unavailable');
      const payload = await response.json(), next = summaryRows(payload, sha);
      if (disposed || epoch !== current) return;
      value = payload; rows = next; details.hidden = false; paint();
    } catch { if (!disposed && epoch === current) { value = null; rows = []; chart.replaceChildren(); tableHost.replaceChildren(); details.hidden = true; status.textContent = 'Usage unavailable'; } }
  };
  filter.onchange = () => { if (value) paint(); };
  refreshButton.onclick = refresh;
  let width = host.clientWidth;
  const resize = root.defaultView.ResizeObserver ? new root.defaultView.ResizeObserver(() => { if (host.clientWidth !== width) { width = host.clientWidth; if (value) paint(); } }) : null;
  resize?.observe(host);
  return { refresh, dispose() { disposed = true; ++epoch; resize?.disconnect(); } };
}
