import axe from 'axe-core';

// Works on the rendered page, including the currently active dialog. Offscreen
// content in a vertical scroller is reachable; hidden/ellipsis text is not.
export async function auditScreen(page, { mobile = false } = {}) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  await page.addScriptTag({ content: axe.source });
  const accessibility = await page.evaluate(async () => {
    const result = await window.axe.run();
    return { violations: result.violations, incomplete: result.incomplete };
  });
  const layout = mobile ? await page.evaluate(() => {
    const findings = [];
    const visible = el => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (box.bottom < 0 || box.right < 0) return false;
      for (let parent = el; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (css.clip !== 'auto' || (rect.width <= 1 && rect.height <= 1 && css.clipPath !== 'none')) return false;
      }
      return el.getClientRects().length && style.visibility !== 'hidden'
        && style.display !== 'none' && !el.closest('[hidden],[inert],[aria-hidden="true"]');
    };
    const label = el => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
    const dialogs = [...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')].filter(visible);
    const root = dialogs.at(-1) || document.body;
    if (document.documentElement.scrollWidth > innerWidth + 1)
      findings.push({ kind: 'horizontal-scroll', selector: 'html', width: document.documentElement.scrollWidth, viewport: innerWidth });
    for (const el of [root, ...root.querySelectorAll('*')].filter(visible)) {
      const style = getComputedStyle(el);
      if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1)
        findings.push({ kind: 'horizontal-scroll', selector: label(el), width: el.scrollWidth, viewport: el.clientWidth });
      if (el.matches('button,a[href],input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="tab"],[tabindex="0"]')
          && !el.matches(':disabled,[aria-disabled="true"]')) {
        const box = el.getBoundingClientRect();
        if (box.width < 44 || box.height < 44)
          findings.push({ kind: 'tap-target', selector: label(el), width: box.width, height: box.height });
      }
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        for (let parent = el; parent && root.contains(parent); parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          const clipsX = ['hidden', 'clip'].includes(css.overflowX);
          const clipsY = ['hidden', 'clip'].includes(css.overflowY);
          if (rects.some(r => (clipsX && (r.left < box.left - 1 || r.right > box.right + 1))
            || (clipsY && (r.top < box.top - 2 || r.bottom > box.bottom + 2)))) {
            findings.push({ kind: 'clipped-text', selector: label(el), text: node.textContent.trim().slice(0, 100) });
            break;
          }
        }
      }
    }
    return findings;
  }) : [];
  return {
    blocking: accessibility.violations.filter(v => ['serious', 'critical'].includes(v.impact)),
    moderate: accessibility.violations.filter(v => v.impact === 'moderate'),
    minor: accessibility.violations.filter(v => v.impact === 'minor'),
    incomplete: accessibility.incomplete,
    layout,
  };
}
