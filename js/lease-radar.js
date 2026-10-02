import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { projectLeaseRadar, pastClientTouches, radarToday } from './lease-radar-model.js';
const E = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = day => day ? new Date(`${day}T12:00:00`).toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'}) : 'Missing expiry';
const keyedPaint = (node, html, fallback) => {
  if (node.innerHTML === html) return;
  const key = node.contains(node.ownerDocument.activeElement) ? node.ownerDocument.activeElement.dataset.radarKey : null;
  node.innerHTML = html;
  if (key) ([...node.querySelectorAll('[data-radar-key]')].find(n => n.dataset.radarKey === key) || fallback)?.focus();
};
export function leaseCard(row, gap = false) {
  return `<button type="button" class="lease-card ${gap ? 'gap' : row.tone || 'soon'}" data-lease="${E(row.id)}" data-radar-key="lease:${E(row.id)}"><span class="lease-light" aria-hidden="true"></span><span class="lease-card-copy"><strong>${E(row.client_name)}</strong><span>${E([row.city,row.state].filter(Boolean).join(' · '))}</span></span><span class="lease-card-date"><time datetime="${E(row.expiration_on || '')}">${date(row.expiration_on)}</time><small>${gap ? 'Date needed' : E(row.label)}</small></span><span class="lease-card-arrow" aria-hidden="true">↗</span></button>`;
}
export function mountLeaseDetail({document, dialog, rows, fallback}) {
  let selected = null, opener = null;
  const paint = () => {
    const row = rows().find(r => r.id === selected);
    if (!row) { if (dialog.open) dialog.close(); return; }
    const expanded = dialog.querySelector('details')?.open;
    const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset.radarKey : null;
    const html = `<div class="lease-detail-heading"><div><span>${E(row.client_status_label || 'Client')}</span><h2 id="${E(dialog.id)}Title">${E(row.client_name)}</h2></div><button type="button" data-radar-key="close" data-close-lease aria-label="Close lease details">×</button></div><div class="lease-detail-grid"><section><h3>Client</h3><dl><dt>Market</dt><dd>${E([row.city,row.state].filter(Boolean).join(' · ') || 'Not recorded')}</dd><dt>Specialty</dt><dd>${E(row.vertical || 'Not recorded')}</dd><dt>Broker</dt><dd>${E(row.owner_label || 'Unassigned')}</dd><dt>Contact</dt><dd>${E(({active:'Active',nurture:'Nurture',paused:'Paused',do_not_contact:'Do not contact'})[row.contact_state] || 'Not recorded')}</dd></dl></section><section><h3>Lease</h3><div class="lease-expiry-value">${date(row.expiration_on)}</div><dl><dt>Commencement</dt><dd>${date(row.commencement_on).replace('Missing expiry','Not recorded')}</dd><dt>Option notice</dt><dd>${row.notice_on ? date(row.notice_on) : 'Not recorded'}</dd><dt>Review</dt><dd>${row.lease_status === 'current' ? 'Recorded agreement' : 'Needs review'}</dd><dt>Next touch</dt><dd>${row.touch_due_on ? `${date(row.touch_due_on)} · ${E(row.touch_summary || 'Follow up')}` : 'Not scheduled'}</dd></dl></section></div>${row.options_note ? '<p class="lease-note-summary">Renewal option recorded</p>' : ''}<details><summary data-radar-key="details">Details</summary><dl><dt>Signed</dt><dd>${row.executed_on ? date(row.executed_on) : 'Not recorded'}</dd><dt>Agreement</dt><dd>${E(row.evidence_ref || 'Not recorded')}</dd></dl>${row.options_note ? `<h3>Lease entry</h3><p class="lease-original">${E(row.options_note)}</p>` : ''}${row.notice_note ? `<h3>Notice entry</h3><p class="lease-original">${E(row.notice_note)}</p>` : ''}</details><div class="lease-detail-links"><a data-radar-key="client" href="/clients?record=${encodeURIComponent(row.client_id)}">Client ↗</a>${row.deal_id ? `<a data-radar-key="deal" href="/deals?deal=${encodeURIComponent(row.deal_id)}">Deal ↗</a>` : ''}</div>`;
    if (dialog.innerHTML === html) return;
    dialog.innerHTML = html;
    if (expanded) dialog.querySelector('details').open = true;
    if (focused) ([...dialog.querySelectorAll('[data-radar-key]')].find(n => n.dataset.radarKey === focused) || dialog.querySelector('button')).focus();
  };
  dialog.addEventListener('click', e => { if (e.target.closest('[data-close-lease]')) dialog.close(); });
  dialog.addEventListener('close', () => { selected = null; (opener?.isConnected ? opener : fallback)?.focus(); });
  return { paint, open(id, target) { selected=id; opener=target; paint(); if (selected) dialog.showModal(); }, close(){dialog.close();} };
}
export function mountLeaseRadar({document, window, client, now = () => new Date(), intervalMs = 30_000}) {
  const $ = id => document.getElementById(id);
  let payload = null, model = null, view='timeline', scope='team', search='', quarter=null, sequence=0, disposed=false;
  const detail = mountLeaseDetail({document,dialog:$('leaseDetail'),rows:()=>payload?.leases || [],fallback:$('refreshLeases')});
  const render = () => {
    model = projectLeaseRadar(payload,{scope,today:radarToday(now())});
    if (!model) return;
    const matches = row => row.client_name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
    const filtered = {...model,quarters:model.quarters.map(q => ({...q,leases:q.leases.filter(matches)})),gaps:model.gaps.filter(matches)};
    const max = Math.max(1,...filtered.quarters.map(q=>q.leases.length));
    const width=900, col=width/filtered.quarters.length;
    const visual = `<svg class="lease-timeline-chart" viewBox="0 0 900 150" role="img" aria-label="Lease expirations by quarter"><path class="lease-axis" d="M10 105H890"/>${filtered.quarters.map((q,i)=>`<g role="button" tabindex="0" data-quarter="${q.key}" data-radar-key="quarter:${q.key}" aria-label="${q.label}, ${q.leases.length} leases" aria-pressed="${quarter===q.key}" class="lease-quarter-mark${quarter===q.key?' selected':''}"><rect class="lease-quarter-hit" x="${i*col}" y="0" width="${col}" height="150"/><rect class="lease-quarter-bar" x="${i*col+col*.25}" y="${100-q.leases.length/max*70}" width="${col*.5}" height="${Math.max(2,q.leases.length/max*70)}" rx="4"/><text x="${i*col+col/2}" y="125">${q.label.split(' ')[0]}</text><text x="${i*col+col/2}" y="143">${q.label.split(' ')[1]}</text></g>`).join('')}</svg>`;
    const quarters = filtered.quarters.filter(q=>!quarter || quarter===q.key);
    const html = view==='gaps' ? `<section class="lease-gap-list" aria-label="Missing expiry dates">${filtered.gaps.map(row=>leaseCard(row,true)).join('') || '<p class="lease-empty">No missing expiry dates</p>'}</section>` : `${visual}<div class="lease-legend"><span class="urgent">≤ 6 months</span><span class="soon">6–12 months</span><span class="later">12–24 months</span></div><div class="lease-quarter-list">${quarters.map(q=>`<section class="lease-quarter-group"><div class="lease-quarter-title"><h2>${q.label}</h2><span>${q.leases.length}</span></div><div class="lease-quarter-cards">${q.leases.map(row=>leaseCard(row)).join('') || '<span class="lease-empty">No expirations</span>'}</div></section>`).join('')}</div>`;
    keyedPaint($('leaseRadar'),html,$('refreshLeases'));
    $('leaseWindow').textContent=`${date(model.today)} – ${date(model.end)}`;
    $('leaseGapCount').textContent=String(model.gaps.length);
    $('leaseTotal').textContent=String(model.dated.length);
    $('leaseUpdated').textContent=updatedLabel(model.observedAt);
    $('leaseNotice').hidden=true;
    detail.paint();
  };
  const refresh = async ({signal}={}) => {
    const epoch=++sequence; $('refreshLeases').setAttribute('aria-busy','true');
    try { const next = await readWithDeadline(signal=>client.readLeaseRadar({signal}),{signal});
      if(disposed || epoch!==sequence) return;
      if (!projectLeaseRadar(next,{today:radarToday(now())})) throw Error('Unavailable');
      payload=next; render();
    } catch(error) { if(disposed || epoch!==sequence) return;
      payload=null; model=null; detail.close();
      $('leaseRadar').replaceChildren(); $('leaseUpdated').textContent='Unavailable';
      $('leaseNotice').hidden=false;
      $('leaseNotice').innerHTML=[401,403].includes(error.status) ? '<a href="/auth/login?return_to=%2Fleases">Sign in</a>' : 'Lease dates unavailable';
      $('leaseTotal').textContent='—'; $('leaseGapCount').textContent='—';
    } finally { if(epoch===sequence) $('refreshLeases').setAttribute('aria-busy','false'); }
  };
  $('leaseRadar').addEventListener('click',e=>{
    const card=e.target.closest('[data-lease]'); if(card) detail.open(card.dataset.lease,card);
    const mark=e.target.closest('[data-quarter]'); if(mark){quarter=quarter===mark.dataset.quarter?null:mark.dataset.quarter;render();}
  });
  $('leaseRadar').addEventListener('keydown',e=>{if(e.target.matches('[data-quarter]') && ['Enter',' '].includes(e.key)){e.preventDefault();e.target.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));}});
  $('leaseSearch').addEventListener('input',e=>{search=e.target.value;render();});
  $('leaseScope').addEventListener('change',e=>{scope=e.target.value;render();});
  for(const tab of document.querySelectorAll('[data-lease-view]')) tab.addEventListener('click',()=>{view=tab.dataset.leaseView;quarter=null;document.querySelectorAll('[data-lease-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===tab)));render();});
  const auto=mountAutoRefresh({document,window,refresh,intervalMs}); $('refreshLeases').addEventListener('click',auto.refresh); auto.refresh();
  return {dispose(){disposed=true;sequence++;auto.dispose();},refresh:auto.refresh};
}

export function mountPastClientWidget({document,window,client,host,now=()=>new Date(),scope=()=> 'team'}) {
  let payload=null, disposed=false, sequence=0;
  const dialog=document.createElement('dialog'); dialog.id='pastLeaseDetail';dialog.className='lease-detail';dialog.setAttribute('aria-labelledby','pastLeaseDetailTitle');document.body.append(dialog);
  const detail=mountLeaseDetail({document,dialog,rows:()=>payload?.leases || [],fallback:document.getElementById('homePrimaryAction')});
  const render=()=>{
    const rows=pastClientTouches(payload,{scope:scope(),today:radarToday(now())});
    const html=`<div class="home-panel-head"><h2>Past clients</h2><a class="home-icon-link" href="/leases" aria-label="Lease expiry radar">↗</a></div>${rows===null ? '<p class="home-empty">Follow-ups unavailable</p>' : rows.length ? rows.map(row=>`<button type="button" class="lease-card soon" data-lease="${E(row.id)}" data-radar-key="touch:${E(row.touch_id)}"><span class="lease-light" aria-hidden="true"></span><span class="lease-card-copy"><strong>${E(row.client_name)}</strong><span>${E(row.touch_summary)}</span></span><time datetime="${row.touch_due_on}">${date(row.touch_due_on)}</time></button>`).join('') : '<p class="home-empty">No touches due</p>'}`;
    keyedPaint(host,html,document.getElementById('homePrimaryAction'));host.hidden=false;detail.paint();
  };
  const refresh=async({signal}={})=>{const epoch=++sequence;try{const next=await readWithDeadline(signal=>client.readLeaseRadar({signal}),{signal});if(disposed || epoch!==sequence)return;payload=next;}catch{if(disposed || epoch!==sequence)return;payload=null;detail.close();}render();};
  host.addEventListener('click',e=>{const card=e.target.closest('[data-lease]');if(card)detail.open(card.dataset.lease,card);});
  const auto=mountAutoRefresh({document,window,refresh});auto.refresh();
  return {render,dispose(){disposed=true;sequence++;auto.dispose();dialog.remove();}};
}
