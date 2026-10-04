// Playwright 1.63's waitForFunction polls Promise truthiness. Evaluate each
// predicate to its awaited boolean here so an async false never passes a wait.
export async function waitForState(page, predicate, arg, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!await page.evaluate(predicate, arg)) {
    if (Date.now() >= deadline) throw new Error('Browser state timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
