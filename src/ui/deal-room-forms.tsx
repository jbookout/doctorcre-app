import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState, type ReactNode } from 'react';

type Option = { value: string; label: string };
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

function Field({ id, label, children, hint }: { id: string; label: string; children: ReactNode; hint?: string }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <small>{hint}</small>}</div>;
}

function ResearchFields({ disabled = false }: { disabled?: boolean }) {
  return <fieldset disabled={disabled}><legend>Research for the new organization or sub-client</legend>
    <p>Review sources before creating this record. Link the source you checked for each field, including a source documenting unavailable information. A source may support several fields.</p>
    {['Name', 'Company', 'Phone', 'Specialty', 'Market'].map(label => {
      const name = `research_${label.toLowerCase()}`;
      return <Field key={name} id={name} label={`${label} source (HTTPS URL)`}><input id={name} name={name} type="url" required /></Field>;
    })}
    <Field id="researchObserved" label="When did you review these sources?" hint="Enter the observation time in your local time zone."><input id="researchObserved" name="research_observed_at" type="datetime-local" required /></Field>
    <Field id="researchDiscrepancies" label="Discrepancies found (optional)"><textarea id="researchDiscrepancies" name="research_discrepancies" placeholder="One discrepancy per line; leave blank if none." /></Field>
  </fieldset>;
}

function MarketDealFields({ accountName, existing }: Extract<DealRoomForm, { kind: 'market-deal' }>) {
  const [mode, setMode] = useState(existing ? 'existing' : 'new');
  return <>
    <Field id="marketClientMode" label="Sub-client"><select id="marketClientMode" name="client_mode" defaultValue={mode} onChange={event => setMode(event.currentTarget.value)}><option value="new">New sub-client</option><option value="existing">Existing researched sub-client</option></select></Field>
    <Field id="marketClient" label="Franchisee / local client" hint={`For an existing researched sub-client, enter its exact name under ${accountName}. An unmatched name requires new research.`}><input id="marketClient" name="client_name" required /></Field>
    <Field id="marketDealName" label="Deal name"><input id="marketDealName" name="deal_name" required /></Field>
    <div className="field-row"><Field id="marketCity" label="Market"><input id="marketCity" name="market" required placeholder="City" /></Field><Field id="marketState" label="State"><input id="marketState" name="state" maxLength={2} /></Field></div>
    <div className="field-row"><Field id="marketAgent" label="Assigned agent"><input id="marketAgent" name="agent_name" placeholder="Leave blank if unknown" /></Field><Field id="marketSegment" label="Healthcare vertical"><input id="marketSegment" name="segment" /></Field></div>
    <div id="marketResearch" hidden={mode === 'existing'}><ResearchFields disabled={mode === 'existing'} /></div>
  </>;
}

function FormFields({ form }: { form: DealRoomForm }) {
  switch (form.kind) {
    case 'next-step': return <>
      <Field id="stepText" label="What happens next?" hint="This becomes a real next action in today’s triage; the prior step stays in history."><textarea id="stepText" name="text" required disabled={form.pending} defaultValue={form.text} /></Field>
      <Field id="stepDate" label="When?"><input id="stepDate" name="next_date" type="date" disabled={form.pending} defaultValue={form.date} /></Field>
    </>;
    case 'park': return <>
      <p className="form-guidance">Parking removes this record from active counts, focus lists, and weekly agendas. Its Salesforce link, phase, history, and participants stay intact.</p>
      <Field id="parkingReason" label="Why is this not active work?"><select id="parkingReason" name="reason" required><option value="prospect_never_active">Prospect never became active work</option><option value="client_paused">Client paused activity</option><option value="other">Other / not active right now</option></select></Field>
      <Field id="parkingNote" label="Context (optional)"><textarea id="parkingNote" name="note" maxLength={500} placeholder="What would help when this record becomes active again?" /></Field>
    </>;
    case 'market-agent': return <>
      <Field id="agentName" label="Assigned local agent"><input id="agentName" name="agent_name" required defaultValue={form.agent} placeholder="Agent’s full name" /></Field>
      <Field id="agentMarket" label="Market"><input id="agentMarket" name="market" defaultValue={form.market} placeholder="City, state" /></Field>
    </>;
    case 'team-deal': return form.pending ? <div className="field"><b>{form.pending.name}</b><p>Client: {form.pending.client}</p><p>{form.pending.deal_type || 'other'} · {form.pending.phase || 'On Deck'} · {form.pending.market || ''} · {form.pending.segment || ''}</p><small>Check creation outcome continues this saved deal.</small></div> : <>
      <Field id="clientRef" label="Existing client" hint="A deal always belongs to a client. This prevents free-floating or duplicate records."><input id="clientRef" name="client" required placeholder="C-127 or exact client name" /></Field>
      <Field id="dealName" label="Record name"><input id="dealName" name="name" required /></Field>
      <div className="field-row"><Field id="dealType" label="Type"><select id="dealType" name="deal_type"><option value="startup">Startup</option><option value="relocation">Relocation</option><option value="additional_office">Additional office</option><option value="renewal">Renewal</option><option value="expansion">Expansion</option><option value="purchase">Purchase</option><option value="other">Other</option></select></Field>
        <Field id="dealPhase" label="Phase"><select id="dealPhase" name="phase" defaultValue="On Deck">{form.phases.map(phase => <option key={phase.value} value={phase.value}>{phase.label}</option>)}</select></Field></div>
      <div className="field-row"><Field id="dealMarket" label="Market"><input id="dealMarket" name="market" /></Field><Field id="dealSegment" label="Healthcare vertical"><input id="dealSegment" name="segment" placeholder="Dental, Vet, DPC…" /></Field></div>
    </>;
    case 'account': return <>
      <Field id="accountName" label="Brand / organization" hint="Creates one parent account. Market transactions will live under their own sub-clients."><input id="accountName" name="name" required /></Field>
      <div className="field-row"><Field id="accountOwner" label="Account owner"><select id="accountOwner" name="owner">{form.owners.map(owner => <option key={owner.value} value={owner.value}>{owner.label}</option>)}</select></Field><Field id="accountVertical" label="Healthcare vertical"><input id="accountVertical" name="vertical" /></Field></div>
      <ResearchFields />
    </>;
    case 'market-deal': return <MarketDealFields {...form} />;
    case 'account-owner': return <Field id="newAccountOwner" label="Accountable partner" hint="This changes portfolio accountability only. Individual market-deal owners stay untouched."><select id="newAccountOwner" name="owner" defaultValue={form.owner}><option value="joe">Joe</option><option value="dell">Dell</option></select></Field>;
    case 'conflict': return <><p>Review both values, then choose one. Both edits remain in the deal history.</p>{form.choices.map(choice => <div className="field" key={choice.side}><label><input type="radio" name="winner" value={choice.side} required /> <strong>{choice.caption}</strong> · {choice.actor}: {choice.value}</label></div>)}</>;
  }
}

export function mountDealRoomForm(target: HTMLElement, form: DealRoomForm, national?: { heldName: string | null; disabled: boolean }) {
  const root = createRoot(target);
  let candidates: Candidates | null = null;
  const render = () => flushSync(() => root.render(<>
    {national?.heldName && <p>Check creation outcome for {national.heldName} before starting another record.</p>}
    {national ? <fieldset id="nationalCreationFields" disabled={national.disabled}><FormFields form={form} /></fieldset> : <FormFields form={form} />}
    {candidates && <div id="nationalCandidates"><p>{candidates.hint || 'An organization with this name already exists. Review it before creating a separate brand.'}</p>
      <ul>{candidates.candidates.map(candidate => <li key={candidate.id}>{candidate.name} ({candidate.id})</li>)}</ul>
      <p>Cancel to use the existing client. Continue only if this is a genuinely separate brand.</p>
      <div className="field"><label><input type="checkbox" name="confirm_separate" required defaultChecked={candidates.held} disabled={candidates.held} /> I reviewed these candidates and confirm this is a separate brand.</label></div>
      <button type="button" id="nationalEditDetails" disabled={candidates.held} onClick={candidates.onEdit}>Edit account details</button></div>}
  </>));
  render();
  return { candidates: (next: Candidates | null) => { candidates = next; render(); }, dispose: () => root.unmount() };
}
