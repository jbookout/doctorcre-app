import { listenForHumanInput } from './visibility-poll.mjs';

export const TAB_REQUEST_LIMIT = 600;
export const INITIAL_ASSET_REQUEST_LIMIT = 400;
export const QUIET_TAB_REQUEST_LIMIT = TAB_REQUEST_LIMIT + INITIAL_ASSET_REQUEST_LIMIT;

// This counter belongs to the document, not a controller or a visibility
// period. Count auth checks and failed transports as actual HTTP attempts.
export function createRequestBudget({ fetchImpl, document }) {
  let used = 0;
  const stopInput = listenForHumanInput(document, () => { used = 0; });
  return {
    get used() { return used; },
    async fetch(path, init) {
      if (used >= TAB_REQUEST_LIMIT) throw Object.assign(new Error('Automatic reads paused. Interact with this page to continue.'), { code: 'request_budget_exhausted' });
      used++;
      return fetchImpl(path, { ...init, redirect: 'error' });
    },
    dispose: stopInput,
  };
}
