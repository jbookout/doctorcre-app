import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Strategy = {
  basis: string | null; objective: string | null; discovery: string[];
  decision_window: string | null; confidence: string | null; next_step: string | null;
  channel: string | null; risk: string | null;
};
const holdReasons = {
  suppressed: 'Suppressed.',
  contact_ineligible: 'Contact is ineligible.',
  unsupported_stage: 'Lead stage is not supported.',
};
type Hold = { kind: 'none' } | { kind: 'unavailable' } | { kind: 'held'; reason: keyof typeof holdReasons };
type Guidance = { advice: string | null; hold: Hold; strategy: Strategy };
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function parseHold(value: unknown): Hold {
  if (value === null) return { kind: 'none' };
  const { reason } = record(value);
  if (reason === 'suppressed' || reason === 'contact_ineligible' || reason === 'unsupported_stage') {
    return { kind: 'held', reason };
  }
  return { kind: 'unavailable' };
}
function parseGuidance(value: unknown): Guidance {
  const lead = record(value), strategy = record(lead.strategy);
  return { advice: text(lead.handling_advice),
    hold: parseHold(strategy.hold),
    strategy: { basis: text(strategy.basis), objective: text(strategy.objective),
      discovery: Array.isArray(strategy.discovery) ? strategy.discovery.flatMap(value => text(value) ? [String(value)] : []) : [],
      decision_window: text(strategy.decision_window), confidence: text(strategy.confidence),
      next_step: text(strategy.next_step), channel: text(strategy.channel), risk: text(strategy.risk) } };
}
function LeadGuidance({ advice, hold, strategy }: Guidance) {
  return <section className="detail-panel lead-guidance" aria-labelledby="handlingAdviceTitle">
    <h3 id="handlingAdviceTitle">Handling advice</h3>
    {hold.kind === 'held' && <p className="lead-guidance-restriction"><strong>Contact restriction. {holdReasons[hold.reason]} Review the recorded hold before outreach.</strong></p>}
    {hold.kind === 'unavailable' && <p className="lead-guidance-unavailable"><strong>Contact restriction guidance unavailable. Review the recorded restrictions before outreach.</strong></p>}
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
