import {updatedLabel} from './auto-refresh.mjs';
import {uuidv4} from './uuid.js';
import {jobLinks} from './control-room-workspace-model.js';
import {workDetailUrl} from './progress-work-model.js';
import {validSystemWork,groupSystemWork,systemPipeline,triageWork} from './system-work-board-model.js';
const workLabel=value=>String(value||'Work').replaceAll('_',' ').replace(/^./,c=>c.toUpperCase());
const node=(tag,text,className)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;};
export function mountSystemWorkBoard({client,onPipeline,openTask}){
 const panel=document.getElementById('system-work-panel');panel.hidden=false;
 const cards=document.getElementById('system-work-cards'),coverage=document.getElementById('system-work-coverage'),form=document.getElementById('system-work-filters');
 const more=document.getElementById('system-work-more'),library=document.getElementById('live-library'),error=document.getElementById('system-work-error');
 const dialog=document.getElementById('work-triage'),actionForm=document.getElementById('work-triage-form');
 let items=[],live=[],cursor=null,libraryMode=false,generation=0,current=null,loading=false,cursorQuery=null,pageCount=1;
 const operations=new Map();
 const operationId=(item,action)=>JSON.stringify([item.source,item.kind,item.id,action.action]);
 const args=()=>{const d=new FormData(form);return {text:d.get('text')||'',...(d.get('source')?{source:d.get('source')}:{}),...(d.get('kind')?{kinds:d.get('kind')}:{}),age:Number(d.get('age')||0),live_library:libraryMode,limit:100};};
 function openAction(item,action){
  const id=operationId(item,action);
  current={item,action,id,operation:operations.get(id)};actionForm.replaceChildren();
  const h=node('h2',`${action.action[0].toUpperCase()+action.action.slice(1)} · ${item.title}`);actionForm.append(h);
  for(const field of action.fields){const label=node('label',field.label);let input;
   if(field.choices){input=node('select');for(const c of field.choices){const option=node('option',c);option.value=c;input.append(option);}}
   else if(field.type==='number'){input=node('input');input.type='number';input.min=field.min;input.max=field.max;input.step='any';}
   else input=node('textarea');input.name=field.name;input.required=field.required;input.maxLength=4000;label.append(input);actionForm.append(label);
  }
  const status=node('p','','triage-status');status.setAttribute('role','status');actionForm.append(status);
  const button=node('button','Review and confirm');button.type='submit';actionForm.append(button);
  current.status=status;current.button=button;
  if(current.operation)showOperation(current);
  dialog.showModal();
 }
 function render(){
  cards.replaceChildren();
  for(const group of groupSystemWork(items)){
   const section=node('section','','work-source');section.append(node('h3',workLabel(group.items[0]?.kind)));
   const grid=node('div','','work-card-grid');
   for(const item of group.items){const article=node('article','','work-card');article.dataset.workId=item.id;
    const heading=node('h4'),detail=node('a',item.title||item.id);detail.href=workDetailUrl({board:'carr-v5',task:`${item.kind}:${item.id}`,workRequest:item.human_ref});if(openTask)detail.addEventListener('click',event=>{event.preventDefault();openTask({...item,id:`${item.kind}:${item.id}`});});heading.append(detail);
    const links=jobLinks(item);article.append(heading,node('p',`${links.workRequest?`Work Request ${links.workRequest}`:'Work Request unavailable'}${links.prLabel?` · ${links.prLabel}`:''}`,'work-card-links'),node('p',`${item.kind.replaceAll('_',' ')} · ${item.state} · ${item.age} days old${item.owner?` · ${item.owner}`:''}`,'work-card-meta'));
    if(item.suggested_triage)article.append(node('p',`${item.suggested_triage.label}: ${item.suggested_triage.action}`,'work-suggestion'));
    const actions=node('div','','work-actions');for(const action of item.available_triage_actions||[]){const b=node('button',action.action);b.type='button';b.addEventListener('click',()=>openAction(item,action));actions.append(b);}
    const link=node('a','Details');link.href=item.link||'/system-work.html';if(openTask)link.addEventListener('click',event=>{event.preventDefault();openTask({...item,id:`${item.kind}:${item.id}`});});actions.append(link);article.append(actions);if(openTask)article.addEventListener('click',event=>{if(!event.target.closest('a,button,input,select,textarea'))openTask({...item,id:`${item.kind}:${item.id}`});});grid.append(article);
   }section.append(grid);cards.append(section);
  }
  if(!items.length)cards.append(node('p',libraryMode?'No completed work matches these filters.':'No unfinished work matches these filters.','empty'));
  more.hidden=!cursor;
 }
 function resultText(result){
  if(!result||result.ok!==true)return 'The result is unconfirmed. Replay the original request before another attempt.';
  const counts=Number.isInteger(result.confirmed)&&Number.isInteger(result.not_confirmed)?`${result.confirmed} confirmed · ${result.not_confirmed} not confirmed. `:'';
  const details=[];
  function describe(value){
   if(!value||typeof value!=='object')return;
   for(const [key,entry] of Object.entries(value)){
    if(['outcome','state','status','hint','message','safe_explanation'].includes(key)&&typeof entry==='string')details.push(entry);
    else if(entry&&typeof entry==='object')describe(entry);
   }
  }
  describe(result);
  return `Result: ${counts}${[...new Set(details)].join(' · ')||'Update confirmed.'}`;

 }
 function showOperation(view){
  const op=view.operation;if(!op)return;
  view.status.textContent=op.text||'Updating…';
  view.button.disabled=['preparing','pending','answered'].includes(op.state);
  view.button.textContent=op.state==='unknown'?'Reconcile original request':'Review and confirm';
  for(const field of view.action.fields){const input=actionForm.elements.namedItem(field.name);input.disabled=['preparing','pending','unknown','answered'].includes(op.state);if(op.values)input.value=op.values[field.name]??'';}
  if(op.state==='answered'&&!actionForm.querySelector('[data-receipt-close]')){
   const close=node('button','Close');close.type='button';close.dataset.receiptClose='true';
   close.addEventListener('click',()=>{
    if(operations.get(view.id)===op)operations.delete(view.id);
    dialog.close();refresh(false,{force:true});
   });actionForm.append(close);
  }
 }
 function showCoverage(read,label){
  const span=node('span',`${label} · `);
  const clock=node('time',updatedLabel(read.source?.observed_at||read.as_of));
  clock.title=read.source?.observed_at||read.as_of||'Update time unavailable';span.append(clock);
  if((read.source?.freshness||read.freshness)==='unknown')span.append(node('span',' · Update time unavailable'));
  if(!read.census_complete){
   const missing=read.coverage.filter(c=>c.state!=='complete');
   span.append(node('span',' · Updates incomplete'));
   for(const c of missing){const issue=node('span',` · ${workLabel(c.kind)} unavailable`);if(c.observed_at){const time=node('time',` (${updatedLabel(c.observed_at)})`);time.title=c.observed_at;issue.append(time);}span.append(issue);}
  }
  return span;
 }
 async function refresh(append=false,{force=false}={}){
  if(append&&(loading||!cursor||cursorQuery!==JSON.stringify(args())))return;
  if(!force&&!append&&(loading||dialog.open||cards.contains(document.activeElement)))return;
  const gen=++generation,queryArgs=args(),signature=JSON.stringify(queryArgs);
  // Retained cards keep their continuation until replacement cards commit.
  // Query transitions invalidate it immediately; loading blocks all appends.
  if(!append&&cursorQuery!==signature){cursor=null;cursorQuery=null;more.hidden=true;}
  loading=true;more.disabled=true;error.hidden=true;
  try{
   const query={...queryArgs,...(append?{cursor}: {})};
   let read=validSystemWork(await client.unfinishedWork(query));if(gen!==generation)return;
   if(!append&&!force&&pageCount>1){for(let page=1;page<pageCount&&read.next_cursor;page++){const next=validSystemWork(await client.unfinishedWork({...queryArgs,cursor:read.next_cursor}));if(gen!==generation)return;read={...next,items:[...read.items,...next.items]};}}
   let liveRead=null,liveError=null;
   if(!queryArgs.live_library){try{liveRead=validSystemWork(await client.unfinishedWork({live_library:true,limit:10}));}catch(cause){if(cause.status===401||cause.status===403)throw cause;liveError=cause;}}
   if(gen!==generation)return;
   // A background read can finish after keyboard focus has entered a card.
   if(!force&&!append&&(dialog.open||cards.contains(document.activeElement)))return;
   pageCount=append?pageCount+1:force?1:pageCount;
   items=append?[...items,...read.items]:read.items;cursor=read.next_cursor;cursorQuery=signature;
   coverage.replaceChildren(showCoverage(read,queryArgs.live_library?'Live Library':'Unfinished'));
   if(liveRead)coverage.append(node('span',' · '),showCoverage(liveRead,'Live'));
   else if(liveError)coverage.append(node('span',' · Recent completions unavailable'));
   const refreshButton=node('button','↻');refreshButton.type='button';refreshButton.className='icon-btn';refreshButton.setAttribute('aria-label','Refresh');refreshButton.title='Refresh';refreshButton.addEventListener('click',()=>refresh(false,{force:true}));coverage.append(refreshButton);
   for(const [name,key] of [['source','source_ref'],['kind','kind']]){
    const select=form.elements.namedItem(name),selected=select.value;
    for(const c of read.coverage){const value=c[key];if(value&&![...select.options].some(o=>o.value===value)){const option=node('option',workLabel(c.kind));option.value=value;select.append(option);}}
    select.value=selected;
   }
   render();
   if(!queryArgs.live_library){if(liveRead)live=liveRead.items;onPipeline(systemPipeline(items,live));}
  }catch(cause){if(gen!==generation)return;error.textContent=cause.status===401?'Sign in to view system work.':'System work updates unavailable.';error.hidden=false;
   if(cause.status===401||cause.status===403){items=[];live=[];cursor=null;render();onPipeline(systemPipeline([],[]));}}
  finally{if(gen===generation){loading=false;more.disabled=false;}}
 }
 form.addEventListener('submit',event=>{event.preventDefault();refresh(false,{force:true});});
 form.addEventListener('change',()=>refresh(false,{force:true}));
 more.addEventListener('click',()=>refresh(true));
 library.addEventListener('click',()=>{libraryMode=!libraryMode;library.textContent=libraryMode?'Unfinished work':'Live Library';library.setAttribute('aria-pressed',String(libraryMode));refresh(false,{force:true});});
 actionForm.addEventListener('submit',async event=>{
  event.preventDefault();if(!current)return;
  const view=current;
  if(view.operation&&['preparing','pending','answered'].includes(view.operation.state))return;
  const values=Object.fromEntries(new FormData(actionForm));
  const op=view.operation?.state==='unknown'?view.operation:{state:'preparing',key:uuidv4(),values};
  view.operation=op;operations.set(view.id,op);view.button.disabled=true;
  try{
   let response;
   if(op.request){op.state='pending';showOperation(view);response={result:await client.triageSystemWork(op.request.verb,structuredClone(op.request.args))};}
   else response=await triageWork(client,view.item,view.action.action,values,{idempotencyKey:op.key,confirm:message=>globalThis.confirm(message),onPrepared:request=>{op.request=request;op.state='pending';if(current?.operation===op&&dialog.open)showOperation(current);}});
   if(response.cancelled){op.state='refused';op.text='No change requested.';operations.delete(view.id);}
   else {op.state=response.result?.ok===true?'answered':'unknown';op.text=resultText(response.result);}
  }catch(cause){
   // A generic MCP exception or a transport failure may follow a committed write.
   const refusal=['version_conflict','invalid_input','validation_error','forbidden','unauthorized','not_found','action_not_available'].includes(cause.payload?.error)||[400,401,403,409,422].includes(cause.status);
   const unknown=Boolean(op.request)&&!refusal;
   op.state=unknown?'unknown':'refused';
   op.text=unknown?'The result is unconfirmed. Reconcile the original request before another attempt.':cause.payload?.error?`Action unavailable: ${workLabel(cause.payload.error)}.`:cause.message;
   if(!unknown)operations.delete(view.id);
  }
  if(current?.operation===op&&dialog.open)showOperation(current);
 });
 document.getElementById('work-triage-close').addEventListener('click',()=>dialog.close());
 refresh();return {refresh};
}
