import { resolveDealroomBoot } from './boot-mode.js';
import { createMcpRequests } from './mcp-requests.mjs';
import { privateSession } from './private-session.js';
import { mountHome, createInboxClient, fixtureInboxRpc } from './ui.generated.js';

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
  } else rpc = fixtureInboxRpc();
  mountHome(host, createInboxClient(rpc));
}
start().catch(() => {
  host.replaceChildren();
  const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.textContent = 'Inbox unavailable. Sign in or refresh to try again.';
  const link = document.createElement('a'); link.href = '/auth/login'; link.textContent = 'Sign in';
  host.append(notice, link);
});
