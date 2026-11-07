import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Activity = { id: string; version: number; source_ref: string; source_version: string | null };
type Evidence = { activity_id: string; activity_version: number };
type Deal = { deal_id: string; label: string; deal_version: number; evidence: Evidence[] };
export type Attribution = { schema: 'activity-deal-attribution.v1'; state: string; attribution: string; activity: Activity | null; direct: Deal | null; candidates: Deal[]; credited_activity_count: number; coverage: string };
export type PanelState = { kind: 'loading' } | { kind: 'failure' } | { kind: 'result'; value: Attribution };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const version = (v: unknown): v is number => Number.isInteger(v) && typeof v === 'number' && v >= 1;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => k in v);
function isActivity(v: unknown): v is Activity {
  return object(v) && keys(v,['id','version','source_ref','source_version']) && uuid(v.id) && version(v.version) && text(v.source_ref,500) && (v.source_version === null || typeof v.source_version === 'string' && v.source_version.length <= 200);
}
function isDeal(v: unknown): v is Deal {
  return object(v) && keys(v,['deal_id','label','deal_version','evidence']) && uuid(v.deal_id) && text(v.label,200) && !!v.label.trim() && version(v.deal_version) && Array.isArray(v.evidence) && v.evidence.length >= 1 && v.evidence.length <= 101 && v.evidence.every((e: unknown): e is Evidence => object(e) && keys(e,['activity_id','activity_version']) && uuid(e.activity_id) && version(e.activity_version)) && new Set(v.evidence.map(e => e.activity_id)).size === v.evidence.length;
}
export function parseActivityDealAttribution(input: unknown, activityId: string): Attribution {
  const invalid = (): never => { throw new Error('Invalid activity attribution'); };
  if (!object(input) || !keys(input,['schema','state','attribution','activity','direct','candidates','credited_activity_count','coverage'])) return invalid();
  const { schema, state, attribution, activity, direct, candidates, credited_activity_count, coverage } = input;
  if (schema !== 'activity-deal-attribution.v1' || typeof state !== 'string' || typeof attribution !== 'string' || typeof coverage !== 'string' || !(activity === null || isActivity(activity)) || !(direct === null || isDeal(direct)) || !Array.isArray(candidates) || candidates.length > 100 || !candidates.every(isDeal) || new Set(candidates.map(c => c.deal_id)).size !== candidates.length || ![0,1].includes(Number(credited_activity_count)) || typeof credited_activity_count !== 'number') return invalid();
  if (activity && activity.id !== activityId) return invalid();
  if (state === 'ready') {
    if (attribution !== 'direct' || credited_activity_count !== 1 || !direct || !activity || coverage !== 'complete' || candidates.length || !direct.evidence.some(e => e.activity_id === activity.id && e.activity_version === activity.version)) return invalid();
  } else {
    if (direct !== null || credited_activity_count !== 0) return invalid();
    if (state === 'needs_input') {
      if (!activity || !['complete','unknown'].includes(coverage) || attribution !== (candidates.length > 1 ? 'ambiguous' : candidates.length ? 'source_linked' : 'unresolved')) return invalid();
    } else if (!['empty','unavailable'].includes(state) || activity !== null || candidates.length || attribution !== (state === 'empty' ? 'unknown' : 'unavailable') || coverage !== (state === 'empty' ? 'unknown' : 'unavailable')) return invalid();
  }
  return {schema,state,attribution,activity,direct,candidates,credited_activity_count,coverage};
}
const labels: Record<string,string> = { direct: 'Direct deal attribution', source_linked: 'Source-linked deal needs review', ambiguous: 'Ambiguous deals need review', unresolved: 'Deal attribution unresolved', unknown: 'Activity attribution unknown', unavailable: 'Activity attribution unavailable' };
function DealLink({deal}: {deal: Deal}) {
  return <li><a href={`/deals?deal=${encodeURIComponent(deal.deal_id)}`}>{deal.label}</a></li>;
}
export function mountActivityAttributionView(host: HTMLElement, close: () => void, retry: () => void) {
  const root = createRoot(host);
  return {
    update(state: PanelState) {
      flushSync(() => root.render(<section aria-label="Activity deal attribution" style={{overflowWrap:'anywhere',maxWidth:'100%'}}>
        <button type="button" onClick={close}>Close attribution</button>
        {state.kind === 'loading' ? <p role="status">Loading deal attribution…</p> : state.kind === 'failure' ? <><p role="alert">Deal attribution could not be read.</p><button type="button" onClick={retry}>Retry attribution</button></> : <>
          <h4>{labels[state.value.attribution]}</h4><p>{state.value.credited_activity_count} credited activities</p>
          {state.value.direct ? <ul><DealLink deal={state.value.direct}/></ul> : null}
          {state.value.candidates.length ? <><p>Review candidates. These links receive no activity credit.</p><ul>{state.value.candidates.map(deal => <DealLink key={deal.deal_id} deal={deal}/>)}</ul></> : null}
          <p>Coverage {state.value.coverage}.</p>
          <details><summary>Version evidence</summary>
            {state.value.activity ? <p>Activity {state.value.activity.id}, version {state.value.activity.version}. Source {state.value.activity.source_ref}. Source version {state.value.activity.source_version ?? 'not recorded'}.</p> : <p>No activity version available.</p>}
            {[...(state.value.direct ? [state.value.direct] : []),...state.value.candidates].map(deal => <div key={deal.deal_id}><p>{deal.label}, deal version {deal.deal_version}.</p><ul>{deal.evidence.map(e => <li key={e.activity_id}>Activity {e.activity_id}, version {e.activity_version}.</li>)}</ul></div>)}
          </details>
        </>}
      </section>));
    },
    dispose() { root.unmount(); },
  };
}
