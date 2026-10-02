import { createClient } from './client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountAutoRefresh, updatedLabel } from './auto-refresh.mjs';
import { localToday } from './calendar-model.js';
import { uuidv4 } from './uuid.js';
import { AGES, projectInvoices, invoiceSummary, invoiceMoney, invoiceDate } from './invoice-tracker-model.js';
const E=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusLabel=row=>row.status==='paid'?'Paid':row.status==='awaiting'?'Awaiting invoice':row.overdue?'Overdue':'Unpaid';
export function mountInvoiceTracker({ document, window, client, today=localToday, intervalMs=30_000 }) {
  const $=id=>document.getElementById(id);
  let rows=null,status='all',age=null,selected=null,opener=null,disposed=false,updatedAt=null;
  const payments=new Map();
  const requested=new URL(window.location.href).searchParams.get('invoice');
  let requestHandled=false;
  const paint=(target,html)=>{
    if(target.innerHTML===html)return;
    const key=target.contains(document.activeElement)?document.activeElement.dataset.invoiceKey:null;
    target.innerHTML=html;
    if(key)([...target.querySelectorAll('[data-invoice-key]')].find(node=>node.dataset.invoiceKey===key)||$('invoiceSearch')).focus();
  };
  const scoped=()=>rows?.filter(row=>!$('invoiceOwner').value || row.owner===$('invoiceOwner').value);
  function render() {
    const owned=scoped();
    $('invoiceRows').setAttribute('aria-busy',String(!rows));
    $('invoiceUpdated').textContent=updatedLabel(updatedAt);
    if(!owned){paint($('invoiceTotals'),'');paint($('invoiceAging'),'');paint($('invoiceRows'),'<p>Updating…</p>');return;}
    const totals=invoiceSummary(owned);
    paint($('invoiceTotals'),`<div class="invoice-total owed glass"><span>Owed to CARR</span><strong>${E(invoiceMoney(totals.owed))}${totals.unknown?' + —':''}</strong><small>${totals.unpaid} unpaid${totals.unknown?` · ${totals.unknown} amount pending`:''}</small></div><div class="invoice-total glass"><span>Awaiting invoice</span><strong>${totals.awaiting}</strong></div><div class="invoice-total glass"><span>Paid</span><strong>${totals.paid}</strong></div>`);
    const ceiling=Math.max(1,...totals.buckets.map(bucket=>bucket.amount));
    paint($('invoiceAging'),totals.buckets.map(bucket=>`<button class="invoice-age" data-age="${bucket.index}" data-invoice-key="age:${bucket.index}" aria-pressed="${age===bucket.index}"><span class="age-label">${bucket.label}</span><strong>${E(invoiceMoney(bucket.amount))}</strong><svg class="age-track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="age-base" width="100" height="8" rx="4"/><rect class="age-fill" width="${Math.max(bucket.count?4:0,bucket.amount/ceiling*100)}" height="8" rx="4"/></svg><small>${bucket.count} ${bucket.count===1?'invoice':'invoices'}</small></button>`).join(''));
    const term=$('invoiceSearch').value.trim().toLocaleLowerCase();
    const visible=owned.filter(row=>(status==='all'||row.status===status)&&(age===null||(row.status==='unpaid'&&row.bucket===age))&&row.name.toLocaleLowerCase().includes(term));
    $('invoiceCount').textContent=`Invoices · ${visible.length}`;$('invoiceFiltered').textContent=age===null?'':AGES[age];
    paint($('invoiceRows'),visible.length?visible.map(row=>`<button type="button" class="invoice-row ${row.status}${row.overdue?' overdue':''}" data-age="${row.bucket ?? ''}" data-invoice-key="${E(row.key)}" data-invoice="${E(row.key)}" aria-label="${E(row.name)}, ${statusLabel(row)}"><span><strong>${E(row.name)}</strong><span class="invoice-sub">${E(row.owner || 'Unassigned')}</span></span><span class="row-date">${row.status==='awaiting'?'Awaiting invoice':E(invoiceDate(row.invoiceDay))}</span><span class="row-money">${row.status==='paid'?E(invoiceMoney(0)):E(invoiceMoney(row.amount))}</span><span class="invoice-state">${statusLabel(row)}</span><span class="row-age">${row.age===null?'—':row.age}<small>${row.status==='paid'?'days to payment':'days outstanding'}</small></span></button>`).join(''):'<p>No invoices match</p>');
    $('allAges').setAttribute('aria-pressed',String(age===null));
    for(const button of $('invoiceTabs').querySelectorAll('[data-status]'))button.setAttribute('aria-pressed',String(button.dataset.status===status));
    if(selected)renderDetail();
    if(requested&&!requestHandled){const row=rows.find(row=>row.key===requested);if(row){requestHandled=true;openDetail(row.key);}}
  }
  function renderDetail() {
    const row=rows?.find(row=>row.key===selected);
    if(!row){$('invoiceDetail').close();selected=null;return;}
    $('invoiceDetailTitle').textContent=row.name;
    paint($('invoiceDetailFacts'),`<div class="invoice-detail-facts"><div><span>${row.status==='paid'?'Paid to CARR':'Owed to CARR'}</span><strong>${E(invoiceMoney(row.amount))}</strong></div><div><span>Status</span><strong class="invoice-status-value">${statusLabel(row)}</strong></div><div><span>${row.status==='paid'?'Days to payment':'Days outstanding'}</span><strong>${row.age ?? '—'}</strong></div></div>`);
    paint($('invoiceTimeline'),[['Closed',row.closed_on],['Invoiced',row.invoiceDay],['Paid',row.received_on]].map(([label,day])=>`<div class="invoice-milestone${day?' done':''}"><strong>${label}</strong><time${day?` datetime="${day}"`:''}>${day?invoiceDate(day):label==='Invoiced'?'Awaiting invoice':'—'}</time></div>`).join(''));
    $('invoiceActivity').textContent=row.status==='paid'?`Payment recorded ${invoiceDate(row.received_on)}.`:row.status==='awaiting'?'Closed · awaiting invoice.':row.overdue?`Payment due ${invoiceDate(row.due_on)}.`:`Invoiced ${invoiceDate(row.invoiceDay)}.`;
    paint($('invoiceOriginalFacts'),[['Owner',row.owner || 'Unassigned'],['Closed',invoiceDate(row.closed_on)],['Invoiced',invoiceDate(row.invoiceDay)],['Commission',invoiceMoney(row.amount)],['Due',row.due_on?invoiceDate(row.due_on):'Not set'],['Paid',invoiceDate(row.received_on)]].map(([label,value])=>`<dt>${label}</dt><dd>${E(value)}</dd>`).join(''));
    $('invoicePayment').hidden=!row.canMarkPaid;
    $('invoicePaidDate').min=row.invoiceDay || '';$('invoicePaidDate').max=today();
    if(row.status==='paid')payments.delete(row.key);
    const pending=payments.has(row.key);
    $('markInvoicePaid').disabled=Boolean(pending);
    if(pending){$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent='Confirming payment…';}
  }
  function openDetail(key,element) {
    selected=key;opener=element || document.activeElement;
    $('invoicePaidDate').value=today();$('invoiceOriginal').open=false;$('invoicePaymentNotice').hidden=true;
    renderDetail();$('invoiceDetail').showModal();
  }
  function closeDetail(){ $('invoiceDetail').close(); }
  $('invoiceDetail').addEventListener('close',()=>{const key=selected;selected=null;const button=[...$('invoiceRows').querySelectorAll('[data-invoice]')].find(node=>node.dataset.invoice===key);(button || (opener?.isConnected?opener:null)||$('invoiceSearch')).focus();});
  $('closeInvoiceDetail').addEventListener('click',closeDetail);
  $('invoiceRows').addEventListener('click',event=>{const button=event.target.closest('[data-invoice]');if(button)openDetail(button.dataset.invoice,button);});
  $('invoiceTabs').addEventListener('click',event=>{const button=event.target.closest('[data-status]');if(button){status=button.dataset.status;render();}});
  $('invoiceAging').addEventListener('click',event=>{const button=event.target.closest('[data-age]');if(button){age=age===Number(button.dataset.age)?null:Number(button.dataset.age);status='unpaid';render();}});
  $('allAges').addEventListener('click',()=>{age=null;render();});
  $('invoiceSearch').addEventListener('input',render);$('invoiceOwner').addEventListener('change',render);
  $('clearInvoiceFilters').addEventListener('click',()=>{status='all';age=null;$('invoiceSearch').value='';$('invoiceOwner').value='';render();});
  async function refresh({signal}={}) {
    try{
      const next=await client.getInvoiceTracker({signal});const projected=projectInvoices(next,{today:today()});
      if(!projected)throw new Error('Invalid invoice snapshot');if(disposed||signal?.aborted)return;
      rows=projected;updatedAt=next.observed_at;$('invoiceNotice').hidden=true;
      const owner=$('invoiceOwner').value;const owners=[...new Set(rows.map(row=>row.owner).filter(Boolean))].sort();
      const options='<option value="">Everyone</option>'+owners.map(value=>`<option value="${E(value)}">${E(value)}</option>`).join('');
      if($('invoiceOwner').innerHTML!==options){$('invoiceOwner').innerHTML=options;$('invoiceOwner').value=owner;}
      render();
    }catch(error){if(disposed||signal?.aborted)return;$('invoiceNotice').hidden=false;
      const signedOut=[401,403].includes(error?.status);
      $('invoiceNotice').innerHTML=signedOut?'<a href="/auth/login?return_to=%2Finvoices">Sign in</a>':'Invoices temporarily unavailable';
      if(signedOut){rows=null;updatedAt=null;$('invoiceDetail').close();render();}
      else if(!rows){$('invoiceRows').innerHTML='<p>Invoices unavailable</p>';$('invoiceRows').setAttribute('aria-busy','false');}
    }
  }
  const auto=mountAutoRefresh({document,window,refresh,intervalMs});
  $('refreshInvoices').addEventListener('click',()=>auto.refresh());
  $('invoicePayment').addEventListener('submit',async event=>{
    event.preventDefault();const row=rows?.find(row=>row.key===selected);
    if(!row?.canMarkPaid || payments.has(row.key) || !$('invoicePayment').reportValidity())return;
    const intent={key:row.key,args:{commission_id:row.commission_id,base_version:row.base_version,received_on:$('invoicePaidDate').value,idempotency_key:uuidv4()}};
    payments.set(row.key,intent);renderDetail();
    try{await client.markInvoicePaid(intent.args);await auto.refresh();}
    catch(error){
      const code=error?.payload?.error;
      if(['version_conflict','invoice_not_unpaid','invalid_received_on','payment_date_out_of_range','invoice_not_found','offline'].includes(code)||[401,403].includes(error?.status)){
        if(payments.get(row.key)===intent)payments.delete(row.key);
        await auto.refresh();
        if(selected===row.key){renderDetail();$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent=code==='version_conflict'?'Invoice changed. Payment not recorded.':code==='offline'?'Payment not recorded. You are offline.':'Payment not recorded.';}
      }else{
        await auto.refresh();
        if(selected===row.key && payments.get(row.key)===intent){$('invoicePaymentNotice').hidden=false;$('invoicePaymentNotice').textContent='Payment confirmation pending.';}
      }
    }
  });
  render();const ready=auto.refresh();
  return {ready,refresh:()=>auto.refresh(),dispose(){disposed=true;auto.dispose();}};
}
if(typeof document!=='undefined'&&document.getElementById('invoiceRows')){
  const boot=resolveDealroomBoot(window.location);
  createClient(boot.mode,boot.options).then(client=>mountInvoiceTracker({document,window,client})).catch(()=>{document.getElementById('invoiceRows').textContent='Invoices unavailable';});
}
