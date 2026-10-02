// The shell consumes metadata; page scripts keep ownership of their controls.
export function registerSlices(slices) {
  const navigationItems = Object.freeze(slices.flatMap(slice => slice.navigation || [])
    .sort((a, b) => a.order - b.order).map(({ order, ...item }) => Object.freeze(item)));
  const sectionForRoute = Object.freeze(Object.assign({}, ...slices.map(slice => slice.activeRoutes || {})));
  return { navigationItems, sectionForRoute };
}

export function mountSliceSections(root, pathname, slices) {
  for (const slice of slices) for (const section of slice.sections || []) {
    if (section.page !== pathname || root.getElementById(section.id)) continue;
    const slot = root.querySelector(section.slot);
    if (!slot) throw new Error(`missing slice section slot: ${slice.id} ${section.slot}`);
    slot.insertAdjacentHTML('beforeend', section.html);
    if (!root.getElementById(section.id)) throw new Error(`slice section markup needs its id: ${slice.id} ${section.id}`);
    if (section.module) {
      const script = root.createElement('script');
      script.type = 'module'; script.src = section.module;
      slot.append(script);
    }
  }
}
