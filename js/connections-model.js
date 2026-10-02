export const CONNECTION_NAMES = Object.freeze({claude:'Claude',codex:'Codex',grok:'Grok',jev:'Jev',tailscale:'Tailscale',neon:'Neon',github:'GitHub',cloudflare:'Cloudflare',local_compute:'Local compute',model_route:'Model tools'});
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const safeUrl = value => { try { if(typeof value!=='string')return null; if(/^\/(?!\/)/.test(value))return value; const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };
export function connectionView(payload) {
 const valid=payload?.ok===true&&payload.schema==='doctorcre-connections.v1'&&Array.isArray(payload.providers);
 const providers=Object.entries(CONNECTION_NAMES).map(([id,name])=>{
  const matches=valid?payload.providers.filter(p=>p.id===id):[];
  const row=matches.length===1?matches[0]:{};
  const status=['connected','needs_reconnect'].includes(row.status)&&time(row.checked_at)?row.status:'unknown';
  const meter=row.spend;
  const spend=meter && Number.isFinite(meter.amount) && meter.amount>=0 && /^[A-Z]{3}$/.test(meter.currency) && ['charge','estimate'].includes(meter.kind) && typeof meter.period==='string' && meter.period.trim() && time(meter.as_of) ? {...meter}:null;
  return {id,name,status,label:{connected:'Connected',needs_reconnect:'Needs reconnect',unknown:'Status unavailable'}[status],checked_at:time(row.checked_at)?row.checked_at:null,manage_url:safeUrl(row.manage_url),spend};
 });
 const devices=valid&&payload.devices?.state==='read'&&time(payload.devices.observed_at)&&Array.isArray(payload.devices.items)?payload.devices.items:null;
 return {providers,generated_at:valid&&time(payload.generated_at)?payload.generated_at:null,devices:devices?.map(d=>({id:d.id,name:d.name || 'Device',status:typeof d.connected==='boolean'?d.connected?'connected':'offline':'unknown',checked_at:payload.devices.observed_at})) || null};
}
export function meteredSpend(meter) {
 if(!meter)return 'Spend unavailable';
 try {return `${new Intl.NumberFormat('en-US',{style:'currency',currency:meter.currency}).format(meter.amount)}${meter.kind==='estimate'?' estimated':''} · ${meter.period}`;}
 catch {return 'Spend unavailable';}
}
