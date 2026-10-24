import { sessionFetch } from './private-session.js';
import { createRetainedCommands } from './retained-commands.mjs';
import { readWithDeadline } from './current-read.mjs';

/** Shared room composer/queue transport. An uncertain post is reconciled by
 * replaying its original session-bound request, never by minting another key. */
export function createRoomTurnClient({ fetchImpl = sessionFetch, session,
  newKey, timeoutMs = 15_000 } = {}) {
  let csrf = null;
  const commands = createRetainedCommands({ newKey, scope: async () => {
    csrf = session ? await session() : await readWithDeadline(async signal => {
      const response = await fetchImpl('/api/room/turns?limit=1', { signal, cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw Object.assign(new Error('Room sign-in is required.'), { status: response.status });
      return (await response.json()).csrf_token;
    }, { timeoutMs });
    if (!csrf) throw new Error('Room sign-in is required.');
    return csrf;
  } });
  return {
    pending: key => commands.pending(key),
    send(key, payload) {
      return commands.send(key, payload, request => {
        const binding = csrf;
        return readWithDeadline(async signal => {
          const response = await fetchImpl('/api/room/turn', { method: 'POST', signal,
            credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json', 'x-carr-csrf': binding },
            body: JSON.stringify(request) });
          const data = await response.json().catch(() => null);
          if (!response.ok) throw Object.assign(new Error(data?.error || 'Room post unavailable'), {
            status: response.status, payload: data,
          });
          if (data?.ok !== true) throw new Error('Room post outcome unknown. Check outcome before changing this request.');
          return data;
        }, { timeoutMs });
      });
    },
  };
}
