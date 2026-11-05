import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';
import { createAskOutbox, type AskRequest, type QueuedAsk } from './queued-asks';

type Client = { askSession(): Promise<{ actor: string }>; submitDocRequest(request: AskRequest, actor: string): Promise<unknown> };
const labels: Record<QueuedAsk['kind'], string> = {
  queued:'Saved on this device. Waiting for a connection.', submitting:'Sending your ask…',
  unknown:'Receipt not confirmed. Your ask is kept here.', refused:'Your ask was declined. It is kept here.',
  accepted:'Received by Dr. CRE. An answer is still pending.',
};
export async function mountAskComposer(host: HTMLElement, client: Client, conversation: string) {
  let closed = false, started = false, starting = false, sessionVerified = false;
  const root = createRoot(host);
  let stop = () => {};
  const dispose = () => { closed = true; window.removeEventListener('online', restart); stop(); root.unmount(); };
  const unavailable = () => flushSync(() => root.render(<p role="status">Reconnect and sign in to open your saved asks.</p>));
  async function start() {
    if (started || starting || closed) return;
    starting = true;
    flushSync(() => root.render(<p role="status">Verifying your session to open saved asks…</p>));
    try {
      sessionVerified = false;
      const { actor } = await client.askSession();
      if (closed) return;
      sessionVerified = true;
      let redraw = () => {};
      const box = createAskOutbox({ storage:window.localStorage, actor, conversation,
        online:() => navigator.onLine, uuid:() => crypto.randomUUID(),
        submit:request => client.submitDocRequest(request, actor), changed:() => redraw() });
      stop = box.stop;
      function Composer() {
        const [text, setText] = useState(() => box.draft());
        const [notice, setNotice] = useState('');
        const [, update] = useState(0);
        redraw = () => update(n => n+1);
        let rows: QueuedAsk[] = [], held: string[] = [], storageUnavailable = false;
        try { rows = box.entries(); held = box.recovery(); } catch { storageUnavailable = true; }
        const run = (action: () => void | Promise<void>) => {
          try { Promise.resolve(action()).catch(() => setNotice('Device storage is unavailable. Your ask has not been confirmed.')); }
          catch (error) { setNotice(error instanceof Error ? error.message : 'Your ask could not be saved.'); }
        };
        return <form onSubmit={event => { event.preventDefault(); run(() => {
          box.enqueue(text); setText(box.draft()); setNotice(''); return box.flush();
        }); }}>
          <div className="field"><label htmlFor="askText">Ask Dr. CRE</label>
          <textarea id="askText" rows={3} maxLength={20000} value={text}
            aria-describedby="askHelp askNotice" onChange={event => {
              const next = event.target.value; setText(next);
              try { box.saveDraft(next); setNotice(''); }
              catch { setNotice('This text is only on this page. Device storage is unavailable.'); }
            }} /></div>
          <p id="askHelp" className="caption">Saved asks send when you reconnect. You can keep working while an answer is pending.</p>
          <button type="submit" className="btn" disabled={!text.trim()}>Send ask</button>
          <p id="askNotice" role="status">{notice}</p>
          {storageUnavailable && <p role="status">Device storage is unavailable. Saved asks cannot be read or confirmed.</p>}
          {held.length > 0 && <p role="status">Some saved asks or the saved draft need recovery. Their original bytes are kept on this device and will not be sent. Valid saved asks can still send.</p>}
          <ul className="work-list" aria-label="Your asks" aria-live="polite">{rows.map(row => <li key={row.request.idempotency_key}>
            <p style={{ whiteSpace:'pre-wrap', overflowWrap:'anywhere' }}>{row.request.body}</p>
            <p>{labels[row.kind]}</p>
            {(row.kind === 'unknown' || row.kind === 'refused') && <button type="button" className="btn"
              // eslint-disable-next-line no-restricted-syntax -- Single explicit click retries one frozen request.
              onClick={() => run(() => box.retry(row.request.idempotency_key))}>{row.kind === 'unknown' ? 'Check receipt' : 'Try again'}</button>}
          </li>)}</ul>
        </form>;
      }
      flushSync(() => root.render(<Composer />));
      started = true;
      window.removeEventListener('online', restart);
      const reconnect = () => { box.flush().catch(() => redraw()); };
      const storage = () => redraw();
      // eslint-disable-next-line no-restricted-syntax -- Reconnect attempts each saved ask once, with no timer or recursive retry.
      window.addEventListener('online', reconnect);
      window.addEventListener('storage', storage);
      stop = () => { box.stop(); window.removeEventListener('online', reconnect); window.removeEventListener('storage', storage); };
      // eslint-disable-next-line no-restricted-syntax -- Single initial mount attempts one finite snapshot of saved asks.
      reconnect();
    } catch { if (!closed) {
      if (sessionVerified) flushSync(() => root.render(<p role="status">Device storage is unavailable. Saved asks cannot be read or confirmed.</p>));
      else unavailable();
    } }
    finally { starting = false; }
  }
  const restart = () => { if (!closed) void start(); };
  // eslint-disable-next-line no-restricted-syntax -- Reconnect verifies the session until startup succeeds or the composer closes.
  window.addEventListener('online', restart);
  window.addEventListener('doctorcre-session-invalidated', dispose, { once:true });
  await start();
  return () => { window.removeEventListener('online', restart); window.removeEventListener('doctorcre-session-invalidated', dispose); if (!closed) dispose(); };
}
