// Representative interactions from the deterministic V1 journeys. All data is synthetic.
export const profile = Object.freeze({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
  cpuSlowdown: 4, latencyMs: 150, downloadBytesPerSecond: 200000, uploadBytesPerSecond: 93750,
  samples: 3, aggregation: 'median', interaction: 'pointerdown timestamp to verified state plus two animation frames' });
export const screens = [
  { id: 'home', route: '/', ready: '#dealFlags .home-flag', tap: '[data-scope="mine"]', complete: () => document.querySelectorAll('#dealFlags .home-flag').length === 2 },
  { id: 'deals', route: '/deals', ready: '.kanban-card[data-id="d23"]', tap: '.kanban-card[data-id="d23"]', complete: () => document.querySelector('#detailNextForm')?.getClientRects().length > 0 },
  { id: 'vendors', route: '/vendors', ready: '.record-row', tap: '.record-row', complete: () => document.querySelector('#recordPanel')?.getClientRects().length > 0 },
  { id: 'tours', route: '/tours', ready: '[data-market="Pensacola, FL"]', tap: '[data-market="Pensacola, FL"]', complete: () => document.querySelector('#space-area')?.value === 'Pensacola, FL' },
  { id: 'relationships', route: '/relationships', ready: '.relationship-node[data-node="party:demo-lender"]', tap: '.relationship-node[data-node="party:demo-lender"]', complete: () => document.querySelector('.relationship-dialog')?.getClientRects().length > 0 },
  { id: 'invoices', route: '/invoices', ready: '[data-invoice]', tap: '#invoiceAging [data-age="2"]', complete: () => document.querySelectorAll('[data-invoice]').length === 1 },
];
