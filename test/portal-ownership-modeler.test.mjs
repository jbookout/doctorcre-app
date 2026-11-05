import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/ui/portal/ownership-model.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const model = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const pkg = JSON.parse(await readFile(new URL('./fixtures/ownership/example-health.market-study.json', import.meta.url)));
const property = pkg.properties[0];
const defaults = () => model.defaultScenario(pkg.ownership, property);
test('published eligibility uses program minimums and rejects unavailable, non-building and income-only options', () => {
 assert.deepEqual(model.ownershipChoices(pkg).map(p => p.id), [property.id]);
 for (const patch of [{ tenure:'Leasehold' }, { offering:'Condo suite' }, { total_sf:1000 }, { contiguous_sf:1000 }, { available_sf:0 }]) {
  assert.equal(model.ownershipChoices({ ...pkg, properties:[{ ...property, ownership:{...property.ownership,...patch} }] }).length,0);
 }
 assert.deepEqual(model.ownershipChoices({...pkg,ownership:undefined}),[]);
});
test('zero-interest mortgage and year-one cash match hand calculation without intermediate rounding', () => {
 const s={...defaults(),rate:0}; const result=model.calculateScenario(pkg.ownership,property,s);
 assert.equal(result.kind,'valid'); const r=result.value;
 assert.equal(r.practiceSf,1500); assert.equal(r.outsideSf,3500);
 assert.equal(r.loan,800000); assert.equal(r.monthlyPayment,800000/300);
 assert.equal(r.points[1].rentCollected,39900);
 assert.equal(r.points[1].cashContributed,200000+90000+3500*20+32000-39900);
 assert.ok(Math.abs(r.points[10].balance-480000)<0.000001);
 assert.equal(model.formatMoney(1.005),'$1.01');
});
test('zero collection, zero financing, paid-off term, and no outside area stay finite', () => {
 for(const patch of [{collection_pct:0},{financed_pct:0},{years:1},{share:100},{rate:100},{rate:1e-12}]) {
 const r=model.calculateScenario(pkg.ownership,property,{...defaults(),...patch});
 assert.equal(r.kind,'valid'); assert.ok(!/NaN|Infinity/.test(JSON.stringify(r)));
 for(const point of r.value.points) for(const value of Object.values(point)) assert.ok(Number.isFinite(value));
 }
 const r=model.calculateScenario(pkg.ownership,property,{...defaults(),collection_pct:0}); assert.equal(r.value.points[10].rentCollected,0);
});
test('invalid draft blocks results and correction, property choice and reset restore valid defaults', () => {
 for(const [field,value] of [['rate',''],['rate','Infinity'],['rate','bad'],['rate','-1'],['years','1.5'],['share','29'],['price','0'],['financed_pct','101'],['lease_up_months','-1'],['price','1e300']]) {
 const r=model.calculateScenario(pkg.ownership,property,{...defaults(),[field]:value}); assert.equal(r.kind,'invalid',`${field} ${value}`);
 }
 let state=model.initialOwnershipState(pkg); state=model.ownershipTransition(pkg,state,{kind:'edit',field:'rate',value:''});
 assert.equal(model.calculateScenario(pkg.ownership,property,state.draft).kind,'invalid');
 state=model.ownershipTransition(pkg,state,{kind:'edit',field:'rate',value:'0'}); assert.equal(model.calculateScenario(pkg.ownership,property,state.draft).kind,'valid');
 state=model.ownershipTransition(pkg,state,{kind:'select',id:'absent'}); assert.equal(state.propertyId,property.id);
 state=model.ownershipTransition(pkg,state,{kind:'reset'}); assert.deepEqual(state,model.initialOwnershipState(pkg));
 assert.deepEqual(model.initialOwnershipState({...pkg,ownership:undefined}),{propertyId:null,draft:{},allocations:{}});
});
test('every financial assumption changes its dependent output and never mutates publication', () => {
 const snapshot=JSON.stringify(pkg); const base=model.calculateScenario(pkg.ownership,property,defaults()).value;
 for(const patch of [{price:1100000},{share:40},{financed_pct:70},{rate:7},{years:20},{rent_psf:30},{collection_pct:90},{buildout_psf:80},{lease_up_months:12},{appreciation_pct:3},{tenant_ti:50},{practice_lease_rate:30},{lease_buildout_psf:80}]) {
 const next=model.calculateScenario(pkg.ownership,property,{...defaults(),...patch}); assert.equal(next.kind,'valid'); assert.notDeepEqual(next.value,base);
 }
 assert.equal(JSON.stringify(pkg),snapshot);
});
test('allocations remain independent across properties and reset to publication',()=>{
 const second={...property,id:'second'}; const publication={...pkg,properties:[property,second]};
 let state=model.initialOwnershipState(publication);
 state=model.ownershipTransition(publication,state,{kind:'allocate',id:'second',value:'40'});
 assert.equal(state.draft.share,30);
 assert.equal(state.allocations.second,'40');
 state=model.ownershipTransition(publication,state,{kind:'select',id:'second'});
 assert.equal(state.draft.share,'40');
 state=model.ownershipTransition(publication,state,{kind:'reset'});
 assert.deepEqual(state.allocations,{});
});
test('nonzero mortgage matches an independent high-precision amortization calculation',()=>{
 const r=model.calculateScenario(pkg.ownership,property,defaults());
 assert.equal(r.kind,'valid');
 assert.ok(Math.abs(r.value.monthlyPayment-5401.657290781117)<1e-8);
 assert.ok(Math.abs(r.value.points[10].balance-620090.8758172657)<1e-6);
 assert.equal(r.value.points.length,11);
 const p={...property,ownership:{...property.ownership,current_income_annual:12000}};
 const income=model.calculateScenario(pkg.ownership,p,{...defaults(),lease_up_months:12});
 assert.equal(income.value.points[1].rentCollected,11400);
 const noDelay=model.calculateScenario(pkg.ownership,p,{...defaults(),lease_up_months:0});
 assert.equal(noDelay.value.points[1].rentCollected,79800);
});

test('invalid drafts remain invalid until corrected, selected or reset',()=>{
 let state=model.initialOwnershipState(pkg);
 const transition=event=>{state=model.ownershipTransition(pkg,state,event);return model.calculateScenario(pkg.ownership,property,state.draft).kind;};
 assert.equal(transition({kind:'edit',field:'rate',value:''}),'invalid');
 assert.equal(transition({kind:'edit',field:'price',value:''}),'invalid');
 assert.equal(transition({kind:'select',id:property.id}),'valid');
 assert.equal(transition({kind:'edit',field:'rate',value:''}),'invalid');
 assert.equal(transition({kind:'reset'}),'valid');
});
