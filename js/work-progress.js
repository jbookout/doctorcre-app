export function selectedProgressCheck(host) {
  return host.querySelector('[data-progress-check][aria-expanded="true"]')?.dataset.progressCheck;
}
export function positionProgressInspector(host) {
  const inspector = host.querySelector('.work-progress-inspector');
  const button = host.querySelector('[data-progress-check][aria-expanded="true"]');
  if (!inspector || !button) return;
  const wide = host.ownerDocument.defaultView.matchMedia?.('(min-width: 1024px)').matches;
  const parent = wide ? host.querySelector('.work-progress-layout') : button.parentElement;
  if (inspector.parentElement === parent) return;
  const focused = inspector.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement : null;
  parent.append(inspector);
  focused?.focus({preventScroll:true});
}
export function mountProgressChecks(host) {
  host.addEventListener('click',event => {
    const button = event.target.closest('[data-progress-check]');
    if (!button) return;
    const progress = button.closest('.work-progress');
    for (const check of progress.querySelectorAll('[data-progress-check]')) check.setAttribute('aria-expanded',String(check === button));
    for (const panel of progress.querySelectorAll('[data-check-evidence]')) panel.hidden = panel.dataset.checkEvidence !== button.dataset.progressCheck;
    positionProgressInspector(host);
  });
  host.ownerDocument.defaultView.matchMedia?.('(min-width: 1024px)').addEventListener('change',() => positionProgressInspector(host));
}
