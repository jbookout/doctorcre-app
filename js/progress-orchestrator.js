import { createPageBudget } from './read-budget.mjs';
const STATES = [
  ['waiting','Waiting'],['working','Working'],['review','Review'],['fixing','Sent back for fixes'],
  ['merging','Merging'],['merged','Merged / awaiting release'],['live','Live'],['blocked','Blocked'],
];
const LABELS = Object.fromEntries(STATES);
const timestamp = value => {
  const date = new Date(value || NaN);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : new Intl.DateTimeFormat(undefined,
    {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(date);
};
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
export function orchestratorError(value) {
  if (value == null) return null;
  if (value.schema !== 'doctorcre-orchestrator/v1' || !Array.isArray(value.cards) || !Array.isArray(value.history)
      || !value.sources || (value.pages !== undefined && (!Array.isArray(value.pages) || value.pages.some(page => !page || !/^orchestrator-page-(?:[01]-[1-9]\d*|[a-f0-9]{64})$/.test(page.board_id) || !Number.isInteger(page.version) || page.version < 1 || !Number.isInteger(page.count) || page.count < 1 || page.count > 100))) || [...value.cards,...value.history].some(card => !card || !LABELS[card.state]
        || typeof card.id !== 'string' || typeof card.title !== 'string' || !Array.isArray(card.prs)))
    return 'The orchestrator observation is incomplete.';
  return null;
}

export function mountOrchestrator({container, window:win, now = () => new Date(), readPage}) {
  const doc = container.ownerDocument;
  const node = (tag, className, text) => {
    const el = doc.createElement(tag);
    if(className) el.className=className;
    if(text) el.textContent=text;
    return el;
  };
  const status = node('p','orchestrator-status');
  status.dataset.orchestratorStatus=''; status.setAttribute('role','status');
  const explanation = node('p','orchestrator-explanation','DoctorCRE and CARR, from waiting work to verified release.');
  const observations=node('details','orchestrator-observations');
  observations.append(node('summary','','Observation details'));
  const sourceDetail=node('p','orchestrator-explanation');
  observations.append(sourceDetail,node('p','orchestrator-explanation','Review means ready for review. Live requires matching delivery evidence. Owners are recorded assignments; activity is not a presence signal.'));
  const counts = node('nav','orchestrator-counts'); counts.setAttribute('aria-label','Delivery states');
  const root = node('div','orchestrator-groups');
  const groups = new Map();
  for(const [id,label] of STATES) {
    const jump=node('a','orchestrator-count'); jump.href=`#orchestrator-${id}`;
    const name=node('span','',label), count=node('strong','','0'); jump.append(name,count);counts.append(jump);
    const group=node('section','orchestrator-group'); group.id=`orchestrator-${id}`;group.dataset.orchestratorStage=id;
    const heading=node('h3','',label); const list=node('div','orchestrator-list');
    const empty=node('p','orchestrator-empty','No work in this state.');group.append(heading,list,empty);root.append(group);
    groups.set(id,{group,list,empty,count});
  }
  const history = node('details','orchestrator-history');
  history.append(node('summary','','Recent completed work'));
  const historyList=node('div','orchestrator-list');history.append(historyList);
  const omitted=node('p','orchestrator-empty');history.append(omitted);
  for(const id of ['blocked','fixing','review','working','merging','merged','waiting','live']) root.append(groups.get(id).group);
  container.classList.add('orchestrator-board');container.replaceChildren(status,explanation,counts,root,history,observations);
  const pagination=node('p','orchestrator-explanation');pagination.dataset.orchestratorPagination='';
  const more=node('button','', 'Load older unresolved work');more.type='button';more.dataset.orchestratorMore='';
  root.after(pagination,more);
  const records = new Map();
  let loaded=[], pageIndex=0, generation=0, disposed=false;
  more.addEventListener('click', async () => {
    const page=value?.pages?.[pageIndex];if(!page || more.disabled) return;
    const epoch=generation;more.disabled=true;
    try {
      const read=await readPage({board_id:page.board_id});
      if(disposed || epoch!==generation) return;
      const saved=read?.snapshot, cards=saved?.snapshot_json?.cards;
      if(saved?.version!==page.version || !Array.isArray(cards) || cards.length!==page.count
        || orchestratorError({...value,cards,history:[]})) throw new Error('incomplete page');
      loaded.push(...cards);pageIndex++;render();
    } catch {
      if(!disposed && epoch===generation) setText(pagination,'Older work is unavailable. The displayed observation is retained. Try again.');
    } finally {if(!disposed && epoch===generation) more.disabled=false;}
  });
  let value, offline=false, signature='';
  function ages() {
    if(!value) return;
    const stale = source => source?.state !== 'observed' || !source.checked_at
      || Number.isNaN(Date.parse(source.checked_at)) || now().getTime()-Date.parse(source.checked_at)>180000;
    const sources=value.sources;
    const last = timestamp(value.observed_at);
    const warnings=[];
    if(offline) warnings.push('Board connection offline. Showing the last successful observation.');
    if(stale(sources.queue)) warnings.push('Queue observation unavailable or stale.');
    if(stale(sources.github) || stale(sources.portfolio)) warnings.push('Review and merge observations are stale or unknown.');
    setText(status,`${warnings.join(' ')} Source observed ${last}.`.trim());
    setText(sourceDetail,`Queue last observed ${timestamp(sources.queue?.last_success_at || sources.queue?.checked_at)}. GitHub last verified ${timestamp(sources.github?.last_success_at)}. Release status uses matching delivery evidence. Updates appear automatically while this page is visible.`);
    status.dataset.stale=String(Boolean(warnings.length));
  }
  function ensure(card) {
    let record=records.get(card.id);
    if(!record) {
      const el=node('article','orchestrator-card');el.dataset.orchestratorCard=card.id;
      const title=node('h4'), state=node('span','orchestrator-state'), owner=node('p','orchestrator-owner');
      const delivery=node('p','orchestrator-delivery');
      const progress=node('p','orchestrator-progress'), changed=node('p','orchestrator-changed');
      const prs=node('nav','orchestrator-links');prs.setAttribute('aria-label','Source changes');
      const detail=node('details','orchestrator-detail');detail.append(node('summary','','More details'));
      const identity=node('p');detail.append(identity);
      el.append(title,state,owner,progress,delivery,changed,prs,detail);
      record={el,title,state,owner,progress,delivery,changed,prs,identity,links:new Map()};records.set(card.id,record);
    }
    setText(record.title,card.title);setText(record.state,LABELS[card.state]);
    setText(record.owner,`Owner ${card.owner || 'Not recorded'} · ${card.area || 'Shared portfolio'}`);
    setText(record.progress,card.progress || 'Awaiting a recorded progress update');
    record.delivery.hidden=card.state!=='live';
    setText(record.delivery,card.delivery_evidence ? `Delivery evidence: ${card.delivery_evidence}` : 'Live is recorded. Matching delivery evidence detail is unavailable in this observation.');
    setText(record.changed,`Last changed ${timestamp(card.changed_at)}`);setText(record.identity,`Reference ${card.id}`);
    record.prs.setAttribute('aria-label',`Source changes for ${card.title} (${card.id})`);
    const valid=card.prs.filter(href=>/^https:\/\/github\.com\/jbookout\/(?:carr-system|doctorcre-app|software-factory)\/pull\/[1-9]\d*$/.test(href));
    record.prs.hidden=!valid.length;
    for(const [href,link] of record.links) if(!valid.includes(href)){link.remove();record.links.delete(href);}
    for(const href of valid) if(!record.links.has(href)) {
      const link=node('a','',`View ${href.split('/')[4]} change #${href.split('/').at(-1)}`);
      link.href=href;link.target='_blank';link.rel='noopener noreferrer';record.prs.append(link);record.links.set(href,link);
    }
    return record.el;
  }
  function render() {
    const next=value;
    const nextSignature=JSON.stringify([next,loaded]);
    if(signature===nextSignature){ages();return;}
    signature=nextSignature;
    const active=doc.activeElement, left=win.scrollX, top=win.scrollY;
    // eslint-disable-next-line no-restricted-syntax -- Captures one scroll position per DOM ancestor and stops at the document root; zero reads.
    const scroll=[];for(let parent=container.parentElement;parent;parent=parent.parentElement) scroll.push([parent,parent.scrollLeft,parent.scrollTop]);
    const seen=new Set();
    const place=(cards,parent)=>cards.forEach((card,index)=>{
      seen.add(card.id);const el=ensure(card);
      if(parent.children[index]!==el) {
        if(parent.moveBefore && el.isConnected) parent.moveBefore(el,parent.children[index] || null);
        else parent.insertBefore(el,parent.children[index] || null);
      }
    });
    for(const [id,group] of groups) {
      const cards=[...new Map([...loaded,...value.cards,...value.history.filter(card=>card.state==='live')].map(card=>[card.id,card])).values()].filter(card=>card.state===id);
      setText(group.count,String(value.state_counts?.[id] ?? cards.length));place(cards,group.list);group.empty.hidden=Boolean(cards.length);setText(group.empty, value.state_counts?.[id] ? 'Older work in this state is available using Load older unresolved work.' : 'No work in this state.');group.group.hidden=!cards.length && !value.state_counts?.[id];
    }
    place(value.history.filter(card=>card.state!=='live'),historyList);
    history.hidden=!historyList.children.length && !value.omitted_history;
    setText(omitted,value.omitted_history ? `${value.omitted_history} older completed items are outside the recent history.` : '');
    for(const [id,record] of records) if(!seen.has(id)){record.el.remove();records.delete(id);}
    if(active?.isConnected && doc.activeElement!==active) active.focus({preventScroll:true});
    for(const [parent,x,y] of scroll){parent.scrollLeft=x;parent.scrollTop=y;}
    if(win.scrollX!==left || win.scrollY!==top) win.scrollTo(left,top);
    setText(pagination,`${value.cards.length + loaded.length} of ${value.total_cards ?? value.cards.length} unresolved items shown, newest changes first. Older review and merged work keeps its recorded state. Legacy board publication is separate and is not verified by this feed.`);
    more.hidden=pageIndex >= (value.pages?.length || 0);
    ages();
  }
  return {async update(next) {
    const epoch=++generation;
    more.disabled=false;
    if(value && loaded.length && JSON.stringify(value.pages)!==JSON.stringify(next.pages)) {
      more.disabled=true;
      try {
        const pages=[];
        const takePage = createPageBudget({ document: doc });
        // eslint-disable-next-line no-restricted-syntax -- Orchestrator page reads call takePage before each manifest page; at most 100 reads per refresh.
        for(const page of next.pages || []) {
          takePage();
          const read=await readPage({board_id:page.board_id});
          const saved=read?.snapshot, cards=saved?.snapshot_json?.cards;
          if(saved?.version!==page.version || !Array.isArray(cards) || cards.length!==page.count
            || orchestratorError({...next,cards,history:[]})) throw new Error('incomplete page');
          pages.push(...cards);
        }
        if(disposed || epoch!==generation) return;
        loaded=pages;pageIndex=next.pages?.length || 0;
      }catch {
        if(!disposed && epoch===generation) {offline=true;ages();setText(pagination,'Older work is unavailable. The complete displayed observation is retained. Try again.');}
        return;
      }finally {if(!disposed && epoch===generation) more.disabled=false;}
    } else if(!loaded.length && JSON.stringify(value?.pages)!==JSON.stringify(next.pages)) pageIndex=0;
    value=next;offline=false;render();
  }, ages, offline(){offline=true;ages();}, dispose(){disposed=true;generation++;records.clear();}};
}
