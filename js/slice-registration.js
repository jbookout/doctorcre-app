// The shell consumes metadata; page scripts keep ownership of their controls.
export const NAVIGATION_GROUPS = Object.freeze(['Workspace', 'Updates', 'Operations', 'Reference']);
export function registerSlices(slices) {
  const rank = group => group == null ? 0 : NAVIGATION_GROUPS.indexOf(group) + 1;
  const navigationItems = Object.freeze(slices.flatMap(slice => slice.navigation || [])
    .sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order || a.href.localeCompare(b.href))
    .map(({ order, ...item }) => Object.freeze(item)));
  const sectionForRoute = Object.freeze(Object.assign({}, ...slices.map(slice => slice.activeRoutes || {})));
  return { navigationItems, sectionForRoute };
}

const mountedSections = new WeakMap();

// The browser and build validator enforce the same section markup contract.
export function createSliceSection(root, section) {
  const template = root.createElement('template'); template.innerHTML = section.html;
  const node = template.content.firstElementChild;
  if (template.content.children.length !== 1 || node.id !== section.id
    || [...template.content.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())) {
    throw new Error(`slice section needs one root with its id: ${section.id}`);
  }
  const ids = [node.id, ...[...node.querySelectorAll('[id]')].map(child => child.id)];
  if (new Set(ids).size !== ids.length || ids.some(id => root.getElementById(id))) throw new Error(`slice section id collision: ${section.id}`);
  return node;
}

function loadControls(root, section, state) {
  state.node.inert = true;
  state.node.dataset.sliceState = 'loading';
  state.notice.textContent = 'Loading controls…';
  state.notice.removeAttribute('data-slice-error');
  state.script?.remove();
  const script = root.createElement('script');
  script.type = 'module';
  // Browsers cache failed module loads by URL. A retry needs a fresh module URL.
  state.attempt++;
  script.setAttribute('src', state.attempt === 1 ? section.module : `${section.module}?slice_retry=${state.attempt}`);
  script.onload = () => {
    state.node.inert = false;
    state.node.dataset.sliceState = 'ready';
    state.notice.remove();
  };
  script.onerror = () => {
    state.node.dataset.sliceState = 'failed';
    state.node.after(state.notice);
    state.notice.dataset.sliceError = section.id;
    state.notice.textContent = 'Controls unavailable. ';
    const retry = root.createElement('button');
    retry.type = 'button'; retry.textContent = 'Retry controls';
    retry.onclick = () => loadControls(root, section, state);
    state.notice.append(retry);
  };
  state.script = script;
  state.node.after(script, state.notice);
}

export function mountSliceSections(root, pathname, slices) {
  let mounted = mountedSections.get(root);
  if (!mounted) mountedSections.set(root, mounted = new Map());
  const errors = [];
  for (const slice of slices) for (const section of slice.sections || []) {
    if (section.page !== pathname) continue;
    try {
      const prior = mounted.get(section.id);
      if (prior) {
        if (prior.node.dataset.sliceState === 'failed') loadControls(root, section, prior);
        continue;
      }
      const slot = root.querySelector(section.slot);
      if (!slot) throw new Error(`missing slice section slot: ${slice.id} ${section.slot}`);
      const node = createSliceSection(root, section);
      slot.append(node);
      const notice = root.createElement('div'); notice.className = 'slice-controls-status'; notice.setAttribute('role', 'status');
      const state = { node, notice, attempt: 0 };
      mounted.set(section.id, state);
      if (section.module) loadControls(root, section, state);
    } catch (error) {
      errors.push(error);
      const notice = root.createElement('div'); notice.className = 'slice-controls-status';
      notice.dataset.sliceError = section.id; notice.setAttribute('role', 'alert');
      notice.textContent = 'Section unavailable.';
      (root.getElementById('appMainSlot') || root.body).append(notice);
    }
  }
  return errors;
}
