export function trackShellGeometry(header: HTMLElement, content: HTMLElement) {
  const document = header.ownerDocument;
  const view = document.defaultView;
  if (!view || typeof view.ResizeObserver !== 'function') return () => {};
  const style = document.documentElement.style;
  const keys = ['--site-header-height', '--scroll-progress'];
  const previous = keys.map(key => ({ key, value: style.getPropertyValue(key), priority: style.getPropertyPriority(key) }));
  let frame: number | undefined;
  const measure = () => {
    frame = undefined;
    const range = document.documentElement.scrollHeight - view.innerHeight;
    style.setProperty('--site-header-height', `${header.getBoundingClientRect().height}px`);
    style.setProperty('--scroll-progress', String(range > 0 ? Math.max(0, Math.min(1, view.scrollY / range)) : 0));
  };
  const schedule = () => {
    // eslint-disable-next-line no-restricted-syntax -- Single pending frame coalesces geometry events; cleanup cancels it, and measurement never reschedules.
    frame ??= view.requestAnimationFrame(measure);
  };
  const observer = new view.ResizeObserver(schedule);
  observer.observe(header); observer.observe(content);
  view.addEventListener('scroll', schedule, { passive: true });
  view.addEventListener('resize', schedule);
  measure();
  return () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    observer.disconnect();
    view.removeEventListener('scroll', schedule);
    view.removeEventListener('resize', schedule);
    for (const { key, value, priority } of previous) {
      if (value) style.setProperty(key, value, priority); else style.removeProperty(key);
    }
  };
}
