import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const STATUS = { complete: 'Recorded complete', received: 'Received', not_recorded: 'Not recorded', due: 'Due today', overdue: 'Overdue', upcoming: 'Upcoming' };
type Status = keyof typeof STATUS;
type Row = { id: string; label: string; status: Status; due_on?: string | null };
type Item = Row & { evidence_ref?: string | null; source: { document?: string | null; request?: string | null; record_verb?: string | null; version?: string | number | null } };
type Snapshot = { schema_version: string; template_state: string; phases: {label: string; items: Item[]}[]; due_items: Row[] };
type Props = { dealId: string; checklist: unknown };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const optionalText = (v: unknown) => v == null || typeof v === 'string';
const status = (v: unknown): v is Status => typeof v === 'string' && Object.hasOwn(STATUS, v);
const row = (v: unknown): v is Row => object(v) && text(v.id) && text(v.label) && status(v.status) && optionalText(v.due_on);
function item(v: unknown): v is Item {
  if (!object(v) || !optionalText(v.evidence_ref) || !object(v.source)) return false;
  const source = v.source;
  const refs = [source.document, source.request, source.record_verb];
  return row(v) && refs.every(optionalText) && refs.some(text) && (optionalText(source.version) || typeof source.version === 'number' && Number.isFinite(source.version));
}
export function isDealChecklistSnapshot(v: unknown): v is Snapshot {
  return object(v) && typeof v.schema_version === 'string' && typeof v.template_state === 'string'
    && Array.isArray(v.phases) && v.phases.every(p => object(p) && text(p.label) && Array.isArray(p.items) && p.items.every(item))
    && Array.isArray(v.due_items) && v.due_items.every(i => row(i) && text(i.due_on));
}
const date = (value: string) => {
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'});
};
function Checklist({ checklist }: Props) {
  const [selection, select] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<Set<string>>(() => new Set());
  const unavailable = object(checklist) && checklist.template_state === 'unavailable';
  const unsupported = !object(checklist) || checklist.schema_version !== 'deal-checklist.v1';
  const changed = object(checklist) && checklist.template_state === 'source_changed';
  if (unavailable || unsupported || changed || !isDealChecklistSnapshot(checklist)) {
    const message = unavailable ? 'Requirements could not be read.' : changed && !unsupported ? 'Checklist needs a doctrine review.' : 'Checklist unavailable.';
    return <section className="deal-checklist" aria-label="Deal checklist"><h3>Deal checklist</h3><p role="status">{message}</p>{checklist != null && (!changed || unavailable || unsupported) ? <button className="btn" type="button" data-refresh-detail data-detail-focus="checklist">Refresh deal</button> : null}</section>;
  }
  const total = checklist.phases.reduce((n,p) => n + p.items.length, 0);
  const phases = checklist.phases.map(p => ({...p, items:p.items.filter(i => selection === 'all' || ['not_recorded','due','overdue','upcoming'].includes(i.status))})).filter(p => p.items.length);
  const matching = phases.reduce((n,p) => n + p.items.length, 0);
  const next = checklist.due_items[0];
  return <details className="deal-checklist" open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary data-detail-focus="checklist"><span>Deal checklist{checklist.due_items.length ? ` · ${checklist.due_items.length} due` : ''}</span>{next ? <span className="checklist-next"><strong>{next.label}</strong><span>{STATUS[next.status]} · <time dateTime={next.due_on ?? undefined}>{date(next.due_on || '')}</time></span></span> : null}</summary>
    {checklist.template_state === 'deal_type_unknown' ? <p>Confirm the deal type to see its full checklist.</p> : null}
    <label>Requirements view <select aria-label="Requirements view" value={selection} onChange={e => select(e.target.value)}><option value="all">All requirements</option><option value="outstanding">Outstanding requirements</option></select></label>
    <p data-checklist-count role="status">{matching} matching of {total} recorded requirements.</p>
    {!total ? <p>No requirements recorded.</p> : !matching ? <p>All recorded requirements are received or complete.</p> : null}
    {phases.map(phase => <section key={phase.label}><h3>{phase.label}</h3><ul>{phase.items.map(i => <li key={i.id} data-checklist-item={i.id} data-state={i.status}>
      <span>{i.label}</span><strong>{STATUS[i.status]}</strong>{i.due_on ? <time dateTime={i.due_on}>{date(i.due_on)}</time> : null}
      <details open={evidence.has(i.id)} onToggle={e => { const open = e.currentTarget.open; setEvidence(current => { if(current.has(i.id) === open) return current; const updated = new Set(current); if(open) updated.add(i.id); else updated.delete(i.id); return updated; }); }}><summary>Evidence and source</summary><p>{i.evidence_ref || 'No completion evidence recorded.'}</p><p>{[i.source.document,i.source.request,i.source.record_verb].find(text)}{i.source.version ? ` · version ${i.source.version}` : ''}</p></details>
    </li>)}</ul></section>)}
  </details>;
}
export function mountDealChecklist(host: HTMLElement, initial: Props) {
  const root = createRoot(host);
  let disposed = false;
  function update(props: Props) {
    if (disposed) return;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    flushSync(() => root.render(<Checklist key={props.dealId} {...props}/>));
    if (focused && !focused.isConnected) {
      const target = host.querySelector<HTMLElement>('[data-detail-focus="checklist"]') || host.closest('#panelBody')?.querySelector<HTMLElement>('.deal-freshness [data-refresh-detail]');
      target?.focus({preventScroll:true});
    }
  }
  update(initial);
  return { update, dispose() { if(disposed) return; disposed = true; root.unmount(); } };
}
