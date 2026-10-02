import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_SESSION_ROWS, BRANCH_SESSION_ROWS } from '../../js/example-sessions.js';

const pad = (i) => String(i).padStart(3, '0');
const expand = (entries) => entries.flatMap(([value, count]) => Array(count).fill(value));
const phases = expand([['research', 17], ['closed', 4], ['pending', 31], ['negotiation', 9],
  ['legal', 6], ['due_diligence', 5], ['closing', 1], ['site_selection', 1]]);
const types = expand([['relocation', 10], ['other', 12], ['startup', 36], ['additional_office', 11], ['purchase', 4], ['expansion', 1]]);
const segments = expand([['Dermatology', 2], ['Dental', 7], ['Veterinary', 16], [null, 49]]);
const account = (i) => ({ account_client_id: `example-account-${i}`, account_client_ref: `C-${950 + i}`,
  account_name: `Example Network ${i}`, account_owner: 'dell', open_deals: '15', attention_deals: '0',
  overdue_deals: '0', stale_deals: '15', last_review_at: null, parked_deals: '0' });
const charts = () => ({ actor: 'joe', deals: phases.map((phase, i) => ({
  id: `example-deal-${pad(i)}`, name: `Example Practice ${pad(i)}`, type: types[i], phase,
  owner: i < 35 ? 'dell' : i < 42 ? 'joe' : null, attention: false,
  next_date: i === 0 ? '2026-01-10' : null, next_step: `Example next step ${pad(i)}`,
  market: i < 40 ? 'Example Market' : null, segment: segments[i],
  client_id: `example-client-${pad(i)}`, client_ref: `C-${900 + i}`, client_name: `Example Client ${pad(i)}`,
  account_client_id: i >= 59 ? 'example-account-1' : null, account_client_ref: i >= 59 ? 'C-951' : null,
  account_name: i >= 59 ? 'Example Network 1' : null, account_owner: i >= 59 ? 'dell' : null,
  market_agent: null, last_touch: i < 14 ? '2026-01-01' : null, last_review_at: null,
  workspace_kind: i >= 59 ? 'national_account' : 'team', operating_state: i >= 71 ? 'parked' : 'active',
  parking_reason: i >= 71 ? 'waiting' : null, parking_note: i >= 71 ? 'Example waiting note' : null,
  parked_at: i >= 71 ? '2026-01-01T12:00:00Z' : null, parked_by: i >= 71 ? 'joe' : null,
  field_base: {},
})), accounts: [account(1), account(2), account(3)], open_session: null });

const organization = (i, refs) => ({ name: `Example Organization ${i}`, live_rows: 1, refs,
  retired_aliases: 0, retired_refs: [], retired_refs_truncated: false, live_as_role: 0,
  role_refs: [], all_retired: false });
const searchPayload = (i) => ({
  parties: [{ ref: `C-${980 + i}`, name: `Example Person ${i}`, kind: 'client', city: null,
    specialty: null, org_name: null, merged: false }],
  deals: [{ name: `Example Search Deal ${i}`, phase: 'pending', owner: null, client_ref: `C-${980 + i}` }],
  connections: [], organizations: [organization(i, [null]), organization(i + 2, [`C-${980 + i}`])],
  lead_client_links: [], deals_via_link: [],
  note: 'No retired aliases among these matches — every ref listed is live.',
});
const search = () => ({ schema: 'doctorcre-search-fixture.v1', captured: 'synthetic', verb: 'find',
  source: 'Synthetic examples in the pinned find contract shape.',
  why: 'Exercise nullable fields, null ref elements and six result groups without live records.',
  captures: [{ query: 'Pensacola', payload: searchPayload(1) }, { query: 'Dell', payload: searchPayload(2) }],
});
const noSpine = (id) => ({ ok: true, session_id: id, parent_session_id: null, permission_filtered: false,
  total_seen: 0, total_returned: 0, more: false, next_cursor: null, received: null,
  acknowledged: null, stage_unavailable_reason: 'no_dispatch_spine', events: [] });
const page = (sessions, total_seen = 603, total_returned = 124, permission_filtered = true) => ({
  ok: true, permission_filtered, total_seen, total_returned, sessions,
});
const event = (i, stage) => ({ event_id: `example-event-${i}`, at: '2026-01-01T12:00:00Z', stage,
  stage_evidence: 'Example recorded dispatch stage', rationale: 'Example rationale',
  from_seat: 'orchestrator', to_seat: i === 1 ? 'builder' : null, sponsor: i === 1 ? 'joe' : null,
  room_id: 'example-room', session_id: BRANCH_SESSION_ROWS[0].canonical_session_id,
  parent_session_id: null, attempt_ref: 'WR-000117#3', superseded_by: null, work_request_ref: 'WR-000117' });
const sessions = () => ({ schema: 'doctorcre-session-fixture.v1', captured: 'synthetic',
  source: 'Synthetic contract examples; shape reference 0f6cb388424e83a75396a3e2d3bfc14839e81b35.',
  why: 'Exercise permission totals, absent lineage, host availability and dispatch stages.',
  captures: [
    { verb: 'read-session-identity', args: {}, payload: page(EXAMPLE_SESSION_ROWS) },
    { verb: 'read-session-identity', args: { limit: 3 }, payload: page(EXAMPLE_SESSION_ROWS.slice(0, 3)) },
    { verb: 'read-session-identity', args: { query: 'reverent', limit: 5 }, payload: page([], 4, 0) },
    { verb: 'read-session-identity', args: { query: 'zzzznope' }, payload: page([], 0, 0, false) },
    { verb: 'read-dispatch-history', args: { session_id: 'example-session-000' }, payload: noSpine('example-session-000') },
    { verb: 'read-dispatch-history', args: { session_id: 'zzzznope' }, payload: noSpine('zzzznope') },
  ],
  synthetic_sessions: BRANCH_SESSION_ROWS.map((row) => ({ synthetic: true, reason: 'Exercise a lineage or host branch.', row })),
  synthetic_dispatch: { synthetic: true, reason: 'Exercise recorded dispatch and unavailable acknowledgement.',
    payload: { ...noSpine(BRANCH_SESSION_ROWS[0].canonical_session_id), total_seen: 3, total_returned: 3,
      more: true, next_cursor: 'example-cursor', events: [event(1, 'acted'), event(2, 'sent')] } },
  note_on_volatility: 'Fixture observations use fixed timestamps; ages in live responses are computed at READ time.',
});

export function generateFixtures() {
  return { 'charts-synthetic.json': charts(), 'search-synthetic.json': search(), 'session-identity.json': sessions() };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [file, payload] of Object.entries(generateFixtures())) {
    writeFileSync(new URL(`../../test/fixtures/${file}`, import.meta.url), JSON.stringify(payload, null, 2) + '\n');
  }
}
