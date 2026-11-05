import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderDealChecklist } from '../js/deal-checklist.js';
import { createLiveClient } from '../js/live-client.js';
import { carrInterface } from "./carr-contract.mjs";

const checklist = {
  schema_version: 'deal-checklist.v1', template_state: 'current',
  due_items: [{ id: 'critical-date:demo', label: 'Attorney review', status: 'due', due_on: '2026-10-20' }],
  phases: [{ id: 'legal', label: 'Legal / lease', items: [
    { id: 'attorney_review', label: 'Attorney review <script>', status: 'due', due_on: '2026-10-20', evidence_ref: 'Demo contract clause 3', source: { document: 'deal-room-kit', version: 1 } },
    { id: 'executed_lease', label: 'Executed lease', status: 'not_recorded', source: { document: 'deal-room-kit', version: 1 } },
  ] }],
};

test('deal card displays producer statuses, due work and escaped evidence by phase', () => {
  const root = new JSDOM(renderDealChecklist(checklist)).window.document;
  assert.match(root.querySelector('summary').textContent, /1 due/);
  assert.match(root.body.textContent, /Not recorded/);
  assert.match(root.body.textContent, /Demo contract clause 3/);
  assert.equal(root.querySelector('script'), null);
  assert.equal(root.querySelector('input'), null);
  assert.equal(root.querySelector('[data-checklist-item="attorney_review"] time').dateTime, '2026-10-20');
});

test('the closed checklist summary names the first due item and its deadline', () => {
  const root = new JSDOM(renderDealChecklist(checklist)).window.document;
  const summary = root.querySelector('.deal-checklist > summary');
  assert.match(summary.textContent, /Attorney review/);
  assert.match(summary.textContent, /Due today/);
  assert.equal(summary.querySelector('time').dateTime, '2026-10-20');
  assert.equal(root.querySelector('.deal-checklist').open, false);
});

test('a received document uses the producer status without claiming satisfaction or requesting delivery', () => {
  const received = { id: 'title_commitment', label: 'Title commitment', status: 'received',
    due_on: '2020-01-01', evidence_ref: 'Title <signed>.pdf',
    request: { status: 'fulfilled', satisfied: false }, source: { document: 'deal-room-kit', version: 1 } };
  const root = new JSDOM(renderDealChecklist({ ...checklist, due_items: [],
    phases: [{ id: 'legal', label: 'Legal', items: [received] }] })).window.document;
  const row = root.querySelector('[data-checklist-item="title_commitment"]');
  assert.equal(row.querySelector('strong').textContent, 'Received');
  assert.match(row.textContent, /Title <signed>\.pdf/);
  assert.equal(row.querySelector('signed'), null);
  assert.doesNotMatch(row.textContent, /attachment:/);
  assert.doesNotMatch(row.textContent, /Recorded complete|Overdue|Due today/);
  assert.doesNotMatch(root.querySelector('.deal-checklist > summary').textContent, /due|Title commitment/);
  assert.equal(received.request.satisfied, false);
});

test('live getDeal preserves the runtime checklist without deriving it in the browser', async () => {
  const client = createLiveClient({ fetchImpl: async () => new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ deal_id: 'demo', phase: 'legal', checklist }) }] } })) });
  assert.deepEqual((await client.getDeal('demo')).checklist, checklist);
});

test('absent and empty checklists render nothing', () => {
  for (const value of [undefined, null, { ...checklist, phases: [] }, { ...checklist, due_items: [], phases: [{ id: 'legal', label: 'Legal', items: [] }] }]) {
    assert.equal(renderDealChecklist(value), '');
  }
});

test('unavailable requirements stay visible without due counts or completion evidence', () => {
  const root = new JSDOM(renderDealChecklist({ schema_version: 'deal-checklist.v1',
    template_state: 'unavailable', phases: [], due_items: [] })).window.document;
  assert.equal(root.querySelector('[role="status"]').textContent, 'Requirements could not be read.');
  assert.equal(root.querySelector('button').textContent, 'Refresh deal');
  assert.doesNotMatch(root.body.textContent, /0 due|Recorded complete|All complete/);
  assert.equal(root.querySelector('[data-checklist-item]'), null);
});

test('unavailable checklists never expose stale phases or due evidence', () => {
  const html = renderDealChecklist({ ...checklist, template_state: 'unavailable' });
  assert.match(html, /Requirements could not be read/);
  assert.doesNotMatch(html, /data-checklist-item|Attorney review|Demo contract clause 3|1 due/);
});

test('unsupported contracts and changed doctrine retain their explicit review message', () => {
  for (const value of [{ schema_version: 'deal-checklist.v2' }, { ...checklist, template_state: 'source_changed' }]) {
    assert.match(renderDealChecklist(value), /Checklist unavailable|Checklist needs a doctrine review/);
    assert.doesNotMatch(renderDealChecklist(value), /data-checklist-item/);
  }
});

test('the checklist contract pins the runtime revision that owns derivation', async () => {
  const contract = carrInterface.mcp_read_contracts['get-deal-room'].checklist;
  assert.equal(contract.schema_version, 'deal-checklist.v1');
  assert.equal(contract.producer.repository, 'jbookout/carr-system');
  assert.match(contract.producer.source_commit, /^[0-9a-f]{40}$/);
  assert.equal(contract.producer.source_commit, carrInterface.producer.source_commit);
  assert.ok(contract.statuses.includes('received'));
  assert.match(contract.receipt_basis, /satisfied=false/);
});

for (const [name, patch] of Object.entries({
  'missing phases': { phases: undefined }, 'null phases': { phases: null },
  'null phase': { phases: [null] }, 'missing items': { phases: [{ label: 'Legal' }] },
  'null item': { phases: [{ label: 'Legal', items: [null] }] },
  'missing source': { phases: [{ label: 'Legal', items: [{ id: 'x', label: 'Lease', status: 'complete' }] }] },
  'unknown status': { phases: [{ label: 'Legal', items: [{ id: 'x', label: 'Lease', status: 'invented', source: { document: 'kit' } }] }] },
  'null due items': { due_items: null }, 'bad due item': { due_items: [null] },
  'unknown due status': { due_items: [{ label: 'Lease', status: 'invented', due_on: '2026-10-20' }] },
  'bad source': { phases: [{ label: 'Legal', items: [{ id: 'x', label: 'Lease', status: 'complete', source: {} }] }] },
})) test(`malformed checklist recovers without claiming completion: ${name}`, () => {
  const value = { ...checklist, ...patch };
  const before = structuredClone(value);
  const root = new JSDOM(renderDealChecklist(value)).window.document;
  assert.equal(root.querySelector('[role="status"]').textContent, 'Checklist unavailable.');
  assert.equal(root.querySelector('[data-refresh-detail][data-detail-focus="checklist"]').textContent, 'Refresh deal');
  assert.equal(root.querySelector('[data-checklist-item]'), null);
  assert.doesNotMatch(root.body.textContent, /Recorded complete|Not recorded|0 due/);
  assert.deepEqual(value, before);
  assert.match(renderDealChecklist(checklist), /Attorney review/);
});

for (const [name, patch] of Object.entries({
  'array status': { status: ['complete'] },
  'object status': { status: { toString: null } },
  'object evidence': { evidence_ref: { toString: null } },
  'object source version': { source: { document: 'kit', version: { toString: null } } },
  'object source document with valid request': { source: { document: { toString: null }, request: 'valid' } },
})) test(`malformed scalar hides checklist evidence: ${name}`, () => {
  const value = JSON.parse(JSON.stringify(checklist));
  Object.assign(value.phases[0].items[0], patch);
  const root = new JSDOM(renderDealChecklist(value)).window.document;
  assert.equal(root.querySelector('[role="status"]')?.textContent, 'Checklist unavailable.');
  assert.equal(root.querySelector('[data-refresh-detail]').textContent, 'Refresh deal');
  assert.equal(root.querySelector('[data-checklist-item]'), null);
  assert.doesNotMatch(root.body.textContent, /Recorded complete|Received|Demo contract clause 3/);
});

for (const status of [['complete'], { toString: null }, 1, true, null]) {
  test(`malformed due status hides the due summary: ${JSON.stringify(status)}`, () => {
    const value = JSON.parse(JSON.stringify(checklist));
    value.due_items[0].status = status;
    const root = new JSDOM(renderDealChecklist(value)).window.document;
    assert.equal(root.querySelector('[role="status"]')?.textContent, 'Checklist unavailable.');
    assert.equal(root.querySelector('.checklist-next'), null);
    assert.doesNotMatch(root.body.textContent, /Recorded complete/);
  });
}
