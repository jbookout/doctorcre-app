import { useReducer, useState } from 'react';
import type { ReactNode } from 'react';
import { calculateScenario, defaultScenario, fieldNames, fields, formatMoney, initialOwnershipState, ownershipChoices, ownershipTransition } from './ownership-model';
import type { Calculation, Draft, Field, HoldingPoint, Ownership, OwnershipEvent, OwnershipPackage, OwnershipProperty, Rich } from './ownership-model';

const styles = `
.ownership{max-width:1200px;margin:auto;padding:1rem;background:var(--surface-1,#fff);color:var(--text-1,#243438);font:16px/1.5 var(--font-body,Arial,sans-serif)}
.ownership *{box-sizing:border-box}.ownership input,.ownership select,.ownership button{font:inherit;color:inherit;background:var(--surface-1,#fff);border:1px solid var(--hairline-strong,#7b8b90);border-radius:.35rem;min-height:44px;padding:.5rem;max-width:100%}
.ownership input:not([type=radio]):not([type=range]),.ownership select{width:100%}.ownership label{display:block}.ownership button,.ownership a{cursor:pointer}.ownership a{color:var(--accent,#17676f)}.ownership :focus-visible{outline:3px solid var(--accent,#17676f);outline-offset:3px}
.ownership-grid,.strategy-benefits{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:1rem}.ownership article,.ownership fieldset,.presentation-stage{border:1px solid var(--hairline-strong,#7b8b90);border-radius:.6rem;padding:1rem;margin:1rem 0;min-width:0}
.ownership-scroll{overflow:auto}.ownership table{border-collapse:collapse;width:100%;min-width:520px}.ownership th,.ownership td{text-align:left;padding:.7rem;border-bottom:1px solid var(--hairline-strong,#7b8b90)}.ownership th:first-child{min-width:170px}.ownership svg{width:100%;height:auto}.ownership .coverage-row{display:block;margin:.6rem 0;width:100%;text-align:left}.ownership progress{width:100%;accent-color:var(--accent,#17676f)}
.ownership .ti-toggle{display:flex;flex-wrap:wrap;gap:1rem}.ownership .ti-toggle label{display:flex;align-items:center;gap:.3rem}.ownership [role=alert]{padding:1rem;border:2px solid currentColor}.ownership h2{font-size:1.4rem}.ownership p{overflow-wrap:anywhere}
[data-theme=dark] .ownership{--surface-1:#172126;--text-1:#edf0f1;--hairline-strong:#65767f;--accent:#86d7d3}
`;
function RichCopy({ value }: { value: Rich }) {
  return <p>{value.map((run,index) => 'text' in run ? <span key={index}>{run.text} </span> : /^https:\/\//i.test(run.link.url) ? <a key={index} href={run.link.url} target="_blank" rel="noopener noreferrer">{run.link.label}</a> : <span key={index}>{run.link.label}</span>)}</p>;
}
type Props = { publication: OwnershipPackage; onOpenProperty?: (id: string) => void };
type Result = { property: OwnershipProperty; value: Extract<Calculation,{kind:'valid'}>['value'] };
type Row = { label: string; value: (result: Result) => ReactNode };
function ResultsTable({ id, title, results, rows, open }: { id: string; title: string; results: Result[]; rows: Row[]; open: Props['onOpenProperty'] }) {
  return <div className="ownership-scroll" tabIndex={0} aria-label={`${title}, scroll horizontally`}><table id={id}><caption>{title}</caption><thead><tr><th scope="col">Metric</th>{results.map(r => <th scope="col" key={r.property.id}><a href="#purchases" onClick={event => {if(open){event.preventDefault();open(r.property.id);}}}>{r.property.number}. {r.property.address}</a></th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{results.map(result => <td key={result.property.id}>{row.value(result)}</td>)}</tr>)}</tbody></table></div>;
}
const last = (r: Result) => r.value.points[10];
function moneyPoint(key: keyof HoldingPoint, year: number) { return (r: Result) => formatMoney(r.value.points[year]?.[key] ?? 0); }
const comparison: Row[] = [
  {label:'Purchase price',value:r=>formatMoney(r.value.scenario.price)},
  {label:'Building area',value:r=>`${r.property.ownership?.total_sf.toLocaleString()} SF`},
  {label:'Practice area',value:r=>`${r.value.practiceSf.toLocaleString()} SF`},
  {label:'Outside area',value:r=>`${r.value.outsideSf.toLocaleString()} SF`},
  {label:'Acquisition loan',value:r=>formatMoney(r.value.loan)},
  {label:'Down payment',value:r=>formatMoney(r.value.scenario.price-r.value.loan)},
  {label:'Monthly debt payment',value:r=>formatMoney(r.value.monthlyPayment)},
  {label:'Full outside annual rent before collection',value:r=>formatMoney(r.value.annualOutsideRent)},
  {label:'First-year outside collections',value:moneyPoint('rentCollected',1)},
  {label:'Practice buildout',value:r=>formatMoney(r.value.buildout)},
  {label:'Outside tenant allowance',value:r=>formatMoney(r.value.tenantAllowance)},
  {label:'Acquisition cash',value:r=>formatMoney(r.value.upfrontCash)},
  {label:'First-year cash carry',value:r=>formatMoney((r.value.points[1]?.cashContributed??0)-r.value.upfrontCash)},
];
const carry: Row[] = [
  {label:'Down payment',value:r=>formatMoney(r.value.scenario.price-r.value.loan)},
  {label:'Practice buildout',value:r=>formatMoney(r.value.buildout)},
  {label:'Outside tenant allowance',value:r=>formatMoney(r.value.tenantAllowance)},
  {label:'Initial cash',value:r=>formatMoney(r.value.upfrontCash)},
  {label:'First-year debt service',value:moneyPoint('debtService',1)},
  {label:'First-year collected rent',value:moneyPoint('rentCollected',1)},
  {label:'First-year carry / surplus',value:r=>formatMoney((r.value.points[1]?.debtService??0)-(r.value.points[1]?.rentCollected??0))},
  {label:'Cash contributed through year one',value:moneyPoint('cashContributed',1)},
];
const outcome: Row[] = [
  {label:'Building value',value:moneyPoint('value',10)},
  {label:'Loan balance',value:moneyPoint('balance',10)},
  {label:'Equity',value:moneyPoint('equity',10)},
  {label:'Cumulative cash contributed',value:moneyPoint('cashContributed',10)},
  {label:'Equity less contributed cash',value:moneyPoint('netPosition',10)},
];
const lease: Row[] = [
  {label:'Practice annual lease rent',value:r=>formatMoney(r.value.practiceSf*r.value.scenario.practice_lease_rate)},
  {label:'Lease buildout cash',value:r=>formatMoney(r.value.practiceSf*r.value.scenario.lease_buildout_psf)},
  {label:'Ten-year lease cost',value:moneyPoint('leaseCost',10)},
  {label:'Ten-year ownership contributions',value:moneyPoint('cashContributed',10)},
  {label:'Ten-year ownership equity',value:moneyPoint('equity',10)},
  {label:'Lease cost less ownership contributions plus equity',value:r=>formatMoney((last(r)?.leaseCost??0)-(last(r)?.cashContributed??0)+(last(r)?.equity??0))},
];
function Input({field,draft,edit,id}: {field: Field;draft: Draft;edit:(field:Field,value:string)=>void;id?:string}) {
  const rule=fields[field];
  const [focused,setFocused]=useState(false);
  const value=draft[field]??'';
  const numeric=Number(value);
  const display=!focused&&String(value).trim()&&Number.isFinite(numeric)&&rule.label.includes('$')?String(Math.round((numeric+Number.EPSILON)*100)/100):value;
  return <label>{rule.label}<input id={id} name={field} type="number" min={rule.min} max={rule.max} step={'integer' in rule ? 1 : 'any'} value={display} onChange={e=>edit(field,e.target.value)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} /></label>;
}
function TIToggles({ ownership, draft, edit, name }: {ownership:Ownership;draft:Draft;edit:(field:Field,value:string)=>void;name:string}) {
  return <fieldset className="ti-toggle"><legend>Outside tenant allowance options</legend>{ownership.defaults.ti_options.map((amount,index)=><label key={index}><input type="radio" name={name} value={amount} checked={Number(draft.tenant_ti)===amount} onChange={()=>edit('tenant_ti',String(amount))}/>{formatMoney(amount)}/SF</label>)}</fieldset>;
}
type ChartSeries = {name:string;key:keyof HoldingPoint;color:string};
function HoldingChart({ result, view }: {result:Result;view:string}) {
  const series:[ChartSeries,ChartSeries]=view==='lease' ? [{name:'Lease cost',key:'leaseCost',color:'#977036'},{name:'Ownership cash contributed',key:'cashContributed',color:'#34828a'}] : [{name:'Equity',key:'equity',color:'#34828a'},{name:'Cash contributed',key:'cashContributed',color:'#977036'}];
  const values=result.value.points.flatMap(p=>series.map(s=>p[s.key]));
  const low=Math.min(0,...values),high=Math.max(1,...values),range=high-low;
  const crossing=result.value.points.find(p=>p[series[0].key]>=p[series[1].key]);
  return <><p id="ownership-line-legend">{series.map(s=>s.name).join(' / ')}</p><svg id="ownership-line-chart" viewBox="0 0 620 280" role="img" aria-label={`${result.property.address} ${series.map(s=>s.name).join(' and ')} by year`}><text x="8" y="16" fill="currentColor">{formatMoney(high)}</text><text x="8" y="270" fill="currentColor">Years 0 to 10 · minimum {formatMoney(low)}</text>{series.map(s=><polyline key={s.key} fill="none" stroke={s.color} strokeWidth="3" points={result.value.points.map(p=>`${20+p.year*58},${240-(p[s.key]-low)/range*210}`).join(' ')}/>)}</svg><p id="line-summary">{crossing?`First annual crossing at year ${crossing.year}.`:'No crossing in the ten-year illustration.'} Annual points only. Assumptions are not guaranteed outcomes.</p></>;
}
export function OwnershipModeler(props: Props) {
  if(!props.publication.ownership)return null;
  return <Modeler key={JSON.stringify(props.publication)} {...props} ownership={props.publication.ownership}/>;
}
function Modeler({publication,ownership,onOpenProperty}:Props & {ownership:Ownership}) {
  const [state,dispatch]=useReducer((state:ReturnType<typeof initialOwnershipState>,event:OwnershipEvent)=>ownershipTransition(publication,state,event),publication,initialOwnershipState);
  const [year,setYear]=useState(10);
  const [view,setView]=useState('equity');
  const [lineProperty,setLineProperty]=useState(state.propertyId);
  const choices=ownershipChoices(publication);
  const property=choices.find(p=>p.id===state.propertyId);
  if(!property)return <section id="strategy" className="ownership"><style>{styles}</style><p>{ownership.copy.intro}</p><h2>No eligible ownership properties</h2><p>Confirm tenure, offering, price and contiguous available space before modelling.</p><RichCopy value={ownership.copy.methods}/></section>;
  const edit=(field:Field,value:string)=>dispatch({kind:'edit',field,value});
  const selected=calculateScenario(ownership,property,state.draft);
  const results:Result[]=choices.flatMap(p=>{
    const draft=p.id===property.id?state.draft:{...defaultScenario(ownership,p),...state.draft,price:p.ownership?.asking_price??0,share:state.allocations[p.id]??defaultScenario(ownership,p).share??0};
    const calc=calculateScenario(ownership,p,draft);
    return calc.kind==='valid'?[{property:p,value:calc.value}]:[];
  });
  const chartResult=results.find(r=>r.property.id===lineProperty)??results[0];
  const inputIds:Partial<Record<Field,string>>={tenant_ti:'tenant-ti',practice_lease_rate:'practice-lease-rate',lease_buildout_psf:'practice-lease-buildout'};
  return <section id="strategy" className="ownership" aria-label="Ownership illustration"><p>{ownership.copy.intro}</p><style>{styles}</style>
    <h2>1. Understand the ownership structure</h2><p>Practice minimum {ownership.program.min_share*100}% and {ownership.program.min_sf.toLocaleString()} SF.</p><div className="strategy-benefits">{ownership.copy.benefits.map((b,i)=><article key={i}><h3>{b.title}</h3><p>{b.body}</p></article>)}</div>
    <p>Scenario edits stay in this browser page's memory. Reload restores published defaults. Nothing is saved to CARR.</p>
    <h2>2. Choose space and compare ownership</h2>
    <label>Scenario property<select id="ownership-property" value={property.id} onChange={e=>dispatch({kind:'select',id:e.target.value})}>{choices.map(p=><option key={p.id} value={p.id}>{p.number}. {p.address}</option>)}</select></label>
    <p>Selected property {property.address}. {property.summary}</p><p>{property.ownership?.tenure} · {property.ownership?.offering} · {property.ownership?.current_occupancy??'Occupancy not supplied'} · Existing annual income {formatMoney(property.ownership?.current_income_annual??0)}.</p>
    <fieldset className="ownership-assumptions"><legend>Shared assumptions</legend><div className="ownership-grid">{(['financed_pct','rate','years','rent_psf','collection_pct','appreciation_pct'] satisfies Field[]).map(field=><Input key={field} field={field} id={`assumption-${field==='financed_pct'?'financed':field}`} draft={state.draft} edit={edit}/>)}</div></fieldset>
    <p id="shared-assumption-note">Comparison properties use their published asking prices and the scenario's other assumptions. An unavailable comparison is omitted when its space cannot meet these inputs.</p>
    <form id="ownership-form" noValidate onSubmit={e=>e.preventDefault()}><div className="ownership-grid">{fieldNames.map(field=><Input key={field} field={field} {...(inputIds[field]?{id:inputIds[field]}:{})} draft={state.draft} edit={edit}/>)}</div><label>Practice area (SF)<input readOnly value={selected.kind==='valid'?selected.value.practiceSf:'Unavailable until inputs are valid'}/></label><button type="submit">Calculate</button>{' '}<button type="button" onClick={()=>dispatch({kind:'reset'})}>Restore published defaults</button></form>
    <div id="ownership-message" role={selected.kind==='invalid'?'alert':'status'}>{selected.kind==='invalid'?<ul>{selected.errors.map(error=><li key={error}>{error}</li>)}</ul>:'Illustration recalculates as you edit. All figures use the assumptions below.'}</div>
    <TIToggles ownership={ownership} draft={state.draft} edit={edit} name="ti-primary"/>
    {selected.kind==='valid'&&<><div id="ownership-allocation" className="allocation-card"><h3>Practice and outside allocation</h3>{choices.map(p=><label className="allocation-space-row" key={p.id}>{p.address} practice occupancy (%)<input data-property-occupancy={p.id} type="number" min={ownership.program.min_share*100} max="100" step="any" value={p.id===property.id?state.draft.share??'':state.allocations[p.id]??defaultScenario(ownership,p).share??''} onChange={e=>dispatch({kind:'allocate',id:p.id,value:e.target.value})}/></label>)}<progress max="100" value={selected.value.scenario.share} aria-label="Practice share"/><p>{selected.value.practiceSf.toLocaleString()} SF practice · {selected.value.outsideSf.toLocaleString()} SF outside.</p></div>
    <article className="visual-card"><h3>Payment and outside rent</h3><div id="coverage-chart">{results.map(r=><button key={r.property.id} type="button" className="coverage-row" onClick={()=>onOpenProperty?.(r.property.id)}>{r.property.address} · monthly payment {formatMoney(r.value.monthlyPayment)} · full monthly outside collections {formatMoney(r.value.annualOutsideRent*r.value.scenario.collection_pct/1200)}</button>)}</div></article>
    <div className="presentation-stage"><ResultsTable id="ownership-comparison" title="Ownership comparison" results={results} rows={comparison} open={onOpenProperty}/><h3>What stands out</h3><div className="strategy-highlights">{results.map(r=><button type="button" className="strategy-property" key={r.property.id} onClick={()=>onOpenProperty?.(r.property.id)}>{r.property.address} · {r.property.summary}</button>)}</div></div>
    <div className="presentation-stage"><h2>3. See the cash carry</h2><TIToggles ownership={ownership} draft={state.draft} edit={edit} name="ti-carry"/><p id="ti-budget">Outside TI budget {formatMoney(selected.value.tenantAllowance)}.</p><ResultsTable id="ownership-carry-table" title="Cash carry" results={results} rows={carry} open={onOpenProperty}/></div>
    <div className="presentation-stage"><h2>4. See the holding-period outcome</h2><label>Chart view<select id="line-view" value={view} onChange={e=>setView(e.target.value)}><option value="equity">Equity and contributed cash</option><option value="lease">Ownership and leasing</option></select></label><label>Chart property<select id="line-property" value={chartResult?.property.id??''} onChange={e=>setLineProperty(e.target.value)}>{results.map(r=><option key={r.property.id} value={r.property.id}>{r.property.address}</option>)}</select></label>{chartResult&&<HoldingChart result={chartResult} view={view}/>}
    <label>Equity year<input id="equity-year" type="range" min="0" max="10" step="1" value={year} onChange={e=>setYear(Number(e.target.value))}/></label><p id="equity-year-label">Year {year}</p><div id="equity-chart">{results.map(r=><p key={r.property.id}>{r.property.address} equity {formatMoney(r.value.points[year]?.equity??0)}<progress max={Math.max(1,...results.map(r=>r.value.points[year]?.value??0))} value={Math.max(0,r.value.points[year]?.equity??0)} aria-label={`${r.property.address} equity`}/></p>)}</div>
    <ResultsTable id="ownership-outcome-table" title="Ten-year outcome" results={results} rows={outcome} open={onOpenProperty}/><ResultsTable id="ownership-lease-table" title="Ownership versus leasing" results={results} rows={lease} open={onOpenProperty}/></div></>}
    <div className="strategy-disclosures"><h2>Assumptions and methods</h2><RichCopy value={ownership.copy.notes}/><RichCopy value={ownership.copy.methods}/><p>Financing covers acquisition only. Practice buildout and outside tenant allowance are paid in cash at acquisition. Fixed monthly payments amortize acquisition debt. Zero interest divides principal by term. During the lease-up delay, published existing income is capped at modelled full outside rent. After the delay, the outside area earns modelled rent. Collection applies in both periods. Appreciation compounds annually. Contributions are initial cash plus debt service less collected outside rent. Leasing includes practice rent and lease buildout.</p><p>Operating expenses, taxes, sale costs and rent escalation are excluded. These are illustrations, not return guarantees. Negative cash carry means a surplus. Currency rounds only for presentation. Initial practice share follows the published minimum area and percentage. TI starts at the first published option. Practice lease rent and lease buildout start at the published outside rent and practice buildout defaults.</p></div>
  </section>;
}
