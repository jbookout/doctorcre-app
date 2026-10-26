import { resolveDealroomBoot } from './boot-mode.js';
import { createClientPortalClient } from './client-portal-client.js';
import { createFixtureClientPortalClient } from './client-portal-fixture.js';

const live = resolveDealroomBoot(window.location).mode === 'live';
const client = live ? createClientPortalClient() : createFixtureClientPortalClient();
const form = document.querySelector('#portalForm');
const slug = document.querySelector('#portalSlug');
const password = document.querySelector('#portalPassword');
const status = document.querySelector('#portalStatus');
const content = document.querySelector('#portalContent');
const lock = document.querySelector('#portalLock');
document.querySelector('#portalFixture').hidden = live;
let state = { kind: 'locked' };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function setState(next) {
  if (state.kind === 'loading') state.controller.abort();
  state = next;
  content.replaceChildren();
  password.value = '';
  form.hidden = ['ready', 'loading'].includes(state.kind);
  lock.hidden = !form.hidden;
  status.textContent = {
    locked: 'Enter your portal name and password to continue.',
    loading: 'Opening your portal…',
    ready: 'Your current roadmap and shared material.',
    unavailable: 'Portal unavailable. Check the portal name and password, then try again.',
  }[state.kind];
  if (state.kind !== 'ready') return;
  const portal = state.portal;
  content.append(node('h2', 'Your transaction roadmap'));
  const phases = node('ol'); phases.id = 'portalPhases';
  for (const phase of portal.roadmap.phases) {
    const item = node('li', phase.label);
    if (phase.slug === portal.roadmap.current_phase) {
      item.setAttribute('aria-current', 'step');
      item.append(node('span', 'Current step'));
    }
    phases.append(item);
  }
  const materials = node('section'); materials.setAttribute('aria-label', 'Shared material');
  materials.append(node('h2', 'Shared material'));
  if (!portal.materials.length) materials.append(node('p', 'No material has been shared yet.'));
  for (const material of portal.materials) {
    const article = node('article');
    article.append(node('p', material.kind, 'material-kind'), node('h3', material.title), node('p', material.content, 'material-content'));
    materials.append(article);
  }
  content.append(phases, materials);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const args = { slug: slug.value.trim(), password: password.value };
  const pending = { kind: 'loading', controller: new AbortController() };
  setState(pending);
  try {
    const portal = await client.read(args, { signal: pending.controller.signal });
    if (state === pending) setState({ kind: 'ready', portal });
  } catch {
    if (state === pending) { setState({ kind: 'unavailable' }); password.focus(); }
  }
});
lock.addEventListener('click', () => { setState({ kind: 'locked' }); password.focus(); });
window.addEventListener('pagehide', () => setState({ kind: 'locked' }));
window.addEventListener('doctorcre-session-invalidated', () => setState({ kind: 'locked' }));
