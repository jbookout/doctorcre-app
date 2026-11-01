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
    due_on: '2020-01-01', evidence_ref: 'attachment:synthetic-document',
    request: { status: 'fulfilled', satisfied: false }, source: { document: 'deal-room-kit', version: 1 } };
  const root = new JSDOM(renderDealChecklist({ ...checklist, due_items: [],
    phases: [{ id: 'legal', label: 'Legal', items: [received] }] })).window.document;
  const row = root.querySelector('[data-checklist-item="title_commitment"]');
  assert.equal(row.querySelector('strong').textContent, 'Received');
  assert.match(row.textContent, /attachment:synthetic-document/);
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
  assert.ok(contract.statuses.includes('received'));
  assert.match(contract.receipt_basis, /satisfied=false/);
});
