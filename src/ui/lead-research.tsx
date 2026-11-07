import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';

type Finding = { flag_id: string; kind: string; found: boolean; expired: boolean; proposes_correction: boolean; source: string; observed_at: string; expires_on?: string | null; value: unknown };
type Research = { state: 'needs_research' | 'needs_review' | 'verified'; next_step: string; evidence: Finding[] };
type Attention = '' | 'correction' | 'expired' | 'nothing';
type AttentionOptions = { attention?: Attention; onAttention?: (attention: Attention) => void };
const attentionOptions = { '': 'All findings', correction: 'Proposed corrections', expired: 'Expired findings', nothing: 'Nothing found' };
const labels = { needs_research: 'Needs research', needs_review: 'Needs review', verified: 'Verified' };
function factText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(factText).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${key}: ${factText(item)}`).join('; ')}}`;
  return value == null ? 'null' : String(value);
}
function instant(value: string) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts || parts[0] !== value || value.length > 64) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]), hour = Number(parts[4]), minute = Number(parts[5]), second = Number(parts[6]), offsetHour = Number(parts[7]), offsetMinute = Number(parts[8]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(day >= 1 && day <= (days[month - 1] ?? 0) && hour < 24 && minute < 60 && second < 60 && (Number.isNaN(offsetHour) || offsetHour < 24 && offsetMinute < 60))) return null;
  return new Date(value);
}
function Dates({ item }: { item: Finding }) {
  const observed = instant(item.observed_at);
  const expiry = typeof item.expires_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.expires_on) ? instant(`${item.expires_on}T12:00:00Z`) : null;
  return <><p className="research-observed">{observed ? <>Observed <time dateTime={item.observed_at}>{observed.toLocaleString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</time></> : 'Observed time unavailable'}</p>
    <p className="research-expires-on">{item.expires_on == null ? 'Expiry unrecorded' : expiry ? <>Expires on <time dateTime={item.expires_on}>{expiry.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })}</time></> : 'Expiry date unavailable'}</p></>;
}
function LeadResearch({ research, selected, onSelect, options }: { research: Research | undefined; selected: string; onSelect: (kind: string) => void; options: AttentionOptions }) {
  const kinds = [...new Set(research?.evidence.map(item => item.kind).filter(kind => kind.trim()) || [])];
  const [kind, setKind] = useState(kinds.includes(selected) ? selected : '');
  const [attention, setAttention] = useState<Attention>(options.attention ?? '');
  const findings = research?.evidence.filter(item => (!kind || item.kind === kind) && (attention === '' || attention === 'correction' && item.proposes_correction === true || attention === 'expired' && item.expired === true || attention === 'nothing' && item.found === false)) || [];
  return <section className="detail-panel" id="sourcedResearch"><h3>Sourced research</h3>
    {!research ? <p>Sourced research was not included in this read.</p> : <>
      <p>{labels[research.state]}</p><p>{research.next_step}</p>
      {research.evidence.length === 0 ? <p>No sourced findings.</p> : <>
        <label>Finding kind<select aria-label="Finding kind" id="researchKind" value={kind} style={{ maxWidth: '100%' }} onChange={event => { setKind(event.target.value); onSelect(event.target.value); }}><option value="">All finding kinds</option>{kinds.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Finding attention<select aria-label="Finding attention" id="researchAttention" value={attention} style={{ maxWidth: '100%' }} onChange={event => {
          const value = event.target.value;
          if (value === '' || value === 'correction' || value === 'expired' || value === 'nothing') { setAttention(value); options.onAttention?.(value); }
        }}>{Object.entries(attentionOptions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <small>Matching findings</small>
        <p role="status" aria-label="Matching findings out of total loaded">{findings.length} of {research.evidence.length} loaded findings</p>
        {findings.length === 0 ? <p>No matching findings.</p> : <ol className="research-facts">{findings.map(item => <li key={item.flag_id} data-flag-id={item.flag_id}><strong>{item.kind ? item.kind[0]?.toUpperCase() + item.kind.slice(1).replaceAll('_', ' ') : 'Finding'}{item.proposes_correction ? ' · Proposed correction' : ''}</strong><p className="research-finding">{item.found ? 'Finding recorded.' : 'Nothing found.'} {factText(item.value)}</p><Dates item={item} />{item.expired && <p className="research-expiry">Expired</p>}{item.source.trim() && <p className="research-source">Source: {/^https:\/\/\S+$/.test(item.source.trim()) ? <a href={item.source.trim()}>{item.source.trim()}</a> : item.source.trim()}</p>}</li>)}</ol>}
      </>}
    </>}
  </section>;
}
export function mountLeadResearch(host: HTMLElement, research: Research | undefined, selected = '', onSelect: (kind: string) => void = () => {}, options: AttentionOptions = {}) {
  const root = createRoot(host);
  flushSync(() => root.render(<LeadResearch research={research} selected={selected} onSelect={onSelect} options={options} />));
  return { dispose() { flushSync(() => root.unmount()); } };
}
