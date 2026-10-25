// Representative interactions from the deterministic V1 journeys. All data is synthetic.
export const profile = Object.freeze({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
  cpuSlowdown: 4, latencyMs: 150, downloadBytesPerSecond: 200000, uploadBytesPerSecond: 93750,
  samples: 3, aggregation: 'median', interaction: 'pointerdown timestamp to verified state plus two animation frames' });
export const screens = [
  { id: 'home', route: '/', ready: '#dealFlags .home-flag', tap: '[data-scope="mine"]', complete: () => document.querySelectorAll('#dealFlags .home-flag').length === 2 },
  { id: 'deals', route: '/deals', ready: '.kanban-card[data-id="d23"]', tap: '.kanban-card[data-id="d23"]', complete: () => document.querySelector('#detailUpdateForm')?.getClientRects().length > 0 },
  { id: 'vendors', route: '/vendors', ready: '.record-row', tap: '.record-row', complete: () => document.querySelector('#recordPanel')?.getClientRects().length > 0 },
  { id: 'tours', route: '/tours', ready: '[data-market="Pensacola, FL"]', tap: '[data-market="Pensacola, FL"]', complete: () => document.querySelector('#space-area')?.value === 'Pensacola, FL' },
  { id: 'relationships', route: '/relationships', ready: '#networkNodes [data-node="party:demo-lender"]', tap: '#networkNodes [data-node="party:demo-lender"]', complete: () => document.querySelector('.relationship-dialog')?.getClientRects().length > 0 },
  { id: 'invoices', route: '/invoices', ready: '[data-invoice]', tap: '#invoiceAging [data-age="2"]', complete: () => document.querySelectorAll('[data-invoice]').length === 1 },
];

export const tasks = [
  { id: 'task-agenda', route: '/', fixture: 'agenda', conditions: '40 active synthetic deals; detail reads delayed 75ms',
    ready: '#homeCalendar[aria-busy="false"] #homeAgenda a',
    async verify(page) {
      await page.locator('[data-agenda-show-all]').click();
      await page.waitForFunction(() => document.querySelectorAll('#homeAgenda a').length >= 40);
    } },
  { id: 'task-leads', route: '/leads', fixture: 'leads', conditions: '375 synthetic leads; board and detail reads delayed 75ms; intercepted telephone link and persisted pageshow',
    ready: '#leadBoard .lead-open',
    async verify(page) {
      const button = page.locator('#leadBoard .lead-open').first();
      const title = await button.textContent();
      await button.tap();
      await page.locator('#leadDetail a[href^="tel:"]').waitFor();
      const selected = await page.locator('#detailTitle').textContent();
      if (!selected || !title.includes(selected)) throw Error('Lead detail does not match selected lead');
      await page.evaluate(() => document.querySelector('#leadDetail a[href^="tel:"]').addEventListener('click', event => event.preventDefault(), { once: true }));
      await page.locator('#leadDetail a[href^="tel:"]').tap();
      const reread = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.arguments?.lead_id);
      await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
      await reread;
      await page.waitForFunction(title => document.querySelector('#leadDetail')?.open && document.querySelector('#detailTitle')?.textContent === title && document.querySelector('#detailBody a[href^="tel:"]'), selected);
    } },
  { id: 'task-deal-link', route: '/deals?deal=d23', fixture: 'deals', conditions: 'exact fixture deal URL; detail reads delayed 75ms',
    ready: '#recordPanel[open] #detailUpdateForm',
    async verify(page) {
      if (new URL(page.url()).searchParams.get('deal') !== 'd23' || (await page.locator('#panelTitle').textContent()) !== 'Demo Specialty Clinic') throw Error('Exact deal link opened the wrong record');
    } },
  { id: 'task-deal-draft', route: '/deals', fixture: 'deals', conditions: 'fixture deal; unsent draft across browser Back and reopen; detail reads delayed 75ms',
    ready: '.kanban-card[data-id="d23"] .card-open',
    async verify(page) {
      await page.locator('.kanban-card[data-id="d23"] .card-open').tap();
      await page.locator('#detailUpdateForm textarea').fill('Synthetic unsent phone update');
      await page.goBack();
      await page.waitForFunction(() => !document.querySelector('#recordPanel').open && !new URL(location.href).searchParams.has('deal'));
      await page.locator('.kanban-card[data-id="d23"] .card-open').tap();
      await page.waitForFunction(() => document.querySelector('#recordPanel').open && document.querySelector('#detailUpdateForm textarea')?.value === 'Synthetic unsent phone update');
      if (!await page.locator('#detailUpdateStatus').textContent().then(text => text.includes('Unsent'))) throw Error('Restored draft is not labeled unsent');
    } },
  { id: 'task-tour-library', route: '/tours', fixture: 'tours', conditions: '40 synthetic saved tours; client directory delayed 250ms',
    ready: '#appSidebarToggle',
    async verify(page) {
      await page.locator('#appSidebarToggle').tap();
      await page.locator('#upcoming-tours .tour-button').first().tap();
      await page.waitForFunction(() => document.querySelector('#tour-dialog').open && document.querySelector('#detail-title').textContent === 'Synthetic tour');
      await page.locator('#detail-content').getByText('Demo waterfront office', { exact: false }).waitFor();
    } },
  { id: 'task-tour-offline', route: '/tours/day.html?tour=11111111-1111-4111-8111-111111111111', fixture: 'tours', conditions: 'saved same-tab itinerary; service worker enabled; HTTP cache cleared; offline reload',
    ready: '#day-current .property-open',
    async verify(page, context) {
      await page.waitForFunction(() => document.querySelector('#day-offline').textContent === 'Available offline' && navigator.serviceWorker.controller);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.clearBrowserCache');
      await page.unroute('**/api/**');
      await page.unroute('**/auth/session');
      await page.unroute('**/mcp');
      await context.setOffline(true);
      const started = performance.now();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#day-status')?.textContent.includes('Offline') && document.querySelectorAll('.day-stop').length === 2);
      if (!await page.locator('#day-current').textContent().then(text => text.includes('Demo waterfront office'))) throw Error('Saved tour lost its current property');
      if (!await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim())) throw Error('Saved shell is missing required styles');
      return Math.ceil(performance.now() - started);
    } },
];

export async function runTaskScenario({ page, context, origin, task }) {
  const reads = [], bodies = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && (url.pathname.startsWith('/api/') || ['/mcp', '/auth/session', '/pipeline/changes'].includes(url.pathname))) {
      reads.push(url.pathname === '/mcp' ? request.postDataJSON()?.params?.name || '/mcp' : url.pathname);
    }
  });
  page.on('response', response => {
    if (new URL(response.url()).origin === origin && response.ok()) bodies.push(response.body().then(body => body.length));
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.__taskReads = [];
    window.__taskLcp = null;
    new PerformanceObserver(list => {
      window.__taskLcp = list.getEntries().at(-1).startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  if (task.fixture === 'agenda' || task.fixture === 'deals') {
    await page.route('**/js/fixture-client.js', async route => {
      const response = await route.fetch();
      let source = (await response.text()).replace('export async function createFixtureClient', 'async function originalFixtureClient');
      source += `\nexport async function createFixtureClient(options) {
        const client = await originalFixtureClient(options);
        for (const name of Object.keys(client)) {
          if (typeof client[name] !== 'function') continue;
          const read = client[name];
          client[name] = async function(...args) {
            window.__taskReads.push(name);
            if (name === 'getDeal') await new Promise(resolve => setTimeout(resolve, 75));
            const result = await read.apply(this, args);
            ${task.fixture === 'agenda' ? "if (name === 'getDeal') return { ...result, critical_dates: [], next_actions: [{ id: 'synthetic-task-' + args[0], description: 'Synthetic follow-up', status: 'open', owner: 'joe', due_on: null }] };" : ''}
            return result;
          };
        }
        return client;
      }`;
      await route.fulfill({ response, body: source });
    });
    if (task.fixture === 'agenda') await page.route('**/data/board-seed.json', async route => {
      const response = await route.fetch(), seed = await response.json();
      const base = seed.deals.find(deal => deal.id === 'd23');
      seed.deals = Array.from({ length: 40 }, (_, index) => ({ ...base, id: `synthetic-deal-${index}`, name: `Synthetic practice ${index + 1}`, owner: 'joe', operating_state: 'active' }));
      await route.fulfill({ response, json: seed });
    });
  }
  if (task.fixture === 'leads' || task.fixture === 'tours') {
    const [{ workspace, lead, detail: leadDetail }, { detail: tourDetail }] = await Promise.all([
      import('../test/leads-workspace-fixture.mjs'), import('../test/fixtures/tour-day.synthetic.mjs'),
    ]);
    const board = { ...workspace(), leads: Array.from({ length: 375 }, (_, index) => lead(index + 1)) };
    await page.route('**/mcp', async route => {
      const params = route.request().postDataJSON().params;
      let value = { ok: true, suggestions: [] };
      if (params.name === 'lead-board') {
        await new Promise(resolve => setTimeout(resolve, 75));
        value = { ...board, ...(params.arguments.lead_id ? { detail: leadDetail(board.leads.find(row => row.id === params.arguments.lead_id)) } : {}) };
      }
      await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/session')) return route.fulfill({ json: { actor: { slug: 'example-partner' }, csrf_token: 'synthetic-performance-session' } });
      if (url.pathname === '/api/tours/detail') return route.fulfill({ json: { data: tourDetail, csrf_token: 'synthetic-performance-session' } });
      if (url.pathname === '/api/tours/library') return route.fulfill({ json: { data: { tours: Array.from({ length: 40 }, (_, index) => ({ id: index ? `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` : tourDetail.id, name: index ? `Synthetic tour ${index}` : tourDetail.name, status: 'scheduled' })) }, csrf_token: 'synthetic-performance-session' } });
      if (url.pathname === '/api/v1/business/clients') {
        await new Promise(resolve => setTimeout(resolve, 250));
        return route.fulfill({ json: { rows: [], page: 1, page_count: 1, csrf_token: 'synthetic-performance-session' } });
      }
      return route.fulfill({ json: { items: [], counts: {} } });
    });
    await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'example-partner' }, csrf_token: 'synthetic-performance-session' } }));
  }
  const started = performance.now();
  await page.goto(origin + task.route, { waitUntil: 'domcontentloaded' });
  await page.locator(task.ready).first().waitFor({ state: 'visible' });
  const taskMs = await task.verify(page, context);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const usefulMs = taskMs ?? Math.ceil(performance.now() - started);
  await page.waitForFunction(() => window.__taskLcp > 0);
  const lcpMs = Math.ceil(await page.evaluate(() => window.__taskLcp));
  reads.push(...await page.evaluate(() => window.__taskReads || []));
  const criticalBytes = (await Promise.all(bodies)).reduce((total, bytes) => total + bytes, 0);
  if (errors.length) throw Error(`Task errors: ${errors.join('; ')}`);
  return { lcpMs, usefulMs, requestCount: reads.length, criticalBytes, reads, errors, conditions: task.conditions };
}
