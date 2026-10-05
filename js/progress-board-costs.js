const SVG_NS = 'http://www.w3.org/2000/svg';
const usd = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) : 'Unavailable';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const monthId = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const money = value => value === null || Number.isFinite(value);
const hasCoverage = row => ['ready', 'partial'].includes(row.state);

function validCosts(value) {
  return record(value) && value.schema === 'carr-system-costs.v1' && monthId(value.month)
    && typeof value.through === 'string' && /^\d{4}-\d{2}-(0[1-9]|[12]\d|3[01])$/.test(value.through)
    && Number.isFinite(Date.parse(value.observed_at)) && typeof value.action === 'string' && value.action.trim().length > 0
    && Array.isArray(value.providers) && value.providers.every(row => record(row)
      && ['provider', 'label', 'plan', 'state'].every(key => typeof row[key] === 'string')
      && ['mtd_usd', 'projection_usd', 'budget_usd'].every(key => money(row[key]))
      && Array.isArray(row.daily) && row.daily.every(day => record(day) && typeof day.day === 'string' && Number.isFinite(day.usd) && record(day.drivers)))
    && Array.isArray(value.months) && value.months.every(row => record(row) && monthId(row.month) && money(row.usd) && record(row.providers))
    && Array.isArray(value.alerts) && value.alerts.every(row => record(row) && ['provider', 'driver', 'kind'].every(key => typeof row[key] === 'string'));
}

export function mountCostView(root) {
  if (!root) return { update() {} };
  const doc = root.ownerDocument;
  const el = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const svg = (tag, attrs, text) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const heading = el('div', undefined, 'panel-heading');
  heading.append(el('h2', 'System costs'));
  const status = el('span', undefined, 'cost-state');
  heading.append(status);
  const controls = el('div', undefined, 'cost-controls');
  const provider = el('select'); provider.setAttribute('aria-label', 'Cost provider');
  const month = el('select'); month.setAttribute('aria-label', 'Cost month');
  for (const [title, select] of [['Provider', provider], ['Month', month]]) {
    const label = el('label', title); label.append(select); controls.append(label);
  }
  const content = el('div', undefined, 'cost-content');
  const live = el('span', undefined, 'sr-only'); live.setAttribute('role', 'status');
  const dialog = el('dialog', undefined, 'cost-dialog');
  const dayTitle = el('h3'), dayBody = el('p'), close = el('button', 'Close'); close.type = 'button';
  dialog.append(dayTitle, dayBody, close); dialog.setAttribute('aria-label', 'Daily spend details');
  close.addEventListener('click', () => dialog.close());
  root.append(heading, controls, content, live, dialog);
  let data, signature;

  function draw() {
    const current = month.value === data.month;
    const chosen = data.providers.filter(row => provider.value === '' || row.provider === provider.value);
    content.replaceChildren();
    const observed = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC', hour12: true }).format(new Date(data.observed_at));
    const meta = el('p', current ? `Through ${data.through} UTC · Observed ${observed} UTC` : month.value, 'cost-meta');
    content.append(meta);
    const metrics = el('div', undefined, 'cost-metrics');
    const total = key => chosen.every(row => Number.isFinite(row[key])) ? chosen.reduce((sum, row) => sum + row[key], 0) : null;
    const complete = chosen.length > 0 && chosen.every(row => row.state === 'ready') && (provider.value !== '' || data.state === 'ready');
    const known = key => {
      const rows = chosen.filter(row => hasCoverage(row) && Number.isFinite(row[key]));
      return rows.length ? rows.reduce((sum, row) => sum + row[key], 0) : null;
    };
    const history = data.months.find(row => row.month === month.value);
    const monthSpend = provider.value === '' ? history?.usd : history?.providers?.[provider.value];
    for (const [title, value] of current ? [[complete ? 'Month to date' : 'Known month to date', known('mtd_usd')],
      [complete ? 'Projected month' : 'Known projection · incomplete', known('projection_usd')], ['Monthly budget', total('budget_usd')]]
      : [[complete ? 'Monthly spend' : 'Known monthly spend', chosen.some(hasCoverage) ? monthSpend : null]]) {
      const metric = el('div'); metric.append(el('span', title), el('strong', usd(value))); metrics.append(metric);
    }
    content.append(metrics);
    if (!complete) content.append(el('p', 'Coverage incomplete · Amounts exclude unknown costs.', 'cost-warning'));
    const coverage = el('ul', undefined, 'cost-coverage');
    for (const row of chosen) coverage.append(el('li', `${row.label} · ${row.plan} · ${row.state}${row.reason ? ` · ${row.reason}` : ''}`));
    content.append(coverage);
    content.append(el('p', 'Fixed subscriptions use daily accrual estimates.', 'cost-meta'));

    {
      const selectedMonth = month.value;
      const count = current ? Number(data.through.slice(-2)) : new Date(Date.UTC(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(-2)), 0)).getUTCDate();
      const days = Array.from({ length: count }, (_, i) => {
        const day = `${selectedMonth}-${String(i + 1).padStart(2, '0')}`;
        const rows = chosen.map(row => hasCoverage(row) ? row.daily?.find(item => item.day === day) : null);
        const knownRows = rows.filter(row => Number.isFinite(row?.usd));
        return { day, usd: knownRows.length ? knownRows.reduce((sum, row) => sum + row.usd, 0) : null, complete: complete && knownRows.length === chosen.length,
          drivers: knownRows.flatMap(row => Object.entries(row.drivers || {}).map(([driver, amount]) => `${driver} ${usd(amount)}`)) };
      });
      const graph = svg('svg', { viewBox: '0 0 700 210', role: 'group', 'aria-label': `Daily spend for ${provider.selectedOptions[0]?.textContent}, ${selectedMonth}`, class: 'cost-chart' });
      const observedDays = days.filter(day => Number.isFinite(day.usd));
      const highest = observedDays.length ? Math.max(...observedDays.map(day => day.usd)) : null;
      const max = Math.max(1, highest ?? 0);
      graph.append(svg('text', { x: 0, y: 15 }, highest === null ? 'Daily spend unavailable' : `${usd(highest)} · highest observed day`));
      for (const [i, day] of days.entries()) {
        const x = 12 + i * 676 / days.length, width = Math.max(2, 676 / days.length - 5), height = 145 * day.usd / max;
        const bar = svg('rect', { x, y: 175 - height, width, height: Math.max(3, height), rx: 3, tabindex: 0, 'data-day': day.day,
          role: 'button', class: day.complete ? 'cost-bar' : 'cost-bar cost-bar-partial' });
        const label = `${day.day}: ${usd(day.usd)}${Number.isFinite(day.usd) ? ' known' : ''}${day.complete ? '' : ' · incomplete coverage'}${day.drivers.length ? ` · ${day.drivers.join(', ')}` : ''}`;
        bar.setAttribute('aria-label', label); bar.append(svg('title', {}, label));
        bar.addEventListener('focus', () => { detail.textContent = label; });
        bar.addEventListener('pointerenter', () => { detail.textContent = label; });
        const openDay = () => { dayTitle.textContent = day.day; dayBody.textContent = label; dialog.showModal(); };
        bar.addEventListener('click', openDay);
        bar.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDay(); } });
        graph.append(bar);
        if (i === 0 || i === days.length - 1 || (i + 1) % 7 === 0) graph.append(svg('text', { x, y: 199 }, String(i + 1)));
      }
      const detail = el('p', 'Select a day for spend drivers.', 'cost-day-detail'); detail.setAttribute('aria-live', 'polite');
      content.append(graph, detail);
      for (const row of chosen.filter(row => current && row.provider === 'jev')) {
        const sites = el('div', undefined, 'cost-call-sites'); sites.append(el('h3', 'Jev by call site'));
        const list = el('ul');
        for (const [site, amount] of Object.entries(row.call_sites || {}).sort((a, b) => b[1] - a[1])) list.append(el('li', `${site} · ${usd(amount)}`));
        if (!list.children.length) list.append(el('li', 'No call-site observations'));
        sites.append(list); content.append(sites);
      }
    }
    const alerts = el('ul', undefined, 'cost-alerts');
    for (const alert of data.alerts.filter(row => provider.value === '' || row.provider === provider.value)) alerts.append(el('li', `${alert.provider} · ${alert.driver} · ${alert.kind.replaceAll('_', ' ')} · ${usd(alert.amount_usd)} exceeds ${usd(alert.threshold_usd)}`));
    if (alerts.children.length) content.append(el('h3', 'Current alerts'), alerts);
    content.append(el('p', `On breach: ${data.action}`, 'cost-action'));
  }
  provider.addEventListener('change', draw);
  month.addEventListener('change', draw);

  return {
    update(next) {
      if (!validCosts(next)) {
        root.hidden = true; content.replaceChildren(); provider.replaceChildren(); month.replaceChildren();
        status.textContent = ''; live.textContent = ''; dayTitle.textContent = ''; dayBody.textContent = '';
        if (dialog.open) dialog.close();
        data = null; signature = null; return;
      }
      const nextSignature = JSON.stringify(next);
      root.hidden = false;
      if (nextSignature === signature) return;
      data = next; signature = nextSignature;
      live.textContent = 'System costs updated.';
      status.textContent = data.state; status.dataset.state = data.alerts.length ? 'alert' : data.state;
      const oldProvider = provider.value, oldMonth = month.value;
      provider.replaceChildren(el('option', 'All providers'));
      provider.firstChild.value = '';
      for (const row of data.providers) { const option = el('option', row.label); option.value = row.provider; provider.append(option); }
      provider.value = [...provider.options].some(row => row.value === oldProvider) ? oldProvider : '';
      month.replaceChildren();
      for (const value of [...new Set([data.month, ...data.months.map(row => row.month)])].sort().reverse()) {
        const option = el('option', value); option.value = value; month.append(option);
      }
      month.value = [...month.options].some(row => row.value === oldMonth) ? oldMonth : data.month;
      draw();
    },
  };
}
