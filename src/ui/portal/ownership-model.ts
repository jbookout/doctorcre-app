export type Rich = readonly ({ text: string } | { link: { label: string; url: string } })[];
export type Ownership = {
  program: { min_share: number; min_sf: number };
  defaults: { financed_pct: number; rate: number; years: number; rent_psf: number; collection_pct: number; buildout_psf: number; lease_up_months: number; appreciation_pct: number; ti_options: readonly number[] };
  default_property: string;
  copy: { intro: string; benefits: readonly { title: string; body: string }[]; notes: Rich; methods: Rich };
};
export type OwnershipProperty = {
  id: string; number: number; address: string; role: 'candidate' | 'market-context'; summary: string;
  ownership?: { total_sf: number; asking_price: number; tenure: string; offering: string; contiguous_sf: number; available_sf?: number; current_occupancy?: string; current_income_annual?: number };
};
export type OwnershipPackage = { properties: readonly OwnershipProperty[]; ownership?: Ownership };
export const fields = {
  price: { label: 'Purchase price ($)', min: 0.01, max: 1e10 },
  share: { label: 'Practice occupancy (%)', min: 0, max: 100 },
  financed_pct: { label: 'Financed (%)', min: 0, max: 100 },
  rate: { label: 'Annual interest (%)', min: 0, max: 100 },
  years: { label: 'Amortization (years)', min: 1, max: 50, integer: true },
  rent_psf: { label: 'Outside annual rent ($/SF)', min: 0, max: 1e6 },
  collection_pct: { label: 'Rent collection (%)', min: 0, max: 100 },
  buildout_psf: { label: 'Practice buildout ($/SF)', min: 0, max: 1e6 },
  lease_up_months: { label: 'Lease-up delay (months)', min: 0, max: 1200, integer: true },
  appreciation_pct: { label: 'Annual appreciation (%)', min: 0, max: 100 },
  tenant_ti: { label: 'Outside tenant allowance ($/SF)', min: 0, max: 1e6 },
  practice_lease_rate: { label: 'Practice annual lease rent ($/SF)', min: 0, max: 1e6 },
  lease_buildout_psf: { label: 'Practice lease buildout ($/SF)', min: 0, max: 1e6 },
};
export type Field = keyof typeof fields;
export type Draft = Partial<Record<Field, string | number>>;
export type Scenario = Record<Field, number>;
export const fieldNames = Object.keys(fields).filter((key): key is Field => key in fields);
export function ownershipChoices(pkg: OwnershipPackage) {
  const program = pkg.ownership?.program;
  if (!program) return [];
  return pkg.properties.filter(p => {
    const o = p.ownership;
    if (!o || p.role !== 'candidate' || ![o.total_sf,o.asking_price,o.contiguous_sf,o.available_sf ?? o.contiguous_sf].every(Number.isFinite)) return false;
    const required = Math.max(program.min_sf, program.min_share * o.total_sf);
    return /^fee simple$/i.test(o.tenure.trim()) && /^whole building$/i.test(o.offering.trim()) && o.total_sf > 0 && o.asking_price > 0 && required <= o.total_sf && required <= o.contiguous_sf && required <= (o.available_sf ?? o.contiguous_sf);
  });
}
export function defaultScenario(ownership: Ownership, property: OwnershipProperty): Draft {
  const o = property.ownership;
  if (!o) return {};
  const { ti_options, ...defaults } = ownership.defaults;
  return { ...defaults, price: o.asking_price, share: Math.max(ownership.program.min_share * 100, ownership.program.min_sf / o.total_sf * 100), tenant_ti: ti_options[0] ?? 0, practice_lease_rate: defaults.rent_psf, lease_buildout_psf: defaults.buildout_psf };
}
export type OwnershipState = { propertyId: string | null; draft: Draft; allocations: Record<string,string> };
export type OwnershipEvent = { kind: 'edit'; field: Field; value: string } | { kind: 'select'; id: string } | { kind: 'allocate'; id: string; value: string } | { kind: 'reset' };
export function initialOwnershipState(pkg: OwnershipPackage): OwnershipState {
  const choices = ownershipChoices(pkg);
  const property = choices.find(p => p.id === pkg.ownership?.default_property) ?? choices[0];
  return property && pkg.ownership ? { propertyId: property.id, draft: defaultScenario(pkg.ownership,property), allocations:{} } : { propertyId: null, draft: {}, allocations:{} };
}
export function ownershipTransition(pkg: OwnershipPackage, state: OwnershipState, event: OwnershipEvent): OwnershipState {
  switch (event.kind) {
    case 'reset': return initialOwnershipState(pkg);
    case 'select': {
      const property = ownershipChoices(pkg).find(p => p.id === event.id);
      if (!property || !pkg.ownership) return state;
      const draft=defaultScenario(pkg.ownership,property);
      const allocation=state.allocations[property.id];
      if(allocation!==undefined)draft.share=allocation;
      return { ...state, propertyId: property.id, draft };
    }
    case 'allocate':
      if(!ownershipChoices(pkg).some(p=>p.id===event.id))return state;
      return {...state,allocations:{...state.allocations,[event.id]:event.value},draft:event.id===state.propertyId?{...state.draft,share:event.value}:state.draft};
    case 'edit': return state.propertyId ? { ...state, draft: { ...state.draft, [event.field]: event.value }, allocations:event.field==='share'?{...state.allocations,[state.propertyId]:event.value}:state.allocations } : state;
  }
}
export type HoldingPoint = { year: number; value: number; balance: number; equity: number; rentCollected: number; debtService: number; cashContributed: number; leaseCost: number; netPosition: number };
export type Calculation = { kind: 'invalid'; errors: string[] } | { kind: 'valid'; value: { scenario: Scenario; practiceSf: number; outsideSf: number; loan: number; monthlyPayment: number; upfrontCash: number; buildout: number; tenantAllowance: number; annualOutsideRent: number; points: HoldingPoint[] } };
export function calculateScenario(ownership: Ownership, property: OwnershipProperty, draft: Draft): Calculation {
  const errors: string[] = [];
  const s: Scenario = {price:0,share:0,financed_pct:0,rate:0,years:0,rent_psf:0,collection_pct:0,buildout_psf:0,lease_up_months:0,appreciation_pct:0,tenant_ti:0,practice_lease_rate:0,lease_buildout_psf:0};
  for (const key of fieldNames) {
    const raw = draft[key];
    const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
    const rule = fields[key];
    if (!Number.isFinite(value) || value < rule.min || value > rule.max || ('integer' in rule && !Number.isInteger(value))) errors.push(`${rule.label} must be ${rule.min} to ${rule.max}${'integer' in rule ? ' in whole numbers' : ''}.`);
    s[key] = value;
  }
  const o = property.ownership;
  if (!o || !ownershipChoices({ownership,properties:[property]}).length) return {kind:'invalid',errors:['Property is not eligible for this ownership illustration.']};
  const practiceSf = o.total_sf * s.share / 100;
  if (s.share < ownership.program.min_share * 100 || practiceSf + 1e-8 < ownership.program.min_sf || practiceSf > Math.min(o.total_sf,o.contiguous_sf,o.available_sf ?? o.contiguous_sf)) errors.push('Practice space must meet the published minimum share and area, within contiguous available space.');
  if (errors.length) return {kind:'invalid',errors};
  const outsideSf = o.total_sf - practiceSf;
  const loan = s.price * s.financed_pct / 100;
  const months = s.years * 12;
  const rate = s.rate / 1200;
  const monthlyPayment = rate === 0 ? loan / months : loan * rate / -Math.expm1(-months * Math.log1p(rate));
  const buildout = practiceSf * s.buildout_psf;
  const tenantAllowance = outsideSf * s.tenant_ti;
  const upfrontCash = s.price - loan + buildout + tenantAllowance;
  const annualOutsideRent = outsideSf * s.rent_psf;
  const existingIncome = Math.min(annualOutsideRent, Math.max(0,o.current_income_annual ?? 0));
  let balance = loan, rentCollected = 0, debtService = 0;
  const points: HoldingPoint[] = [];
  for (const month of Array.from({length:121},(_,index)=>index)) {
    if (month > 0) {
      if (month <= months) {
        const payment = Math.min(monthlyPayment,balance * (1+rate));
        debtService += payment;
        balance = month === months ? 0 : Math.max(0,balance * (1+rate)-payment);
      }
      rentCollected += (month <= s.lease_up_months ? existingIncome : annualOutsideRent) * s.collection_pct / 1200;
    }
    if (month % 12 === 0) {
      const year = month / 12;
      const value = s.price * (1+s.appreciation_pct/100)**year;
      const equity = value - balance;
      const cashContributed = upfrontCash + debtService - rentCollected;
      const leaseCost = practiceSf * (s.lease_buildout_psf + s.practice_lease_rate * year);
      points.push({year,value,balance,equity,rentCollected,debtService,cashContributed,leaseCost,netPosition:equity-cashContributed});
    }
  }
  if (![monthlyPayment,...points.flatMap(p => Object.values(p))].every(Number.isFinite)) return {kind:'invalid',errors:['These assumptions exceed the supported calculation range.']};
  return {kind:'valid',value:{scenario:s,practiceSf,outsideSf,loan,monthlyPayment,upfrontCash,buildout,tenantAllowance,annualOutsideRent,points}};
}
export function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.round((value+Number.EPSILON)*100)/100);
}
