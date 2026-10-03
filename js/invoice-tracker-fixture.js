import { addDays, localToday, isCalendarDay } from './calendar-model.js';
export function invoiceTrackerFixture(today = localToday()) {
  const row=(n,age,amount,status='invoiced',owner='joe')=>({deal_id:`demo-invoice-deal-${n}`,name:`Demo ${['Harbor Renewal','Oak Purchase','Bay Relocation','Cedar Expansion','River Renewal'][n-1]}`,
    owner,phase:'closed',lane:'territory',outcome:'won',closed_on:addDays(today,-age-7),invoiced_on:addDays(today,-age),
    commission_id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,gross_amount:String(amount),status,base_version:1,
    commission_invoiced_on:addDays(today,-age),received_on:status==='received'?addDays(today,-2):null,due_on:addDays(today,-age+30),as_of:today});
  const entries=[row(1,12,12500),row(2,44,18500),row(3,76,7200,'invoiced','dell'),row(4,104,9400),row(5,18,6500,'received')];
  entries.push({...row(6,0,0),name:'Demo Meadow Renewal',invoiced_on:null,commission_id:null,gross_amount:null,status:null,base_version:null,commission_invoiced_on:null,received_on:null,due_on:null});
  return {schema_version:'invoice-tracker.v1',actor:'joe',entries,observed_at:new Date().toISOString()};
}
export function createInvoiceFixture({ actor, entries, today = localToday } = {}) {
  const payload=invoiceTrackerFixture(today());payload.actor=actor || payload.actor;
  if(entries)payload.entries=structuredClone(entries);
  const receipts=new Map();
  return {
    async getInvoiceTracker(){return structuredClone({...payload,entries:payload.entries.map(row=>({...row,as_of:today()})),observed_at:new Date().toISOString()});},
    async markInvoicePaid(args){
      const refusal=code=>{throw Object.assign(new Error(code),{payload:{error:code}});};
      if(!args.idempotency_key)refusal('missing_idempotency_key');
      const request=JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key])=>key!=='idempotency_key').sort(([a],[b])=>a.localeCompare(b))));
      const prior=receipts.get(args.idempotency_key);
      if(prior){if(prior.request!==request)refusal('key_reuse');return structuredClone(prior.result);}
      const row=payload.entries.find(row=>row.commission_id===args.commission_id);
      if(!row)refusal('invoice_not_found');
      if(row.base_version!==args.base_version)refusal('version_conflict');
      if(row.status!=='invoiced')refusal('invoice_not_unpaid');
      if(!isCalendarDay(args.received_on))refusal('invalid_received_on');
      if(args.received_on<row.commission_invoiced_on || args.received_on>today())refusal('payment_date_out_of_range');
      row.status='received';row.received_on=args.received_on;row.base_version++;
      const result={ok:true,id:row.commission_id,base_version:row.base_version,received_on:row.received_on};receipts.set(args.idempotency_key,{request,result});return structuredClone(result);
    },
  };
}
