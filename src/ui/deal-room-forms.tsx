import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState, type SelectHTMLAttributes, type InputHTMLAttributes } from 'react';

type Option = [value: string, label: string];
export type DealRoomForm =
  | { kind: 'next-step'; text: string; date: string; pending: boolean }
  | { kind: 'park' }
  | { kind: 'market-agent'; agent: string; market: string }
  | { kind: 'team-deal'; pending: null | { name: string; client: string; deal_type?: string; phase?: string; market?: string; segment?: string }; phases: Option[] }
  | { kind: 'account'; owners: Option[] }
  | { kind: 'market-deal'; accountName: string; existing: boolean }
  | { kind: 'account-owner'; owner: string }
  | { kind: 'conflict'; choices: { side: string; caption: string; actor: string; value: string }[] };

type Candidates = { hint?: string; candidates: { id: string; name: string }[]; held: boolean; onEdit: () => void };

type TextFieldProps = Pick<InputHTMLAttributes<HTMLInputElement>, 'type' | 'required' | 'disabled' | 'defaultValue' | 'placeholder' | 'maxLength'> & {
  field: [id: string, name: string, label: string]; hint?: string; multiline?: boolean;
};
function TextField({ field: [id, name, label], hint, multiline, ...props }: TextFieldProps) {
  return <div className="field"><label htmlFor={id}>{label}</label>{multiline ? <textarea id={id} name={name} {...props} /> : <input id={id} name={name} {...props} />}{hint && <small>{hint}</small>}</div>;
}

function SelectField({ field: [id, name, label], hint, children, ...props }: Pick<SelectHTMLAttributes<HTMLSelectElement>, 'required' | 'defaultValue' | 'onChange'> & {
  field: [id: string, name: string, label: string]; hint?: string; children: [string, string][];
}) {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} name={name} {...props}>{children.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select>{hint && <small>{hint}</small>}</div>;
}

function researchFields(disabled = false) {
  return <fieldset disabled={disabled}><legend>Research for the new organization or sub-client</legend>
    <p>Review sources before creating this record. Link the source you checked for each field, including a source documenting unavailable information. A source may support several fields.</p>
    {['Name', 'Company', 'Phone', 'Specialty', 'Market'].map(label => {
      const name = `research_${label.toLowerCase()}`;
      return <TextField key={name} field={[name, name, `${label} source (HTTPS URL)`]} type="url" required />;
    })}
    <TextField field={["researchObserved", "research_observed_at", "When did you review these sources?"]} hint="Enter the observation time in your local time zone." type="datetime-local" required />
    <TextField field={["researchDiscrepancies", "research_discrepancies", "Discrepancies found (optional)"]} placeholder="One discrepancy per line; leave blank if none." multiline />
  </fieldset>;
}

function MarketDealFields({ accountName, existing }: Extract<DealRoomForm, { kind: 'market-deal' }>) {
  const [mode, setMode] = useState(existing ? 'existing' : 'new');
  return <>
    <SelectField field={["marketClientMode", "client_mode", "Sub-client"]} defaultValue={mode} onChange={event => setMode(event.currentTarget.value)}>{[["new", "New sub-client"], ["existing", "Existing researched sub-client"]]}</SelectField>
    <TextField field={["marketClient", "client_name", "Franchisee / local client"]} hint={`For an existing researched sub-client, enter its exact name under ${accountName}. An unmatched name requires new research.`} required />
    <TextField field={["marketDealName", "deal_name", "Deal name"]} required />
    <div className="field-row"><TextField field={["marketCity", "market", "Market"]} required placeholder="City" /><TextField field={["marketState", "state", "State"]} maxLength={2} /></div>
    <div className="field-row"><TextField field={["marketAgent", "agent_name", "Assigned agent"]} placeholder="Leave blank if unknown" /><TextField field={["marketSegment", "segment", "Healthcare vertical"]} /></div>
    <div id="marketResearch" hidden={mode === 'existing'}>{researchFields(mode === 'existing')}</div>
  </>;
}

function formFields(form: DealRoomForm) {
  switch (form.kind) {
    case 'next-step': return <>
      <TextField field={["stepText", "text", "What happens next?"]} hint="This becomes a real next action in today’s triage; the prior step stays in history." required disabled={form.pending} defaultValue={form.text} multiline />
      <TextField field={["stepDate", "next_date", "When?"]} type="date" disabled={form.pending} defaultValue={form.date} />
    </>;
    case 'park': return <>
      <p className="form-guidance">Parking removes this record from active counts, focus lists, and weekly agendas. Its Salesforce link, phase, history, and participants stay intact.</p>
      <SelectField field={["parkingReason", "reason", "Why is this not active work?"]} required>{[["prospect_never_active", "Prospect never became active work"], ["client_paused", "Client paused activity"], ["other", "Other / not active right now"]]}</SelectField>
      <TextField field={["parkingNote", "note", "Context (optional)"]} maxLength={500} placeholder="What would help when this record becomes active again?" multiline />
    </>;
    case 'market-agent': return <>
      <TextField field={["agentName", "agent_name", "Assigned local agent"]} required defaultValue={form.agent} placeholder="Agent’s full name" />
      <TextField field={["agentMarket", "market", "Market"]} defaultValue={form.market} placeholder="City, state" />
    </>;
    case 'team-deal': return form.pending ? <div className="field"><b>{form.pending.name}</b><p>{`Client: ${form.pending.client}`}</p><p>{[form.pending.deal_type || 'other', form.pending.phase || 'On Deck', form.pending.market || '', form.pending.segment || ''].join(' · ')}</p><small>Check creation outcome continues this saved deal.</small></div> : <>
      <TextField field={["clientRef", "client", "Existing client"]} hint="A deal always belongs to a client. This prevents free-floating or duplicate records." required placeholder="C-127 or exact client name" />
      <TextField field={["dealName", "name", "Record name"]} required />
      <div className="field-row"><SelectField field={["dealType", "deal_type", "Type"]}>{[["startup", "Startup"], ["relocation", "Relocation"], ["additional_office", "Additional office"], ["renewal", "Renewal"], ["expansion", "Expansion"], ["purchase", "Purchase"], ["other", "Other"]]}</SelectField>
        <SelectField field={["dealPhase", "phase", "Phase"]} defaultValue="On Deck">{form.phases}</SelectField></div>
      <div className="field-row"><TextField field={["dealMarket", "market", "Market"]} /><TextField field={["dealSegment", "segment", "Healthcare vertical"]} placeholder="Dental, Vet, DPC…" /></div>
    </>;
    case 'account': return <>
      <TextField field={["accountName", "name", "Brand / organization"]} hint="Creates one parent account. Market transactions will live under their own sub-clients." required />
      <div className="field-row"><SelectField field={["accountOwner", "owner", "Account owner"]}>{form.owners}</SelectField><TextField field={["accountVertical", "vertical", "Healthcare vertical"]} /></div>
      {researchFields()}
    </>;
    case 'market-deal': return <MarketDealFields {...form} />;
    case 'account-owner': return <SelectField field={["newAccountOwner", "owner", "Accountable partner"]} hint="This changes portfolio accountability only. Individual market-deal owners stay untouched." defaultValue={form.owner}>{[["joe", "Joe"], ["dell", "Dell"]]}</SelectField>;
    case 'conflict': return <><p>Review both values, then choose one. Both edits remain in the deal history.</p>{form.choices.map(choice => <div className="field" key={choice.side}><label><input type="radio" name="winner" value={choice.side} required /> <strong>{choice.caption}</strong>{` · ${choice.actor}: ${choice.value}`}</label></div>)}</>;
    default: {
      const unhandled: never = form;
      return unhandled;
    }
  }
}

export function mountDealRoomForm(target: HTMLElement, form: DealRoomForm, national?: { name: string | null; disabled: boolean }) {
  const root = createRoot(target);
  const render = (candidates: Candidates | null) => flushSync(() => root.render(<>
    {national?.name && <p>{`Check creation outcome for ${national.name} before starting another record.`}</p>}
    {national ? <fieldset id="nationalCreationFields" disabled={national.disabled}>{formFields(form)}</fieldset> : formFields(form)}
    {candidates && <div id="nationalCandidates"><p>{candidates.hint || 'An organization with this name already exists. Review it before creating a separate brand.'}</p>
      <ul>{candidates.candidates.map(candidate => <li key={candidate.id}>{`${candidate.name} (${candidate.id})`}</li>)}</ul>
      <p>Cancel to use the existing client. Continue only if this is a genuinely separate brand.</p>
      <div className="field"><label><input type="checkbox" name="confirm_separate" required defaultChecked={candidates.held} disabled={candidates.held} /> I reviewed these candidates and confirm this is a separate brand.</label></div>
      <button type="button" id="nationalEditDetails" disabled={candidates.held} onClick={candidates.onEdit}>Edit account details</button></div>}
  </>));
  render(null);
  return { candidates: render, dispose: () => root.unmount() };
}
