import { useId, useRef, useState } from 'react';
import { object, waitingLabel, type InboxClient, type InboxItem, type WaitingChoice, type WaitingCommand } from './inbox';

type State = { kind: 'editing' } | { kind: 'sending'; request: WaitingCommand } | { kind: 'uncertain'; request: WaitingCommand } | { kind: 'conflict' };
export function WaitingEditor({ item, client, disabled, update, activity }: { item: InboxItem; client: InboxClient; disabled: boolean; update: (item: InboxItem) => void; activity: (busy: boolean) => void }) {
  const personId = useId();
  const [state, setState] = useState<State | null>(null);
  const [choices, setChoices] = useState<WaitingChoice[]>([]);
  const [person, setPerson] = useState('');
  const [reason, setReason] = useState(item.waiting_on?.reason || '');
  const [evidence, setEvidence] = useState(item.waiting_on?.evidence.join('\n') || '');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const locked = useRef(false);
  const base = useRef(item);
  const opener = useRef<HTMLButtonElement>(null);
  const label = waitingLabel(item);
  if (!label || !client.wait || !client.choices) return null;
  const busy = disabled || loading || state?.kind === 'sending';
  async function load() {
    if (locked.current || !client.choices) return;
    locked.current = true; setLoading(true);
    try { setChoices(await client.choices()); setNotice('Select a recorded contact. People without a verified contact identity are unavailable here.'); }
    catch { setNotice('People unavailable. Load people again to retry.'); }
    finally { locked.current = false; setLoading(false); }
  }
  async function send(request: WaitingCommand) {
    if (locked.current || !client.wait) return;
    locked.current = true; activity(true); setState({ kind: 'sending', request }); setNotice('Waiting for confirmation…');
    try { update(await client.wait(request)); setState(null); setNotice('Waiting change confirmed.'); opener.current?.focus(); }
    catch (error) {
      const code = object(error) && object(error.payload) ? error.payload.error : null;
      if (code === 'version_conflict' || code === 'inbox_item_completed') {
        setState({ kind: 'conflict' }); setNotice('This card changed. Your edit is kept. Refresh this card before saving again.');
      } else { setState({ kind: 'uncertain', request }); setNotice('Change unconfirmed. Your edit is kept. Retry the same request to check it safely.'); }
    } finally { locked.current = false; activity(false); }
  }
  function submit(action: 'set' | 'clear') {
    const target = choices.find(choice => choice.id === person);
    const refs = evidence.split('\n').map(value => value.trim()).filter(Boolean);
    if (item.waiting_version === undefined || !reason.trim() || !refs.length || refs.length > 20 || (action === 'set' && !target)) { setNotice('Choose a person, add a reason and 1 to 20 evidence references.'); return; }
    const args = { idempotency_key: crypto.randomUUID(), item_id: item.item_id, item_version: base.current.base_version, base_version: base.current.waiting_version ?? 0, reason: reason.trim(), evidence: refs };
    if (action === 'set' && target) void send({ action: 'set', args: { ...args, target: { kind: target.kind, id: target.id } } });
    else if (action === 'clear') void send({ action: 'clear', args });
  }
  return <div onTouchStart={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}>
    <p>{label}</p>{item.waiting_on && <p>{item.waiting_on.reason}</p>}
    {!state ? <button ref={opener} type="button" disabled={disabled} onClick={() => { base.current = item; setState({ kind: 'editing' }); setNotice(''); }}>{item.waiting_on ? 'Correct waiting person' : 'Set waiting person'}</button> : <form aria-label={`Waiting person for ${item.title}`} onSubmit={event => { event.preventDefault(); if (state.kind === 'editing') submit('set'); }}>
      <fieldset disabled={busy || state.kind !== 'editing'} style={{ minWidth: 0 }}><legend>Who owes the next move?</legend>
        <button type="button" onClick={() => void load()}>Load people</button>
        <label htmlFor={personId} style={{ display: 'block' }}>Person</label><select id={personId} value={person} onChange={event => setPerson(event.target.value)} style={{ maxWidth: '100%' }}><option value="">Choose a recorded person</option>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}</select>
        <label htmlFor={`${personId}-reason`} style={{ display: 'block' }}>Reason</label><textarea id={`${personId}-reason`} required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} style={{ width: '100%', boxSizing: 'border-box' }} />
        <label htmlFor={`${personId}-evidence`} style={{ display: 'block' }}>Evidence references, one per line</label><textarea id={`${personId}-evidence`} required maxLength={40000} value={evidence} onChange={event => setEvidence(event.target.value)} style={{ width: '100%', boxSizing: 'border-box' }} />
        <button type="submit">Save waiting person</button>{item.waiting_on && <button type="button" onClick={() => submit('clear')}>Clear waiting person</button>}
      </fieldset>
      {state.kind === 'uncertain' && <button type="button" disabled={busy} onClick={() => void send(state.request)}>Retry same waiting request</button>}
      {state.kind === 'conflict' && <button type="button" disabled={busy} onClick={async () => { if (locked.current) return; locked.current = true; setLoading(true); try { const snapshot = await client.read(); const current = snapshot.items.find(row => row.item_id === item.item_id); if (!current) throw Error(); base.current = current; update(current); setState({ kind: 'editing' }); setNotice('Latest card loaded. Review your kept edit before saving.'); } catch { setNotice('Refresh unavailable. Your edit is kept. Try again.'); } finally { locked.current = false; setLoading(false); } }}>Refresh this card</button>}
      <button type="button" disabled={busy || state.kind === 'uncertain'} onClick={() => { setState(null); setChoices([]); opener.current?.focus(); }}>Close editor</button>
    </form>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
