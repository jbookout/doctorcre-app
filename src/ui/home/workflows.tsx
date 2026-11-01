import { useEffect, useRef, useState } from 'react';

// Partner workflows that live beside the inbox on Home: undo an email
// filing, confirm that a calendar meeting happened, work the post-call
// follow-up backlog, and see dated reasons to reach out. The page boot supplies
// the existing CARR client methods; nothing here adds a server verb.

export type Filing = Readonly<{ event_id: string; subject: string | null; sender_name: string | null; occurred_at: string }>;
export type MeetingReview = Readonly<{ key: string; title: string; start: string; end: string }>;
export type MeetingDeal = Readonly<{ id: string; name: string; owner?: string }>;
export type CallFollowup = Readonly<{
  kind: 'assigned_action' | 'email_draft'; candidateId: string; sessionId: string; dealId: string; dealName: string;
  contactName?: string; createdAt: string; evidence: string;
  owner?: string; description?: string; dueOn?: string | null; subject?: string; recipientRef?: string;
}>;
export type HomeWorkflowClient = {
  listFilings?(): Promise<unknown>;
  undoFiling?(args: { event_id: string; idempotency_key: string }): Promise<unknown>;
  meetings(signal?: AbortSignal): Promise<{ reviews: MeetingReview[]; deals: MeetingDeal[]; actor: string | null }>;
  logMeeting(args: { ref: string; kind: 'meeting'; summary: string; occurred_at: string; idempotency_key: string }): Promise<unknown>;
  callFollowups(signal?: AbortSignal): Promise<CallFollowup[]>;
  resolveCallFollowup(args: { candidate_id: string; accept: boolean; idempotency_key: string }): Promise<unknown>;
  openCallReport?(sessionId: string): Promise<boolean>;
  mountContactReasons?(host: HTMLElement): { dispose(): void };
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const denied = (error: unknown) => record(error) && (error.status === 401 || error.status === 403);
const refusalCode = (error: unknown) => record(error) && record(error.payload) && typeof error.payload.error === 'string' ? error.payload.error : '';
const day = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
const PARTNERS: Record<string, string> = { joe: 'Joe', dell: 'Dell' };

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error' } | { state: 'denied' };
function useRead<T>(read: (signal: AbortSignal) => Promise<T>, generation: number): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: 'loading' });
    read(controller.signal).then(value => { if (!controller.signal.aborted) setLoad({ state: 'ready', value }); },
      error => { if (!controller.signal.aborted) setLoad({ state: denied(error) ? 'denied' : 'error' }); });
    return () => controller.abort();
  }, [generation]);
  return load;
}

const FILING_REFUSALS: Record<string, string> = {
  email_thread_filing_changed: 'This filing changed since it was filed, so it was left as is. Open the deal to review it.',
  email_thread_filing_not_found: 'This filing is no longer available to undo.',
};
function parseFilings(value: unknown): Filing[] {
  if (!record(value) || !Array.isArray(value.filings) || value.filings.some(row => !record(row) || !text(row.event_id))) throw Error('Invalid email filings');
  return value.filings as Filing[];
}

function EmailFilings({ client }: { client: Required<Pick<HomeWorkflowClient, 'listFilings' | 'undoFiling'>> }) {
  const [generation, setGeneration] = useState(0);
  const load = useRead(async () => parseFilings(await client.listFilings()), generation);
  const [outcomes, setOutcomes] = useState<Record<string, { status: 'submitting' | 'undone' | 'refused'; message?: string; key: string }>>({});
  const [kept, setKept] = useState<Filing[]>([]);
  const rows = load.state === 'ready' ? [...load.value, ...kept.filter(row => !load.value.some(item => item.event_id === row.event_id))] : kept;
  async function undo(row: Filing) {
    const prior = outcomes[row.event_id];
    if (prior?.status === 'submitting' || prior?.status === 'undone') return;
    const key = prior?.key || crypto.randomUUID();
    setOutcomes(current => ({ ...current, [row.event_id]: { status: 'submitting', key } }));
    try {
      const result = await client.undoFiling({ event_id: row.event_id, idempotency_key: key });
      if (!record(result) || result.ok !== true) throw Error('Unexpected undo result');
      setKept(current => current.some(item => item.event_id === row.event_id) ? current : [...current, row]);
      setOutcomes(current => ({ ...current, [row.event_id]: { status: 'undone', key } }));
    } catch (error) {
      const code = refusalCode(error);
      setOutcomes(current => ({ ...current, [row.event_id]: { status: 'refused', key: code ? crypto.randomUUID() : key,
        message: denied(error) ? 'Sign in again to undo this filing.' : FILING_REFUSALS[code] || 'Could not undo this filing. It was left as is.' } }));
    }
  }
  return <section className="home-panel home-workflow" aria-labelledby="homeFilingsTitle" aria-busy={load.state === 'loading'}>
    <header className="home-panel-head"><h2 id="homeFilingsTitle">Filed automatically</h2></header>
    {load.state === 'denied' ? <p role="status">Sign in to review filed emails.</p>
      : load.state === 'error' ? <><p role="status">Could not load filed emails.</p><button type="button" className="btn home-outline" onClick={() => setGeneration(value => value + 1)}>Retry filed emails</button></>
        : load.state === 'loading' && !rows.length ? <p className="home-empty">Loading filed emails…</p>
          : !rows.length ? <p className="home-empty">No filed emails to review.</p> : null}
    {rows.map(row => {
      const outcome = outcomes[row.event_id];
      const subject = row.subject || 'Subject unavailable';
      return <article className="email-proposal" key={row.event_id} data-filing-id={row.event_id}>
        <h3>{subject}</h3><p>From {row.sender_name || 'Sender unavailable'}{day(row.occurred_at) ? ` · ${day(row.occurred_at)}` : ''}</p>
        {outcome?.status === 'undone' ? <p role="status">Undone. The email is no longer filed to this deal and will not be filed automatically again.</p>
          : <>{outcome?.message && <p role="status">{outcome.message}</p>}<button type="button" className="btn home-outline" aria-label={`Undo filing ${subject}`} disabled={outcome?.status === 'submitting'} onClick={() => void undo(row)}>Undo</button></>}
      </article>;
    })}
  </section>;
}

const REMEMBER_MS = 2 * 86_400_000;
const meetingStorageKey = (actor: string) => `doctorcre.meeting-reviews.v1.${actor}`;
function readHandled(actor: string): Record<string, { state: string; at: number }> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(meetingStorageKey(actor)) || '{}');
    if (!record(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, entry]) => record(entry) && typeof entry.at === 'number' && Date.now() - entry.at < REMEMBER_MS)) as Record<string, { state: string; at: number }>;
  } catch { return {}; }
}
const meetingWhen = (review: MeetingReview) => {
  const options: Intl.DateTimeFormatOptions = { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' };
  const date = new Date(review.start).toLocaleDateString(undefined, { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
  return `${date}, ${new Date(review.start).toLocaleTimeString(undefined, options)} to ${new Date(review.end).toLocaleTimeString(undefined, { ...options, timeZoneName: 'short' })}`;
};

function MeetingReviews({ client }: { client: HomeWorkflowClient }) {
  const load = useRead(signal => client.meetings(signal), 0);
  const [handled, setHandled] = useState<Record<string, { state: string; at: number }>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<Record<string, { state: 'submitting' | 'uncertain' | 'failed'; dealId: string; key: string; error?: string }>>({});
  const [notice, setNotice] = useState('');
  const actor = load.state === 'ready' ? load.value.actor : null;
  useEffect(() => { if (actor) setHandled(readHandled(actor)); }, [actor]);
  if (load.state !== 'ready' || !actor) return load.state === 'error' ? <section className="home-panel home-workflow" aria-labelledby="homeMeetingReviewsTitle"><header className="home-panel-head"><h2 id="homeMeetingReviewsTitle">Did these meetings happen?</h2></header><p role="status">Meeting follow-ups unavailable. Refresh Home to try again.</p></section> : null;
  const deals = [...load.value.deals.filter(deal => deal.owner === actor), ...load.value.deals.filter(deal => deal.owner !== actor)];
  const reviews = load.value.reviews.filter(review => !handled[review.key] || decisions[review.key]?.state === 'uncertain');
  if (!reviews.length && !notice) return null;
  const remember = (key: string, state: string) => setHandled(current => {
    const next = { ...current, [key]: { state, at: Date.now() } };
    try { localStorage.setItem(meetingStorageKey(actor), JSON.stringify(next)); } catch { /* This browser cannot remember it; the meeting reappears on reload. */ }
    return next;
  });
  async function log(review: MeetingReview) {
    const prior = decisions[review.key];
    const dealId = prior?.dealId || choices[review.key];
    const deal = deals.find(row => row.id === dealId);
    if (!deal || prior?.state === 'submitting') return;
    const key = prior?.state === 'uncertain' ? prior.key : crypto.randomUUID();
    setDecisions(current => ({ ...current, [review.key]: { state: 'submitting', dealId: deal.id, key } })); setNotice('');
    try {
      const receipt = await client.logMeeting({ ref: deal.id, kind: 'meeting', summary: `Meeting: ${review.title}`, occurred_at: new Date(review.start).toISOString(), idempotency_key: key });
      if (!record(receipt) || receipt.ok !== true || !text(receipt.activity_id)) throw Object.assign(Error('Meeting log could not be verified'), { uncertain: true });
      setDecisions(current => { const next = { ...current }; delete next[review.key]; return next; });
      remember(review.key, 'logged'); setNotice(`Meeting logged on ${deal.name}.`);
    } catch (error) {
      const refused = Boolean(refusalCode(error));
      setDecisions(current => ({ ...current, [review.key]: refused
        ? { state: 'failed', dealId: deal.id, key, error: 'The meeting was not logged. Try again or choose another deal.' }
        : { state: 'uncertain', dealId: deal.id, key, error: 'Not confirmed yet. Check the meeting log before choosing again.' } }));
    }
  }
  return <section className="home-panel home-workflow" aria-labelledby="homeMeetingReviewsTitle">
    <header className="home-panel-head"><h2 id="homeMeetingReviewsTitle">Did these meetings happen?</h2><span className="home-period">Last 24 hours</span></header>
    <p className="home-empty">From your Outlook calendar. Pick the deal and log the meeting, or dismiss it.</p>
    {notice && <p className="home-call-task-notice" role="status">{notice}</p>}
    {reviews.map(review => {
      const decision = decisions[review.key];
      const busy = decision?.state === 'submitting', uncertain = decision?.state === 'uncertain';
      const chosen = decision?.dealId || choices[review.key] || '';
      return <article className="work-card home-call-task home-meeting-review" key={review.key} data-review={review.key}>
        <h3>{review.title}</h3><p><time dateTime={review.start}>{meetingWhen(review)}</time>{uncertain ? ' · Unconfirmed' : ''}</p>
        {decision?.error && <p className="home-call-task-error" role="alert">{decision.error}</p>}
        <div className="home-call-task-controls">
          {deals.length ? <label>Deal <select aria-label={`Deal for ${review.title}`} value={chosen} disabled={busy || uncertain} onChange={event => {
            const value = event.target.value;
            setChoices(current => ({ ...current, [review.key]: value }));
            if (decision?.state === 'failed') setDecisions(current => { const next = { ...current }; delete next[review.key]; return next; });
          }}><option value="">Choose a deal</option>{deals.map(deal => <option key={deal.id} value={deal.id}>{deal.name}</option>)}</select></label>
            : <span>No open deals to log this meeting on.</span>}
          <button type="button" className="home-outline" disabled={busy || !chosen} onClick={() => void log(review)}>{uncertain ? 'Check meeting log' : busy ? 'Logging…' : 'It happened'}</button>
          <button type="button" className="home-outline" disabled={busy || uncertain} onClick={() => { remember(review.key, 'dismissed'); setNotice(''); }}>Dismiss</button>
        </div>
      </article>;
    })}
  </section>;
}

function CallFollowups({ client }: { client: HomeWorkflowClient }) {
  const [generation, setGeneration] = useState(0);
  const load = useRead(signal => client.callFollowups(signal), generation);
  const [decisions, setDecisions] = useState<Record<string, { state: 'submitting' | 'resolved' | 'uncertain'; accept: boolean; key: string; task: CallFollowup }>>({});
  const [notice, setNotice] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const listed = load.state === 'ready' ? load.value : [];
  const tasks = [...listed, ...Object.values(decisions).filter(decision => decision.state !== 'resolved' && !listed.some(row => row.candidateId === decision.task.candidateId)).map(decision => decision.task)]
    .filter(task => decisions[task.candidateId]?.state !== 'resolved');
  async function resolve(task: CallFollowup, accept: boolean) {
    const prior = decisions[task.candidateId];
    if (prior?.state === 'submitting' || prior?.state === 'resolved' || prior?.state === 'uncertain' && prior.accept !== accept) return;
    const key = prior?.key || crypto.randomUUID();
    setDecisions(current => ({ ...current, [task.candidateId]: { state: 'submitting', accept, key, task } })); setNotice('');
    try {
      const receipt = await client.resolveCallFollowup({ candidate_id: task.candidateId, accept, idempotency_key: key });
      const already = record(receipt) && (receipt.already === 'confirmed' || receipt.already === 'skipped');
      if (!record(receipt) || receipt.ok !== true || receipt.candidate_id !== task.candidateId || receipt.already !== undefined && !already
        || !(already || receipt.status === (accept ? 'confirmed' : 'skipped')) || accept && !already && (!text(receipt.ref) || receipt.assignee !== task.owner))
        throw Error('Task outcome could not be verified');
      setDecisions(current => ({ ...current, [task.candidateId]: { state: 'resolved', accept, key, task } }));
      setNotice(already ? 'This proposal was already resolved. Refreshing Home.' : accept ? 'Task added' : 'Task skipped');
      setGeneration(value => value + 1);
    } catch {
      setDecisions(current => ({ ...current, [task.candidateId]: { state: 'uncertain', accept, key, task } }));
    }
  }
  async function openDraft(task: CallFollowup) {
    if (opening || !client.openCallReport) return;
    setOpening(task.candidateId); setNotice('');
    try { if (!await client.openCallReport(task.sessionId)) setNotice('Open Call Mode on the Mac that recorded this call to review this draft.'); }
    catch { setNotice('The call report could not open. Try again on the Mac that recorded this call.'); }
    finally { setOpening(null); }
  }
  const source = (task: CallFollowup) => <p className="home-call-source">From your call with {task.dealName}, <time dateTime={task.createdAt}>{day(task.createdAt)}</time></p>;
  const title = (task: CallFollowup) => <h3><a href={`/deals?deal=${encodeURIComponent(task.dealId)}`}>{task.contactName ? `${task.contactName} · ${task.dealName}` : task.dealName}</a></h3>;
  return <section className="home-panel home-workflow" aria-labelledby="homeCallFollowupsTitle" aria-busy={load.state === 'loading'}>
    <header className="home-panel-head"><h2 id="homeCallFollowupsTitle">Call follow-ups to review</h2></header>
    {notice && <p className="home-call-task-notice" role="status">{notice}</p>}
    {load.state === 'denied' ? <p role="status">Sign in to review call follow-ups.</p>
      : load.state === 'error' ? <p className="home-empty" role="status">Call follow-ups unavailable. Refresh Home to try again.</p>
        : load.state === 'loading' && !tasks.length ? <p className="home-empty" role="status">Loading call follow-ups…</p>
          : !tasks.length ? <p className="home-empty">No call follow-ups</p> : null}
    {tasks.map(task => {
      if (task.kind === 'email_draft') return <article className="work-card home-call-task" key={task.candidateId} data-call-draft={task.candidateId}>
        {title(task)}{source(task)}<p>{task.subject}</p><span>To {task.recipientRef}</span><p>Draft only. Review and send in Outlook.</p>
        {task.evidence && <details><summary>What was said</summary><p>{task.evidence}</p></details>}
        <div className="home-call-task-controls"><button type="button" className="home-outline" disabled={opening !== null || !client.openCallReport} onClick={() => void openDraft(task)}>Review draft</button></div>
      </article>;
      const decision = decisions[task.candidateId];
      const busy = decision?.state === 'submitting', uncertain = decision?.state === 'uncertain';
      const due = task.dueOn ? new Date(`${task.dueOn}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
      return <article className="work-card home-call-task" key={task.candidateId} data-call-task={task.candidateId}>
        {title(task)}{source(task)}<p>{task.description}</p>
        {task.evidence && <details><summary>What was said</summary><p>{task.evidence}</p></details>}
        {uncertain && <p className="home-call-task-error" role="alert">Task outcome is unconfirmed. Check the original decision before changing it.</p>}
        <div className="home-call-task-controls"><span>{due ? <>Due <time dateTime={task.dueOn || ''}>{due}</time></> : 'No due date'}</span>
          <button type="button" className="home-outline" disabled={busy || uncertain && !decision.accept} onClick={() => void resolve(task, true)}>{uncertain && decision.accept ? 'Check task outcome' : `Add ${PARTNERS[task.owner || ''] || 'partner'} task`}</button>
          <button type="button" className="home-outline" disabled={busy || uncertain && decision.accept} onClick={() => void resolve(task, false)}>{uncertain && !decision.accept ? 'Check task outcome' : 'Skip'}</button></div>
      </article>;
    })}
  </section>;
}

function ContactReasons({ client }: { client: HomeWorkflowClient }) {
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!host.current || !client.mountContactReasons) return;
    const view = client.mountContactReasons(host.current);
    return () => view.dispose();
  }, [client]);
  return client.mountContactReasons ? <section ref={host} id="homeContactReasons" className="home-panel contact-reasons" aria-label="Reasons to reach out" /> : null;
}

export function HomeWorkflows({ load }: { load: () => Promise<HomeWorkflowClient> }) {
  const [client, setClient] = useState<HomeWorkflowClient | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; load().then(value => { if (live) setClient(value); }, () => { if (live) setFailed(true); }); return () => { live = false; }; }, [load]);
  if (failed) return <p className="home-empty" role="status">Filed emails, meeting follow-ups and call follow-ups are unavailable. Refresh Home to try again.</p>;
  if (!client) return null;
  return <div className="home-workflows">
    <CallFollowups client={client} />
    <MeetingReviews client={client} />
    {client.listFilings && client.undoFiling && <EmailFilings client={{ listFilings: client.listFilings, undoFiling: client.undoFiling }} />}
    <ContactReasons client={client} />
  </div>;
}
