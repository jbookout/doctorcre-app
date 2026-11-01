import { mountInbox } from './home';
import { createInboxClient } from './inbox';
import { fixtureInboxRpc } from './fixture';

// The opt-in inbox page boots here. Home stays the classic dashboard; this
// page holds only the inbox, so no workflow lives in two places. The page's
// session and transport helpers are the app's own modules beside this bundle.
type Rpc = (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
type McpResult = { kind: string; isError?: boolean; payload?: unknown };
const sibling = (path: string) => import(/* runtime module beside ui.generated.js */ new URL(path, import.meta.url).href);

export async function bootInbox(host: HTMLElement) {
  try {
    const { resolveDealroomBoot } = await sibling('./boot-mode.js');
    let rpc: Rpc = fixtureInboxRpc();
    if (resolveDealroomBoot(location).mode === 'live') {
      const [{ privateSession }, { createMcpRequests }] = await Promise.all([sibling('./private-session.js'), sibling('./mcp-requests.mjs')]);
      await privateSession().verify();
      const request = createMcpRequests();
      rpc = async (name, args, signal) => {
        const result: McpResult = await request(name, args, { signal, timeoutMs: 10000 });
        if (result.kind !== 'payload') throw Error('Server confirmation unavailable.');
        if (result.isError) throw Error('Inbox unavailable. The server refused this request.');
        return result.payload;
      };
    }
    mountInbox(host, createInboxClient(rpc));
  } catch {
    host.replaceChildren();
    const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.textContent = 'Inbox unavailable. Sign in or refresh to try again.';
    const link = document.createElement('a'); link.href = '/auth/login'; link.textContent = 'Sign in';
    host.append(notice, link);
  }
}
