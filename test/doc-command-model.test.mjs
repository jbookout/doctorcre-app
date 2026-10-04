import test from 'node:test';
import assert from 'node:assert/strict';
import { docShortcut, shortcutPlatform, interpretCommand, resolvePhase, commandResults } from '../js/doc-command-model.js';

const key = (key, mods = {}) => ({ key, code: `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, ...mods });

test('Cmd+D and Cmd+K open Doc on a Mac; Ctrl is left to text editing there', () => {
  assert.equal(docShortcut(key('d', { metaKey: true }), 'mac'), true);
  assert.equal(docShortcut(key('k', { metaKey: true }), 'mac'), true);
  assert.equal(docShortcut(key('D', { metaKey: true }), 'mac'), true);
  assert.equal(docShortcut(key('d', { ctrlKey: true }), 'mac'), false);
  assert.equal(docShortcut(key('d', { metaKey: true, shiftKey: true }), 'mac'), false);
  assert.equal(docShortcut(key('d', { metaKey: true, altKey: true }), 'mac'), false);
  assert.equal(docShortcut(key('d', { metaKey: true, isComposing: true }), 'mac'), false);
  assert.equal(docShortcut(key('d', { metaKey: true, repeat: true }), 'mac'), false);
  assert.equal(docShortcut(key('e', { metaKey: true }), 'mac'), false);
});

test('the platform comes from client hints or the legacy platform string', () => {
  assert.equal(shortcutPlatform({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), 'mac');
  assert.equal(shortcutPlatform({ platform: 'MacIntel' }), 'mac');
  assert.equal(shortcutPlatform({ platform: 'iPad' }), 'mac');
  assert.equal(shortcutPlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), 'other');
  assert.equal(shortcutPlatform({ platform: 'Linux x86_64' }), 'other');
});

test('Ctrl+D and Ctrl+K open Doc on Windows and Linux', () => {
  assert.equal(docShortcut(key('d', { ctrlKey: true }), 'other'), true);
  assert.equal(docShortcut(key('k', { ctrlKey: true }), 'other'), true);
  assert.equal(docShortcut(key('d', { metaKey: true }), 'other'), false);
});

test('a Command key alone, held or tapped, never opens Doc, so system dictation keeps it', () => {
  for (const code of ['MetaRight', 'MetaLeft']) {
    assert.equal(docShortcut({ key: 'Meta', code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false }, 'mac'), false);
    assert.equal(docShortcut({ key: 'Meta', code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: true }, 'mac'), false);
  }
  // A non-Latin layout still reports the physical D key.
  assert.equal(docShortcut({ key: 'в', code: 'KeyD', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false }, 'mac'), true);
});

test('plain words resolve to a move, a payment, a tour, or a search', () => {
  assert.deepEqual(interpretCommand('move the Gulf Breeze startup to LOI'), { type: 'move', target: 'Gulf Breeze startup', phase: 'Negotiation' });
  assert.deepEqual(interpretCommand('Advance Demo Vision Center into closing'), { type: 'move', target: 'Demo Vision Center', phase: 'Closing' });
  assert.deepEqual(interpretCommand('move demo dental north to due diligence'), { type: 'move', target: 'demo dental north', phase: 'Diligence' });
  assert.deepEqual(interpretCommand('mark Demo Oak Purchase paid'), { type: 'paid', target: 'Demo Oak Purchase' });
  assert.deepEqual(interpretCommand('mark the Oak Purchase invoice as paid'), { type: 'paid', target: 'Oak Purchase' });
  assert.deepEqual(interpretCommand('plan a tour for Dr. Example'), { type: 'tour', target: 'Dr. Example' });
  assert.deepEqual(interpretCommand('Schedule tour with Demo Pensacola Orthopedic Partners'), { type: 'tour', target: 'Demo Pensacola Orthopedic Partners' });
  assert.deepEqual(interpretCommand('  pensacola  '), { type: 'search', query: 'pensacola' });
  // An unknown phase is not a move; it stays an ordinary search.
  assert.deepEqual(interpretCommand('move Demo Dental North to Mars'), { type: 'search', query: 'move Demo Dental North to Mars' });
  assert.equal(interpretCommand('   ').type, 'empty');
});

test('phase words include the wire value, the display label and the deal-room trigger', () => {
  assert.equal(resolvePhase('LOI'), 'Negotiation');
  assert.equal(resolvePhase('letter of intent'), 'Negotiation');
  assert.equal(resolvePhase('Negotiating'), 'Negotiation');
  assert.equal(resolvePhase('site selection'), 'Site selection');
  assert.equal(resolvePhase('Prospective Client'), 'On Deck');
  assert.equal(resolvePhase('lease'), 'Legal');
  assert.equal(resolvePhase('closed'), 'Closed');
  assert.equal(resolvePhase('nowhere'), null);
});

const pages = [{ label: 'Home', href: '/' }, { label: 'Local Deals', href: '/deals' }, { label: 'Tours', href: '/tours' }, { label: 'Invoices', href: '/invoices' }];
const deals = [
  { id: 'd30', name: 'Demo Gulf Breeze Dental', type: 'Startup', phase: 'Research', market: 'Demo City', field_base: { phase: { id: 'e-9', recorded_at: '2026-01-01T00:00:00Z' } } },
  { id: 'd31', name: 'Demo Gulf Breeze Vision', type: 'Relocation', phase: 'On Deck', market: 'Demo City', field_base: {} },
  { id: 'd04', name: 'Demo Vision Center', type: 'Purchase', phase: 'Legal', market: 'Test Harbor' },
];
const parties = { parties: [
  { name: 'Demo Pensacola Family Dentistry', kind: 'lead', merged: false },
  { name: 'Demo Pensacola Orthopedic Partners', kind: 'client', merged: false },
  { name: 'Demo Pensacola Buildout Contractors', kind: 'vendor', merged: false },
  { name: 'Demo Pensacola Smiles (retired alias)', kind: 'lead', merged: true },
] };
const tours = [{ id: 't1', name: 'Demo Pensacola dental tour', status: 'draft' }];
const invoices = [
  { commission_id: 'c-2', name: 'Demo Oak Purchase', status: 'invoiced', base_version: 1, gross_amount: '18500' },
  { commission_id: 'c-5', name: 'Demo River Renewal', status: 'received', base_version: 2, gross_amount: '6500' },
];

test('search returns typed records and pages; Enter on a record opens it, never acts', () => {
  const rows = commandResults({ text: 'pensacola', pages, deals, parties, tours, invoices });
  assert.deepEqual(rows.map(row => [row.kind, row.label]), [
    ['lead', 'Demo Pensacola Family Dentistry'],
    ['client', 'Demo Pensacola Orthopedic Partners'],
    ['vendor', 'Demo Pensacola Buildout Contractors'],
    ['tour', 'Demo Pensacola dental tour'],
  ]);
  assert.ok(rows.every(row => row.href && !row.action));
  assert.equal(rows.find(row => row.kind === 'lead').href, '/search?q=Demo+Pensacola+Family+Dentistry');
  assert.equal(rows.find(row => row.kind === 'client').href, '/clients?q=Demo%20Pensacola%20Orthopedic%20Partners');
  assert.equal(rows.find(row => row.kind === 'tour').href, '/tours?tour=t1');
  const deal = commandResults({ text: 'gulf breeze dental', pages, deals, parties: null, tours, invoices });
  assert.deepEqual(deal.map(row => [row.kind, row.href]), [['deal', '/deals?deal=d30']]);
  assert.deepEqual(commandResults({ text: 'deals', pages, deals:[], parties:null, tours:[], invoices:[] }).map(row => [row.kind, row.href]), [['page', '/deals']]);
});

test('an internal move is one direct action against the exact deal and its phase base', () => {
  const [row, ...rest] = commandResults({ text: 'move the Gulf Breeze startup to LOI', pages, deals, parties: null, tours, invoices });
  assert.equal(rest.length, 0);
  assert.equal(row.kind, 'action');
  assert.equal(row.label, 'Move Demo Gulf Breeze Dental to Negotiating');
  assert.deepEqual(row.action, { verb: 'move', deal: 'd30', name: 'Demo Gulf Breeze Dental', from: 'Research', to: 'Negotiation', base_event_id: 'e-9', approval: 'direct' });
});

test('an ambiguous target lists every candidate and never picks one', () => {
  const rows = commandResults({ text: 'move gulf breeze to legal', pages, deals, parties: null, tours, invoices });
  assert.deepEqual(rows.map(row => row.action.deal), ['d30', 'd31']);
  assert.equal(rows[1].action.base_event_id, null);
});

test('closing a deal and recording money always stage for one-tap approval', () => {
  const [close] = commandResults({ text: 'move demo vision center to closed', pages, deals, parties: null, tours, invoices });
  assert.equal(close.action.approval, 'one-tap');
  const [paid, ...none] = commandResults({ text: 'mark oak purchase paid', pages, deals, parties: null, tours, invoices, today: '2026-10-03' });
  assert.equal(none.length, 0);
  assert.deepEqual(paid.action, { verb: 'paid', commission_id: 'c-2', name: 'Demo Oak Purchase', amount: '18500', base_version: 1, received_on: '2026-10-03', approval: 'one-tap' });
  assert.deepEqual(commandResults({ text: 'mark river renewal paid', pages, deals, parties: null, tours, invoices }), []);
});

test('a moved deal already in that phase offers no move', () => {
  assert.deepEqual(commandResults({ text: 'move demo vision center to lease', pages, deals, parties: null, tours, invoices }), []);
});

test('tour planning opens the planner for the named person', () => {
  const [row] = commandResults({ text: 'plan a tour for Dr. Example', pages, deals, parties: null, tours, invoices });
  assert.equal(row.kind, 'action');
  assert.equal(row.label, 'Plan a tour for Dr. Example');
  assert.equal(row.href, '/tours?plan_for=Dr.%20Example');
});
