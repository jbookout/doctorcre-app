export async function dragDealToPhase(browser, id, phase) {
  const points = await browser.evaluate(async ({ id, phase }) => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations()
      .filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
    const card = document.querySelector(`.kanban-column [data-id="${id}"]`);
    const header = document.querySelector(`[data-column="${phase}"] > h3`);
    if (!card || !header) throw Error('Deal drag endpoint missing');
    // A tall column's centre may be off screen. Expose the header and card
    // before mouse-down so scrolling cannot cancel an active native drag.
    header.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    card.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const centre = node => {
      const box = node.getBoundingClientRect();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      if (point.x < 0 || point.x >= innerWidth || point.y < 0 || point.y >= innerHeight
        || !node.contains(document.elementFromPoint(point.x, point.y)))
        throw Error('Deal drag endpoints must both be visible');
      return point;
    };
    return { from: centre(card), to: centre(header) };
  }, { id, phase });
  await browser.mouse.move(points.from.x, points.from.y);
  await browser.mouse.down();
  try {
    await browser.mouse.move(points.from.x + 8, points.from.y + 8);
    await browser.mouse.move(points.to.x, points.to.y);
    // HTML drag-and-drop needs a dragover after entering the destination.
    await browser.mouse.move(points.to.x + 1, points.to.y + 1);
  } finally {
    await browser.mouse.up();
  }
}
