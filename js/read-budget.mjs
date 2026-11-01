export const MAX_READ_PAGES = 100;

// Pagination is one finite read, never an automatic retry. A failed or paused
// batch goes back to its caller's error state and needs a new read to continue.
// eslint-disable-next-line no-restricted-syntax -- Defines the page guard: MAX_READ_PAGES is 100; hidden state and a 30-minute deadline stop each batch.
export function createPageBudget({ document = globalThis.document, now = () => Date.now() } = {}) {
  let pages = 0;
  const started = now();
  return () => {
    if (document?.visibilityState === 'hidden' || now() - started >= 30 * 60_000) throw new Error('read_paused');
    if (pages++ >= MAX_READ_PAGES) throw new Error('page_limit');
    return MAX_READ_PAGES - pages;
  };
}
