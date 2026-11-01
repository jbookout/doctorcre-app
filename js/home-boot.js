import { resolveDealroomBoot } from './boot-mode.js';
import { createMcpRequests } from './mcp-requests.mjs';
import { privateSession } from './private-session.js';
const ui = import('./ui.generated.js');

const host = document.getElementById('homeRoot');
const boot = resolveDealroomBoot(location);
async function start() {
  let rpc;
  if (boot.mode === 'live') {
    await privateSession().verify();
    const request = createMcpRequests();
    rpc = async (name, args, signal) => {
      const result = await request(name, args, { signal, timeoutMs: 10000 });
      if (result.kind !== 'payload') throw Error('Server confirmation unavailable.');
      if (result.isError) throw Error('Inbox unavailable. The server refused this request.');
      return result.payload;
    };
  }
  const { mountHome, createInboxClient, fixtureInboxRpc } = await ui;
  if (boot.mode !== 'live') rpc = fixtureInboxRpc();
  mountHome(host, createInboxClient(rpc), loadWorkflows);
  host.setAttribute('data-home-mounted', '');
  document.dispatchEvent(new Event('doctorcre:home-mounted'));

}
// The partner workflows beside the inbox reuse the existing CARR client and
// readers. They load after the inbox snapshot settles, so the inbox paints first.
let workflows;
function loadWorkflows() {
  const dataClient = boot.mode === 'live'
    ? import('./live-client.js').then(({ createLiveClient }) => createLiveClient({ docContext: false }))
    : import('./fixture-client.js').then(({ createFixtureClient }) => createFixtureClient({ ...boot.options, docContext: false }));
  workflows ||= Promise.all([dataClient, import('./home-call-tasks.js'), import('./home-meeting-reviews.js')])
    .then(([client, { readHomeCallFollowups }, { meetingReviews }]) => {
      return {
        ...(client.listEmailThreadFilings && client.undoEmailThreadFiling ? {
          listFilings: () => client.listEmailThreadFilings(),
          undoFiling: args => client.undoEmailThreadFiling(args),
        } : {}),
        async meetings(signal) {
          const [brief, board] = await Promise.all([client.morningBrief({ signal }), client.getBoard({ signal })]);
          const deals = (Array.isArray(board?.deals) ? board.deals : []).filter(deal => typeof deal?.id === 'string' && deal.id && typeof deal.name === 'string' && deal.name.trim())
            .map(deal => ({ id: deal.id, name: deal.name, ...(typeof deal.owner === 'string' ? { owner: deal.owner } : {}) }));
          return { reviews: meetingReviews(brief?.sections?.calendar), deals, actor: typeof board?.actor === 'string' && board.actor ? board.actor : null };
        },
        logMeeting: args => client.logActivity(args),
        callFollowups: signal => readHomeCallFollowups(client, { signal }),
        resolveCallFollowup: args => client.resolvePostCallCandidate(args),
        async openCallReport(session) {
          const { mountGlobalCallMode } = await import('./global-call-mode.js');
          return (await mountGlobalCallMode(document)).open({ session });
        },
        ...(client.listPracticeOrigination ? { mountContactReasons: container => {
          let view = null, disposed = false;
          import('./contact-reasons.mjs').then(({ mountContactReasons }) => { if (!disposed) view = mountContactReasons({ host: container, window, client, home: true }); });
          return { dispose() { disposed = true; view?.dispose(); } };
        } } : {}),
      };
    });
  return workflows;
}
start().catch(() => {
  host.replaceChildren();
  const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.textContent = 'Inbox unavailable. Sign in or refresh to try again.';
  const link = document.createElement('a'); link.href = '/auth/login'; link.textContent = 'Sign in';
  host.append(notice, link);
});
