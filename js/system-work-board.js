import {uuidv4} from './uuid.js';
import {validSystemWork,groupSystemWork,systemPipeline,triageWork} from './system-work-board-model.js';
const node=(tag,text,className)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;};
export function mountSystemWorkBoard({client,onPipeline}){
 const panel=document.getElementById('system-work-panel');panel.hidden=false;
 const cards=document.getElementById('system-work-cards'),coverage=document.getElementById('system-work-coverage'),form=document.getElementById('system-work-filters');
 const more=document.getElementById('system-work-more'),library=document.getElementById('live-library'),error=document.getElementById('system-work-error');
 const dialog=document.getElementById('work-triage'),actionForm=document.getElementById('work-triage-form');
 let items=[],live=[],cursor=null,libraryMode=false,generation=0,current=null;
 const args=()=>{const d=new FormData(form);return {text:d.get('text')||'',...(d.get('source')?{source:d.get('source')}:{}),...(d.get('kind')?{kinds:d.get('kind')}:{}),age:Number(d.get('age')||0),live_library:libraryMode,limit:100};};
 function openAction(item,action){
  current={item,action,key:uuidv4()};actionForm.replaceChildren();
  const h=node('h2',`${action.action[0].toUpperCase()+action.action.slice(1)} · ${item.title}`);actionForm.append(h);
  for(const field of action.fields){const label=node('label',field.label);let input;
   if(field.choices){input=node('select');for(const c of field.choices){const option=node('option',c);option.value=c;input.append(option);}}
   else if(field.type==='number'){input=node('input');input.type='number';input.min=field.min;input.max=field.max;input.step='any';}
   else input=node('textarea');input.name=field.name;input.required=field.required;input.maxLength=4000;label.append(input);actionForm.append(label);
  }
  const status=node('p','','triage-status');status.setAttribute('role','status');actionForm.append(status);
  const button=node('button','Review and confirm');button.type='submit';actionForm.append(button);dialog.showModal();
 }
 function render(){
  cards.replaceChildren();
  for(const group of groupSystemWork(items)){
   const section=node('section','','work-source');section.append(node('h3',group.source));
   const grid=node('div','','work-card-grid');
   for(const item of group.items){const article=node('article','','work-card');article.dataset.workId=item.id;
    article.append(node('h4',item.title||item.id),node('p',`${item.kind.replaceAll('_',' ')} · ${item.state} · ${item.age} days old${item.owner?` · ${item.owner}`:''}`,'work-card-meta'));
    if(item.suggested_triage)article.append(node('p',`${item.suggested_triage.label}: ${item.suggested_triage.action}`,'work-suggestion'));
    const actions=node('div','','work-actions');for(const action of item.available_triage_actions||[]){const b=node('button',action.action);b.type='button';b.addEventListener('click',()=>openAction(item,action));actions.append(b);}
    const link=node('a','Open source');link.href=item.link||'/system-work.html';actions.append(link);article.append(actions);grid.append(article);
   }section.append(grid);cards.append(section);
  }
  if(!items.length)cards.append(node('p',libraryMode?'No completed work matches these filters.':'No unfinished work matches these filters.','empty'));
  more.hidden=!cursor;
 }
 async function refresh(append=false){
  if((dialog.open||cards.contains(document.activeElement))&&!append)return;
  const gen=++generation;error.hidden=true;
  try{
   const query={...args(),...(append&&cursor?{cursor}: {})};
   const read=validSystemWork(await client.unfinishedWork(query));if(gen!==generation)return;
   items=append?[...items,...read.items]:read.items;cursor=read.next_cursor;
   const failures=read.coverage.filter(c=>c.state!=='complete');
   coverage.textContent=`${read.coverage.reduce((n,c)=>n+(c.count_total??0),0)} ${libraryMode?'completed':'unfinished'} items · ${read.census_complete?'All selected sources read':`Incomplete census: ${failures.map(c=>`${c.kind}: ${c.reason}`).join(' · ')}`}`;
   for(const [name,key] of [['source','source_ref'],['kind','kind']]){
    const select=form.elements.namedItem(name);const selected=select.value;
    for(const c of read.coverage){const value=c[key];if(![...select.options].some(o=>o.value===value)){const option=node('option',value);option.value=value;select.append(option);}}
    select.value=selected;
   }
   render();
   if(!libraryMode){const r=validSystemWork(await client.unfinishedWork({live_library:true,limit:10}));if(gen!==generation)return;live=r.items;onPipeline(systemPipeline(items,live));}
   render();
  }catch(cause){if(gen!==generation)return;error.textContent=cause.status===401?'Sign in to read system work.':'System work read failed. Showing the last read; retry to refresh.';error.hidden=false;
   if(cause.status===401||cause.status===403){items=[];live=[];cursor=null;render();onPipeline(systemPipeline([],[]));}}
 }
 form.addEventListener('submit',event=>{event.preventDefault();refresh();});
 form.addEventListener('change',()=>refresh());
 more.addEventListener('click',()=>refresh(true));
 library.addEventListener('click',()=>{libraryMode=!libraryMode;library.textContent=libraryMode?'Unfinished work':'Live Library';library.setAttribute('aria-pressed',String(libraryMode));refresh();});
 actionForm.addEventListener('submit',async event=>{
  event.preventDefault();if(!current)return;const button=actionForm.querySelector('button');button.disabled=true;
  const status=actionForm.querySelector('.triage-status'),values=Object.fromEntries(new FormData(actionForm));
  try{const response=await triageWork(client,current.item,current.action.action,values,{idempotencyKey:current.key,confirm:message=>globalThis.confirm(message)});
   if(response.cancelled){button.disabled=false;status.textContent='No change requested.';return;}
   status.textContent=`${current.action.action} saved. ${response.result?.hint||response.result?.message||'The source recorded the result.'}`;
   const close=node('button','Close');close.type='button';close.addEventListener('click',()=>{dialog.close();refresh();});actionForm.append(close);
  }catch(cause){status.textContent=cause.payload?.error?`The source refused this action: ${cause.payload.error}. Refresh before trying again.`:cause.message||'The result is unconfirmed. Read the source before another attempt.';}
 });
 document.getElementById('work-triage-close').addEventListener('click',()=>dialog.close());
 refresh();return {refresh};
}
