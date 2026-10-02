import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, projectLeaseRadar, validLeaseRadar, pastClientTouches, radarToday } from '../js/lease-radar-model.js';
import { leaseRadarFixture } from '../js/lease-radar-fixture.js';
import { createLeaseRadarClient } from '../js/lease-radar-client.js';
const today='2026-10-01';
test('calendar horizon clamps leap day and month end; business day stays in Chicago on travelling devices',()=>{
  assert.equal(addMonths('2024-02-29',24),'2026-02-28');
  assert.equal(addMonths('2026-01-31',1),'2026-02-28');
  assert.equal(radarToday(new Date('2026-10-02T02:00:00Z')),'2026-10-01');
});
test('quarter timeline contains every recorded lease in full 24 months across past/current clients; missing dates remain separate',()=>{
  const payload=leaseRadarFixture(today), model=projectLeaseRadar(payload,{today});
  assert.equal(model.dated.length,9);assert.equal(model.gaps.length,2);
  assert.equal(model.quarters.length,9);assert.equal(model.quarters.flatMap(q=>q.leases).length,9);
  assert.equal(model.dated.at(-1).expiration_on,'2028-10-01');
  assert.deepEqual([...new Set(model.dated.map(r=>r.tone))],['urgent','soon','later']);
  assert.ok(model.dated.some(r=>r.client_status==='past_client'));
  assert.ok(model.dated.some(r=>r.client_status==='active_deal'));
  assert.equal(projectLeaseRadar(payload,{scope:'mine',today}).dated.length,5);
});
test('out-of-horizon, invalid dates, duplicate IDs, superseded and incomplete responses refuse coverage; empty is distinct',()=>{
  const p=leaseRadarFixture(today);
  for(const patch of [{expiration_on:'2028-10-02'},{expiration_on:'2026-09-30'},{expiration_on:'2027-02-30'},{lease_status:'superseded'}]){
    const bad=structuredClone(p);Object.assign(bad.leases[0],patch);assert.equal(validLeaseRadar(bad),false);
  }
  assert.equal(validLeaseRadar({...p,leases:[p.leases[0],p.leases[0]]}),false);
  assert.equal(validLeaseRadar({...p,window:{...p.window,ends_on:'2028-09-30'}}),false);
  assert.equal(projectLeaseRadar(p,{today:'2026-10-02'}),null);
  assert.equal(projectLeaseRadar({...p,leases:[]},{today}).dated.length,0);
});
test('Home consumes CARR touch eligibility, earliest due first, deduplicated, never guesses from expiration',()=>{
  const p=leaseRadarFixture(today);
  p.leases[0].touch_due_on='2026-09-28';
  p.leases[2].touch_due_on='2026-10-02';
  p.leases[4].touch_eligible=false;
  p.leases[6].touch_owner='dell';
  p.leases[8].touch_id=p.leases[0].touch_id;
  assert.deepEqual(pastClientTouches(p,{today}).map(r=>r.id),['demo-lease-1','demo-lease-7']);
  assert.deepEqual(pastClientTouches(p,{today,scope:'mine'}).map(r=>r.id),['demo-lease-1']);
  assert.equal(pastClientTouches(null,{today}),null);
});
test('HTTP seam is credentialed no-store read only; malformed/refused data cannot become fixture fallback',async()=>{
  const p=leaseRadarFixture(today);let called;
  const client=createLeaseRadarClient({fetchImpl:async(path,init)=>{called={path,init};return new Response(JSON.stringify(p));}});
  assert.deepEqual(await client.readLeaseRadar(),p);
  assert.equal(called.path,'/api/v1/business/leases');assert.equal(called.init.credentials,'same-origin');assert.equal(called.init.cache,'no-store');assert.equal(called.init.method,undefined);
  for(const response of [new Response('{}'),new Response('{}',{status:403})]) await assert.rejects(createLeaseRadarClient({fetchImpl:async()=>response}).readLeaseRadar());
});
