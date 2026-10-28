const allSteps = [
  { target: '[data-app-nav-item][href="/"]', text: 'Start with your agenda. Home brings together upcoming work and deals that need attention.' },
  { target: '[data-app-nav-item][href="/deals"]', text: 'Follow each deal through its phase, next step, and next date. Open a deal to review its details.' },
  { target: '[data-app-nav-item][href="/leads"]', text: 'Search and review potential clients in Leads. Open a lead to see its details before deciding what comes next.' },
  { target: '[data-app-nav-item][href="/tours"]', text: 'Use Tours to plan property visits and open a saved tour. Tour Day keeps the accepted itinerary at hand.' },
  { target: '#docOpen', title: 'Doc', text: 'Doc is the assistant inside DoctorCRE. Open Doc to ask about the current page or record. Review its suggestions before taking action.' },
  { target: '#callModeButton', title: 'Call Mode', text: 'Use Call Mode to record and review your weekly pipeline call.' },
];

export function openWalkthrough(root) {
  if (root.querySelector('[data-walkthrough]')) return;
  const steps = allSteps.filter(step => step.target !== '#callModeButton' || !root.querySelector(step.target)?.hidden);
  const win = root.defaultView;
  const avatar = root.getElementById('selfAvatar');
  const account = root.getElementById('accountMenu');
  const guide = root.createElement('section');
  guide.dataset.walkthrough = '';
  guide.className = 'app-walkthrough';
  guide.setAttribute('role', 'dialog');
  guide.setAttribute('aria-labelledby', 'walkthroughTitle');
  guide.setAttribute('aria-describedby', 'walkthroughText');
  guide.innerHTML = '<header><h2 id="walkthroughTitle">How DoctorCRE works</h2><button type="button" data-skip aria-label="Skip walkthrough">×</button></header><div aria-live="polite" aria-atomic="true"><p data-progress></p><h3 data-step></h3><p id="walkthroughText"></p></div><footer><button type="button" data-back>Back</button><button type="button" data-next>Next</button></footer>';
  root.body.append(guide);
  let index = 0, target;
  const next = guide.querySelector('[data-next]');
  const back = guide.querySelector('[data-back]');
  const place = () => {
    if (!target || !guide.isConnected) return;
    const inAccount = Boolean(target.closest('#accountMenu'));
    account.hidden = !inAccount;
    avatar.setAttribute('aria-expanded', String(inAccount));
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const edge = target.getBoundingClientRect();
    for (const compact of [false, true]) {
      guide.toggleAttribute('data-compact', compact);
      for (const position of ['top', 'bottom']) {
        guide.dataset.position = position;
        const box = guide.getBoundingClientRect();
        const fits = box.left >= 0 && box.top >= 0 && box.right <= win.innerWidth && box.bottom <= win.innerHeight;
        const overlaps = edge.left < box.right && edge.right > box.left && edge.top < box.bottom && edge.bottom > box.top;
        if (fits && !overlaps) return;
      }
    }
  };
  const resize = () => win.requestAnimationFrame(place);
  const paint = () => {
    target?.classList.remove('app-walkthrough-target');
    const step = steps[index];
    target = root.querySelector(step.target);
    guide.querySelector('[data-progress]').textContent = `${index + 1} of ${steps.length}`;
    guide.querySelector('[data-step]').textContent = step.title || target.getAttribute('aria-label');
    guide.querySelector('#walkthroughText').textContent = step.text;
    guide.querySelector('[aria-live]').scrollTop = 0;
    target.classList.add('app-walkthrough-target');
    back.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? 'Done' : 'Next';
    place();
  };
  const close = (reason = 'dismiss') => {
    target?.classList.remove('app-walkthrough-target');
    if (reason !== 'navigate') {
      account.hidden = true;
      avatar.setAttribute('aria-expanded', 'false');
    }
    guide.remove();
    win.removeEventListener('keydown', keydown, true);
    win.removeEventListener('resize', resize);
    win.removeEventListener('doctorcre-session-invalidated', retire);
    root.removeEventListener('click', leave, true);
    if (reason === 'dismiss') avatar.focus();
  };
  const keydown = event => {
    if (root.querySelector('dialog:modal')) { close('retire'); return; }
    if ((event.ctrlKey || event.metaKey) && ['k', 'd'].includes(event.key.toLowerCase())) { close(); return; }
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  };
  const retire = () => close('retire');
  const leave = event => {
    if (!guide.contains(event.target)) close('navigate');
  };
  guide.addEventListener('click', event => {
    event.stopPropagation();
    if (event.target.closest('[data-skip]')) close();
    else if (event.target.closest('[data-back]') && index > 0) { index--; paint(); }
    else if (event.target.closest('[data-next]')) {
      if (index === steps.length - 1) close();
      else { index++; paint(); }
    }
  });
  win.addEventListener('keydown', keydown, true);
  root.addEventListener('click', leave, true);
  win.addEventListener('resize', resize);
  win.addEventListener('doctorcre-session-invalidated', retire, { once: true });
  paint(); next.focus();
}
