// Synthetic only. Never fetch business records from this fixture.
export const id = n => `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const lead = (n, fields = {}) => ({ id: id(n), party_id: id(100+n), registry_ref: `L-${n}`, base_version: 1,
  doctor_name: `Dr. Example ${n}`, city: 'Pensacola', state: 'FL', specialty: 'Dental', stage: 'new', score: 80-n,
  suppressed: false, owner: null, possible_clients: [], ...fields });
export const leads = [1,2,3,4,5,6,7].map(n => lead(n)).concat([
  lead(8,{stage:'qualified', city:'Gulf Breeze',score:89}), lead(9,{stage:'outreach_active'}),
  lead(10,{stage:'engaged', city:'Mobile',state:'AL',last_stage_move:{ event_id:id(500), from:'outreach_active', to:'engaged', automatic:true, reason:'reply received', evidence_date:'2026-10-01T10:00:00Z' }}),
  lead(11,{stage:'nurture_drip'}),lead(12,{stage:'opportunity'}),lead(13,{stage:'archived'}),
  lead(14,{stage:'do_not_contact',suppressed:true}),lead(15,{suppressed:true}),lead(16,{client_id:id(900)}),lead(17,{is_deal:true}),lead(18,{is_past_client:true}),
  lead(19,{possible_clients:[{client_id:id(901),name:'Example Client Match'}]}),lead(20,{owner:'example-partner'}),
]);
export const workspace = () => ({ schema_version:'lead-workspace.v1',generated_at:'2026-10-01T16:00:00Z',last_search_at:'2026-10-01T14:00:00Z',leads:structuredClone(leads.filter(row=>!row.suppressed)) });
export const detail = row => ({ ...row,phone:'+1-555-010-0000',email:'example@example.test',notes:'Planning a dental relocation.\n\nOriginal synthetic entry with room requirements.',est_lease_event:'2027-03-01',correspondence:[{id:id(600),kind:'email_in',occurred_at:'2026-10-01T10:00:00Z',summary:'Reply confirms interest in a tour.',detail:'Synthetic original email: please show available dental space.'},{id:id(601),kind:'meeting',occurred_at:'2026-09-30T12:00:00Z',summary:'Space plans discussed.',detail:'Synthetic calendar entry: 2,000 square feet.'}],stage_history:[{event_id:id(500),prior_stage:'outreach_active',stage:'engaged',occurred_at:'2026-10-01T10:00:00Z',reason:'Reply received'}] });
