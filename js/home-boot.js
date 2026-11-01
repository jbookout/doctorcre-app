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
// The partner workflows beside the inbox share one CARR client, built the way
// the classic Home built it. They load after the inbox snapshot settles, so the
// inbox paints first.
async function createHomeClient() {
  if (boot.mode === 'live') {
    const [{ createLiveClient }, { createLeadBoardClient }, { createLeaseRadarClient }] = await Promise.all([
      import('./live-client.js'), import('./leads-client.js'), import('./lease-radar-client.js')]);
    const client = createLiveClient({ docContext: false });
    client.getLeadBoard = createLeadBoardClient({ docContext: false }).getLeadBoard;
    client.readLeaseRadar = createLeaseRadarClient().readLeaseRadar;
    return client;
  }
  const [{ createFixtureClient }, { leaseRadarFixture }] = await Promise.all([
    import('./fixture-client.js'), import('./lease-radar-fixture.js')]);
  const client = await createFixtureClient({ ...boot.options, docContext: false });
  client.getLeadBoard = async () => ({ leads: [] });
  client.readLeaseRadar = async () => leaseRadarFixture();
  return client;
}
let client, workflows;
// One client per page, made on first use.
export const homeClient = () => client ||= createHomeClient();
function loadWorkflows() {
  workflows ||= Promise.all([homeClient(), import('./home-call-tasks.js'), import('./home-meeting-reviews.js'), import('./deal-review-model.js'), import('./command-feedback.mjs')])
    .then(([client, { readHomeCallFollowups }, { meetingReviews }, { scopedDeals }, { classifyCommandOutcome }]) => {
      return {
        ...(client.listEmailThreadFilings && client.undoEmailThreadFiling ? {
          listFilings: () => client.listEmailThreadFilings(),
          undoFiling: args => client.undoEmailThreadFiling(args),
        } : {}),
        async meetings(signal) {
          const [brief, board] = await Promise.all([client.morningBrief({ signal }), client.getBoard({ signal })]);
          const deals = (scopedDeals(board, 'team') || []).filter(deal => typeof deal?.id === 'string' && deal.id && typeof deal.name === 'string' && deal.name.trim())
            .map(deal => ({ id: deal.id, name: deal.name, ...(typeof deal.owner === 'string' ? { owner: deal.owner } : {}) }));
          return { reviews: meetingReviews(brief?.sections?.calendar), deals, actor: typeof board?.actor === 'string' && board.actor ? board.actor : null };
        },
        // A fault after the write may have committed it, so only a definite
        // refusal or conflict lets the panel mint a new idempotency key.
        logMeeting: args => client.logActivity(args).catch(error => {
          throw Object.assign(error instanceof Error ? error : Error('Meeting log failed'), { outcome: classifyCommandOutcome({ error }).status });
        }),
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
        mountClassicHome: container => {
          let view = null, disposed = false;
          import('./workspace-command-center.js').then(({ mountClassicHome }) => { if (!disposed) view = mountClassicHome({ document, window, client, host: container }); });
          return { dispose() { disposed = true; view?.dispose(); } };
        },
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
