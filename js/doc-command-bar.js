import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { entryDetailsHtml } from './entry-details.mjs';
import { FIND_QUERY_MAX } from './search-model.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const matches = (name, query) => String(name).toLowerCase().includes(query.toLowerCase());

// One Doc dialog, one input. Reads use the existing authorized client seam;
// this module never treats retrieved words as instructions or execution rights.
export function mountDocCommandBar({ dialog, window: win, client, context, pages,
  navigate = href => win.location.assign(href), intervalMs = 30_000, tours = async () => [], onOpen = () => {} } = {}) {
  const root=dialog.ownerDocument;
  const host=root.createElement('section');host.className='doc-command';
  host.innerHTML=`<form id="docCommandForm" role="search"><span aria-hidden="true">✦</span><input id="docCommandInput" type="search" maxlength="${FIND_QUERY_MAX}" placeholder="Search anything or ask Doc…" aria-label="Search anything or ask Doc" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="docCommandResults" aria-expanded="false"><button type="submit" aria-label="Ask Doc" title="Ask Doc">↵</button></form><div class="doc-command-meta"><span id="docCommandScope"></span><span><time id="docCommandUpdated"></time><button id="docCommandRefresh" type="button" aria-label="Refresh search" title="Refresh search">↻</button></span></div><div id="docCommandResults" role="listbox" aria-label="Search results"></div><div id="docCommandStatus" role="status"></div><section id="docCommandDetail" hidden></section>`;
  dialog.querySelector('header').after(host);
  const $=id=>root.getElementById(id), input=$('docCommandInput');
  let query='', epoch=0, timer, results=[], selected=0, opened=null, disposed=false, focusBefore=null;
  const pageResults=()=>pages.filter(row=>matches(row.label,query.replace(/^open\s+/i,''))).map(row=>({kind:'Page',title:row.label,href:row.href,id:row.href,fields:[]}));
  const paint=()=>{
    const focus=root.activeElement?.dataset.docResult;
    $('docCommandResults').innerHTML=results.map((row,i)=>`<button type="button" id="doc-result-${i}" role="option" aria-selected="${i===selected}" data-doc-result="${i}"><span class="doc-result-symbol" aria-hidden="true">${row.kind==='Page'?'↗':row.kind==='Tour'?'⌖':'◇'}</span><span>${escape(row.title)}</span><span class="doc-result-kind">${escape(row.kind)}</span></button>`).join('');
    input.setAttribute('aria-expanded',String(results.length>0));
    if(results.length)input.setAttribute('aria-activedescendant',`doc-result-${selected}`);else input.removeAttribute('aria-activedescendant');
    if(focus!==undefined)$('docCommandResults').querySelector(`[data-doc-result="${focus}"]`)?.focus();
  };
  function detail(row, focus=true) {
    if(row.kind==='Page'){navigate(row.href);return;}
    const target=$('docCommandDetail');target.hidden=false;
    const expanded=target.querySelector('details')?.open && opened?.id===row.id;
    const hadFocus=target.contains(root.activeElement);
    opened=row;
    target.innerHTML=`<header><h3>${escape(row.title)}</h3><span class="doc-result-kind">${escape(row.kind)}</span><button id="docCommandBack" type="button" aria-label="Back to search">←</button></header><dl>${row.fields.filter(f=>f.value!==null&&f.value!==undefined&&f.value!=='').map(f=>`<div><dt>${escape(f.label)}</dt><dd>${f.label==='Next step'?entryDetailsHtml(f.value):escape(f.value)}</dd></div>`).join('')}</dl>${row.href?`<a href="${escape(row.href)}">Open ${escape(row.kind.toLowerCase())} ↗</a>`:''}`;
    if(expanded&&target.querySelector('details'))target.querySelector('details').open=true;
    $('docCommandBack').onclick=()=>{opened=null;target.hidden=true;input.focus();};
    // Record results reuse this wide popup; they never open a narrow drawer.
    if(focus||hadFocus)target.querySelector('button').focus();
  }
  async function refresh({signal}={}) {
    win.clearTimeout(timer);
    if(!dialog.open||disposed)return;
    const current=++epoch, captured=query;
    if(!query.trim()){results=pageResults();paint();return;}
    $('docCommandStatus').textContent='';$('docCommandResults').setAttribute('aria-busy','true');
    try {
      const api=await client();
      const [found,board,tourRows]=await Promise.all([
        readWithDeadline(()=>api.find({query:captured}),{signal}),
        readWithDeadline(()=>api.getBoard({workspace:'all'}),{signal}),
        readWithDeadline(()=>tours(),{signal}).catch(error=>{ if([401,403].includes(error.status))throw error;return null; }),
      ]);
      if(disposed||signal?.aborted||current!==epoch||captured!==query)return;
      if(!Array.isArray(found?.parties)||!Array.isArray(found?.deals)||!Array.isArray(board?.deals))throw new Error('Unavailable');
      const rows=found.parties.filter(r=>!r.merged&&r.name).map(r=>({kind:({lead:'Lead',vendor:'Vendor',client:'Client'})[r.kind]||'Person',id:r.ref,title:r.name,href:['client','vendor'].includes(r.kind)?`/${r.kind}s?q=${encodeURIComponent(r.name)}`:null,fields:[{label:'City',value:r.city},{label:'Specialty',value:r.specialty},{label:'Practice',value:r.org_name}]}));
      const deals=board.deals.filter(r=>matches(r.name,captured)).map(r=>({kind:'Deal',id:r.id,title:r.name,href:`/deals?deal=${encodeURIComponent(r.id)}`,fields:[{label:'Stage',value:r.phase},{label:'Next step',value:r.next_step}]}));
      // `find` deals lack canonical IDs; never resolve them by fuzzy name to a board ID.
      for(const row of found.deals)if(!deals.some(d=>d.title===row.name))deals.push({kind:'Deal',id:`name:${row.name}`,title:row.name,fields:[{label:'Stage',value:row.phase}]});
      results=[...pageResults(),...rows,...deals,...(tourRows||[]).filter(r=>matches(r.name,captured)).map(r=>({kind:'Tour',id:r.id,title:r.name,href:`/tours?tour=${encodeURIComponent(r.id)}`,fields:[]}))];selected=Math.min(selected,Math.max(0,results.length-1));paint();
      $('docCommandUpdated').textContent=updatedLabel(new Date().toISOString());
      $('docCommandStatus').textContent=tourRows===null?'Tours temporarily unavailable':results.length?'':'No matches';
      if(opened){const fresh=results.find(r=>r.kind===opened.kind&&r.id===opened.id);if(fresh)detail(fresh,false);else{opened=null;$('docCommandDetail').hidden=true;$('docCommandDetail').textContent='';}}
    } catch(error) {
      if(disposed||current!==epoch)return;
      if([401,403].includes(error.status))context.clear();
      results=pageResults();opened=null;$('docCommandDetail').hidden=true;$('docCommandDetail').textContent='';paint();$('docCommandUpdated').textContent='';$('docCommandStatus').textContent=[401,403].includes(error.status)?'Sign in to search':'Search temporarily unavailable';
    } finally {if(current===epoch)$('docCommandResults').setAttribute('aria-busy','false');}
  }
  function open() {
    if(!dialog.open){focusBefore=root.activeElement;dialog.showModal();}
    $('docCommandScope').textContent=context.snapshot().active?.title||context.snapshot().label;
    if(!query.trim()){results=pageResults();paint();}else void auto.refresh();
    onOpen(); input.focus();
  }
  const inputChanged=()=>{
    ++epoch;query=input.value.trim();dialog.querySelector('.doc-detail-grid').hidden=!!query;const tools=dialog.querySelector('.doc-context-tools');if(tools)tools.hidden=!!query;selected=0;opened=null;$('docCommandDetail').hidden=true;$('docCommandDetail').textContent='';$('docCommandStatus').textContent='';$('docCommandUpdated').textContent='';
    results=pageResults();paint();win.clearTimeout(timer);timer=win.setTimeout(()=>void refresh(),180);
  };
  input.addEventListener('input',inputChanged);
  const shortcut=event=>{
    if(event.isComposing||event.keyCode===229||event.altKey||event.shiftKey||!(event.metaKey||event.ctrlKey)||!['d','k'].includes(event.key.toLowerCase()))return;
    event.preventDefault(); // cancel bookmarks/search even when the chord repeats
    if(!event.repeat)open();
  };
  root.addEventListener('keydown',shortcut,true);
  input.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(['ArrowDown','ArrowUp'].includes(event.key)&&results.length){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+results.length)%results.length;paint();$('doc-result-'+selected)?.scrollIntoView?.({block:'nearest'});}
  });
  $('docCommandResults').onclick=event=>{const button=event.target.closest('[data-doc-result]');if(button)detail(results[Number(button.dataset.docResult)]);};
  $('docCommandForm').onsubmit=event=>{event.preventDefault();if(!query||event.isComposing)return;if(/^open\s+/i.test(query)&&pageResults().length===1){navigate(pageResults()[0].href);return;}if(/^(?:send|email|pay|delete|move|plan|schedule|draft|ask|change|update)\b/i.test(query)){$('docCommandStatus').textContent='Doc actions unavailable';return;}if(results[selected])detail(results[selected]);else $('docCommandStatus').textContent='Doc actions unavailable';};
  $('docCommandRefresh').onclick=()=>void auto.refresh();
  const closed=()=>{if(dialog.open)return;++epoch;win.clearTimeout(timer);focusBefore?.isConnected&&focusBefore.focus();};
  dialog.addEventListener('close',closed);
  const auto=mountAutoRefresh({document:root,window:win,refresh,intervalMs,shouldRefresh:()=>dialog.open});
  return {open,refresh,dispose(){disposed=true;++epoch;win.clearTimeout(timer);auto.dispose();root.removeEventListener('keydown',shortcut,true);dialog.removeEventListener('close',closed);}};
}
