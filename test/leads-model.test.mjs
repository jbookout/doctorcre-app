import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_STAGES,FILTER_STAGES,eligibleLead,leadTitle,visibleLeads,hottestLeads,marketCounts,stageReview,undoReview } from '../js/leads-model.js';
import {marketFeatures} from '../js/leads-territory-map.js';
import {lead,leads,detail} from './leads-workspace-fixture.mjs';
test('six stages, filter-only archive, exact lifecycle exclusions, suppression everywhere',()=>{
 assert.deepEqual(BOARD_STAGES.map(x=>x[1]),['New','Qualified','Outreach Active','Engaged','Nurture','Opportunity']);
 assert.equal(FILTER_STAGES.length,7);
 for(const flag of ['suppressed','merged_into','deleted_at','client_id','linked_client','is_client','is_past_client','is_deal','deal_id']) assert.equal(eligibleLead(lead(1,{[flag]:true})),false,flag);
 assert.equal(visibleLeads(leads).length,14);assert.equal(visibleLeads(leads,{stage:'archived'}).length,1);assert.equal(visibleLeads(leads,{stage:'do_not_contact'}).length,0);
 assert.equal(visibleLeads([lead(1,{stage:'closed_lost'})])[0].id,lead(1).id);
 assert.equal(visibleLeads([lead(1,{stage:'closed_won'})]).length,0);
 assert.equal(eligibleLead(lead(1,{possible_clients:[{name:'Example'}]})),true);
});
test('title priority and smart titles discard referral decorations',()=>{
 assert.equal(leadTitle(lead(1,{doctor_name:'Dr. Example (via referral)',practice_name:'Practice'})),'Dr. Example');
 assert.equal(leadTitle({practice_name:'Example Practice',entity_name:'Entity'}),'Example Practice');
 assert.equal(leadTitle({entity_name:'Example Entity'}),'Example Entity');
 assert.equal(leadTitle({specialty:'Dental',city:'Gulf Breeze'}),'Dental startup in Gulf Breeze');
});
test('hottest five are unclaimed New sorted by existing score; no manufactured scores',()=>{
 assert.deepEqual(hottestLeads(leads).map(l=>l.id),[1,2,3,4,5].map(n=>lead(n).id));
 assert.equal(hottestLeads([lead(1,{score:null}),lead(2,{score:0})])[0].id,lead(2).id);
});
test('filters and market counts share exact eligibility; archive never adds to active figures',()=>{
 assert.equal(visibleLeads(leads,{market:'Mobile, AL'}).length,1);
 assert.equal(visibleLeads(leads,{search:'gulf'}).length,1);
 assert.equal(visibleLeads(leads,{owner:'example-partner'}).length,1);
 assert.equal(marketCounts(leads).reduce((n,g)=>n+g.count,0),14);
 assert.deepEqual(marketCounts(leads,{stage:'archived'}),marketCounts(leads));
 const features=marketFeatures([{key:'Exact',city:'Mobile',state:'AL',count:2},{key:'Unknown',city:'Atlantis',state:'FL',count:1}], [{name:'Mobile',state:'AL',id:'1',position:[-88,30]}]);
 assert.equal(features.features.length,1);assert.equal(features.features[0].properties.count,2);
});
test('Doc evidence checks mail and calendar before asking only unanswered questions; excludes future entries',()=>{
 const d=detail(lead(1)); const r=stageReview(d,'engaged',Date.parse('2026-10-01T16:00:00Z'));
 assert.equal(r.question,null);assert.equal(r.evidence.length,2);assert.equal(r.reason,'Reply received');
 assert.match(stageReview(d,'qualified').question,/qualified/);
 assert.match(stageReview(d,'archived').question,/ended/);
 assert.equal(stageReview(d,'engaged',Date.parse('2026-09-01')).evidence.length,0);
});
test('one-tap undo binds to latest automatic event, restores prior stage, rejects stale/reverted state',()=>{
 const l=leads.find(l=>l.stage==='engaged'); assert.equal(undoReview(l).stage,'outreach_active');assert.equal(undoReview(l).stage_review.undo_event_id,l.last_stage_move.event_id);
 assert.equal(undoReview({...l,last_stage_move:{...l.last_stage_move,from:'archived'}}).stage,'archived');
 assert.equal(undoReview({...l,stage:'nurture_drip'}),null);assert.equal(undoReview({...l,last_stage_move:{...l.last_stage_move,undone:true}}),null);
});

test('blocking 15: historical closed_lost presents as Nurture but Undo preserves the exact producer stage/event',()=>{
 const row=lead(99,{stage:'engaged',last_stage_move:{automatic:true,from:'closed_lost',to:'engaged',event_id:'synthetic-historical-event'}});
 assert.equal(undoReview(row)?.stage,'closed_lost');assert.equal(undoReview(row)?.stage_review.undo_event_id,'synthetic-historical-event');
});

test('blocking 16: suppressed Do Not Contact remains excluded and the active interface offers no unreachable filter',()=>{
 const row=lead(14,{stage:'do_not_contact',suppressed:true});assert.equal(eligibleLead(row),false);assert.deepEqual(visibleLeads([row],{stage:'do_not_contact'}),[]);
 assert.equal(FILTER_STAGES.some(([stage])=>stage==='do_not_contact'),false);
 assert.ok(leads.filter(row=>row.stage==='do_not_contact').every(row=>row.suppressed===true),'fixtures honor producer suppression constraint');
});

test('blocking 17: committed duplicate city/state labels never choose an arbitrary map point',async()=>{
 const {readFile}=await import('node:fs/promises');const places=JSON.parse(await readFile(new URL('../data/leads-market-locations.json',import.meta.url),'utf8'));
 const pair=places.filter(place=>['1277467','1277470'].includes(place.id));assert.equal(pair.length,2);
 const groups=[{key:`${pair[0].name}, FL`,city:pair[0].name,state:'FL',count:3}];
 assert.deepEqual(marketFeatures(groups,places).features,[]);assert.deepEqual(marketFeatures(groups,[...places].reverse()).features,[]);
 assert.equal(groups[0].count,3,'ambiguous markets keep their count in the list');
});
