import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { useLayoutEffect } from 'react';

type Action = 'start' | 'reviewed' | 'skipped' | 'completed' | 'abandoned';
type Targets = { button: HTMLButtonElement; panel: HTMLElement; dock: HTMLElement };
export type AgendaProps = {
  buttonHidden: boolean;
  disabled: boolean;
  review: null | {
    title: string; index: number; total: number;
    deal: { id: string; name: string; context: string; reason: string; phase: string;
      nextStep: string; nextDate: string; marketAgent: string | null };
  };
  confirms: { id: string; label: string }[];
  confirmError: null | 'denied' | 'unavailable';
};

function DealRoomAgenda({ targets, action, ...props }: AgendaProps & { targets: Targets; action: (action: Action) => void }) {
  const { review, confirms, confirmError, disabled } = props;
  useLayoutEffect(() => {
    targets.button.hidden = props.buttonHidden;
    targets.button.disabled = disabled;
    targets.panel.hidden = !review;
    targets.dock.hidden = !confirms.length && !confirmError;
    const start = () => action('start');
    targets.button.addEventListener('click', start);
    return () => targets.button.removeEventListener('click', start);
  }, [targets, action, props.buttonHidden, disabled, review, confirms, confirmError]);
  const deal = review?.deal;
  return <>
    {createPortal('Review deals', targets.button)}
    {createPortal(<>
      <header><div><h2 id="agendaTitle">{review?.title || 'Deals'}</h2><p className="dialog-context">Review agenda</p></div>
        <button type="button" className="icon-button" id="agendaClose" aria-label="Close agenda" disabled={disabled} onClick={() => action('abandoned')}>×</button>
      </header>
      <div className="agenda-progress"><span id="agendaProgress">{review ? `${Math.min(review.index + 1, review.total)} of ${review.total}` : '0 of 0'}</span>
        <progress id="agendaMeter" value={review?.index || 0} max={review?.total || 1} /></div>
      <div id="agendaCard">{deal && <article className="agenda-deal"><h3>{deal.name}</h3><p className="agenda-context">{deal.context}</p>
        <span className="agenda-reason">{deal.reason}</span>
        <div className="agenda-fact"><label>Phase</label><p>{deal.phase}</p></div>
        <div className="agenda-fact"><label>Next step</label><p>{deal.nextStep}</p></div>
        <div className="agenda-fact"><label>Next date</label><p>{deal.nextDate}</p></div>
        {deal.marketAgent !== null && <div className="agenda-fact"><label>Assigned market agent</label><p>{deal.marketAgent}</p></div>}
        <button type="button" className="secondary" data-open-deal={deal.id}>Open full record</button>{' '}
        <button type="button" className="secondary" data-agenda-step={deal.id}>Set next step</button>
      </article>}</div>
      <footer><button type="button" className="secondary" id="agendaSkip" disabled={disabled} onClick={() => action('skipped')}>Skip</button>
        <button type="button" className="primary" id="agendaReviewed" disabled={disabled} onClick={() => action('reviewed')}>Reviewed — next</button>
        <button type="button" className="text-button" id="agendaEnd" disabled={disabled} onClick={() => action('completed')}>Finish agenda</button></footer>
    </>, targets.panel)}
    {createPortal(<>
      {confirmError && <span role="status">Suggestions unavailable. {confirmError === 'denied'
        ? <a href="/auth/login">Sign in</a> : <button type="button" data-confirms-retry>Retry suggestions</button>}</span>}
      {confirms.map(proposal => <span key={proposal.id} className="confirm-chip" data-proposal={proposal.id}>{proposal.label}{' '}
        <button type="button" className="yes" data-confirm="yes" disabled={disabled}>Confirm</button><button type="button" className="skip-confirm" data-confirm="no" disabled={disabled}>Skip</button></span>)}
    </>, targets.dock)}
  </>;
}

export function mountDealRoomAgenda(targets: Targets, action: (action: Action) => void) {
  for (const node of Object.values(targets)) node.replaceChildren();
  const root = createRoot(targets.panel.ownerDocument.createElement('div'));
  return {
    render: (props: AgendaProps) => flushSync(() => root.render(<DealRoomAgenda {...props} targets={targets} action={action} />)),
    dispose: () => root.unmount(),
  };
}
