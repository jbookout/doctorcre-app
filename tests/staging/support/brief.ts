import type { Locator } from 'e2e';

// The "Morning brief" is a modal <dialog> the app opens on the first page load of
// every fresh session. A test session starts fresh, so tests close it before
// pressing page controls (its modal backdrop intercepts pointer events).
export async function dismissMorningBrief(screen: { getByRole(role: string, options: { name: string }): Locator }) {
  const dismiss = screen.getByRole('button', { name: 'Dismiss morning brief' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}
