import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Strategy = {
  basis: string | null; objective: string | null; discovery: string[];
  decision_window: string | null; confidence: string | null; next_step: string | null;
  channel: string | null; risk: string | null;
};
type Guidance = { advice: string | null; restricted: boolean; strategy: Strategy };
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
const adviceStages = new Set(['new', 'qualified', 'outreach_active', 'engaged', 'nurture_drip',
  'opportunity', 'active_deal', 'closed_won', 'closed_lost']);
function parseGuidance(value: unknown): Guidance {
  const lead = record(value), strategy = record(lead.strategy);
  return { advice: text(lead.handling_advice),
    restricted: lead.suppressed === true || lead.contact_eligible === false || !adviceStages.has(text(lead.stage) || ''),
    strategy: { basis: text(strategy.basis), objective: text(strategy.objective),
      discovery: Array.isArray(strategy.discovery) ? strategy.discovery.flatMap(value => text(value) ? [String(value)] : []) : [],
      decision_window: text(strategy.decision_window), confidence: text(strategy.confidence),
      next_step: text(strategy.next_step), channel: text(strategy.channel), risk: text(strategy.risk) } };
}
function LeadGuidance({ advice, restricted, strategy }: Guidance) {
  return <section className="detail-panel lead-guidance" aria-labelledby="handlingAdviceTitle">
    <h3 id="handlingAdviceTitle">Handling advice</h3>
    {restricted && <p className="lead-guidance-restriction"><strong>Contact restriction. Review the recorded hold before outreach.</strong></p>}
    <p>{advice || 'Handling advice unavailable.'}</p>
    <details data-entry-key="lead-strategy"><summary>Strategy</summary>
      <p>{strategy.basis === 'stage_based_guidance'
        ? 'Stage-based suggestions, not verified prospect intent.' : 'Strategy basis unavailable.'}</p>
      <dl><dt>Objective</dt><dd>{strategy.objective || 'Unavailable'}</dd>
        <dt>Discovery prompts</dt><dd>{strategy.discovery.length
          ? <ul>{strategy.discovery.map((prompt, index) => <li key={index}>{prompt}</li>)}</ul> : 'Unavailable'}</dd>
        <dt>Decision window</dt><dd>{strategy.decision_window || 'Unavailable'}</dd>
        <dt>Confidence</dt><dd>{strategy.confidence || 'Unavailable'}</dd>
        <dt>Next step</dt><dd>{strategy.next_step || 'Unavailable'}</dd>
        <dt>Channel</dt><dd>{strategy.channel || 'Unavailable'}</dd>
        <dt>Risk</dt><dd>{strategy.risk || 'Unavailable'}</dd></dl>
    </details>
  </section>;
}
export function mountLeadGuidance(host: HTMLElement, detail: unknown) {
  const root = createRoot(host);
  flushSync(() => root.render(<LeadGuidance {...parseGuidance(detail)} />));
  return { dispose() { flushSync(() => root.unmount()); } };
}
