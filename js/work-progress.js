export function selectedProgressCheck(host) {
  return host.querySelector('[data-progress-check][aria-expanded="true"]')?.dataset.progressCheck;
}
export function selectProgressCheck(event) {
  const button = event.target.closest('[data-progress-check]');
  if (!button) return;
  const host = button.closest('.work-progress');
  for (const check of host.querySelectorAll('[data-progress-check]')) check.setAttribute('aria-expanded',String(check === button));
  for (const panel of host.querySelectorAll('[data-check-evidence]')) panel.hidden = panel.dataset.checkEvidence !== button.dataset.progressCheck;
  button.after(host.querySelector('.work-progress-inspector'));
}
