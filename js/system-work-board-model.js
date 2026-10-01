import {taskStage} from './progress-board-model.js';
export const SYSTEM_WORK_CONTRACT = 'unfinished-work.v1';
// Producer revision is pinned in the app PR after the server source is committed.
export function validSystemWork(read) {
 if(read?.schema!==SYSTEM_WORK_CONTRACT||!Array.isArray(read.items)||!Array.isArray(read.coverage))throw new Error('System work read is unavailable.');
 return read;
}
export function groupSystemWork(items){
 const groups=new Map();for(const item of items){if(!groups.has(item.source))groups.set(item.source,[]);groups.get(item.source).push(item);}
 return [...groups].map(([source,items])=>({source,items}));
}
export function recentLive(items){return items.slice().sort((a,b)=>b.last_activity_at.localeCompare(a.last_activity_at)||a.id.localeCompare(b.id)).slice(0,10);}
export function systemPipeline(items,live){
 const stages=[['queued','Queued'],['build','Building'],['review','Review'],['ci','CI'],['merged','Merged'],['live','Live']].map(([id,label])=>({id,label,tasks:[]}));
 for(const item of [...items,...recentLive(live)]){
  const status=item.completed?'done':({in_progress:'running',claimed:'running',verification:'review',pending:'review',needs_revision:'review',monitoring:'review',investigating:'review'})[item.state]||item.state;
  const task={...item,id:`${item.kind}:${item.id}`,status,executor:item.owner,
    updated_at:item.last_activity_at,evidence:item.completed?'Canonical completion state':null,note:`${item.source} · ${item.age} days old`};
  const stage=item.completed?'live':taskStage({...task,stage:['ci','merged'].includes(item.state)?item.state:item.stage});
  stages.find(s=>s.id===stage).tasks.push(task);
 }
 return {stages};
}
export async function triageWork(client,item,actionName,values,{confirm,idempotencyKey,onPrepared}){
 // Re-read the source row immediately before confirmation; never increment a
 // version locally or trust the version attached to a rendered card.
 const read=validSystemWork(await client.unfinishedWork({kinds:item.kind,source:item.source,id:item.id,limit:1}));
 const fresh=read.items.find(r=>r.id===item.id&&r.kind===item.kind);
 const action=fresh?.available_triage_actions?.find(a=>a.action===actionName);
 if(!action)throw new Error('This action is no longer available. Refresh the card.');
 const args={...action.args,idempotency_key:idempotencyKey};
 for(const field of action.fields){
  const value=String(values[field.name]??'').trim();
  if(field.required&&!value)throw new Error(`Enter ${field.label.toLowerCase()}.`);
  if(field.choices&&!field.choices.includes(value))throw new Error('Choose an offered value.');
  if(value){
   if(field.type==='number'){const number=Number(value);if(!Number.isFinite(number)||number<field.min||number>field.max)throw new Error('Enter a number in the offered range.');args[field.name]=number;}
   else args[field.name]=value;
  }
 }
 if(action.versioned){const version=Number(fresh.version);if(!Number.isSafeInteger(version)||version<1)throw new Error('Current source version is unavailable.');if(action.verb==='approve-retrieval-proposals')args.base_versions={[fresh.id]:version};else args.base_version=version;}
 if(!await confirm(`${actionName[0].toUpperCase()+actionName.slice(1)} “${fresh.title}”?`))return {cancelled:true};
 const request={verb:action.verb,args};
 onPrepared?.(structuredClone(request));
 return {result:await client.triageSystemWork(request.verb,request.args),request};
}
