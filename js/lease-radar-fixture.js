import { addMonths, radarToday } from './lease-radar-model.js';
// Synthetic, relative to the viewing day so the demonstration never ages out.
export function leaseRadarFixture(today = radarToday()) {
  const row = (i, months, overrides = {}) => ({id:`demo-lease-${i}`,client_id:`demo-client-${i}`,deal_id:null,
    client_name:`Demo Practice ${i}`,client_status:i % 2 ? 'past_client':'active_deal',client_status_label:i % 2 ? 'Past client':'Active deal',
    city:'Demo City',state:'FL',vertical:'dental',owner:i % 2 ? 'joe':'dell',owner_label:i % 2 ? 'Joe':'Dell',
    contact_state:'active',contact_state_until:null,expiration_on:months === null ? null:addMonths(today,months),
    commencement_on:addMonths(today,-36),executed_on:addMonths(today,-37),term_months:null,lease_status:'current',evidence_kind:'lease_abstract',
    options_note:'Demo entry: renewal option requires written notice. Confirm the notice deadline against the executed agreement.',evidence_ref:'Demo abstract, page 4',version:1,
    notice_on:months === null ? null:addMonths(today,Math.max(0,months-6)),notice_note:'Demo option notice',
    touch_eligible:i % 2 === 1,touch_id:`demo-touch-${i}`,touch_due_on:today,touch_summary:'Review renewal plans',touch_owner:i % 2 ? 'joe':'dell',...overrides});
  return {schema_version:'lease-radar.v1',actor:'joe',observed_at:new Date().toISOString(),window:{starts_on:today,ends_on:addMonths(today,24)},
    leases:[row(1,2),row(2,5),row(3,8),row(4,11),row(5,14),row(6,17),row(7,20),row(8,24),row(9,null,{lease_status:'legacy_unverified'}),row(10,null),row(11,4,{contact_state:'do_not_contact',touch_eligible:false})]};
}
