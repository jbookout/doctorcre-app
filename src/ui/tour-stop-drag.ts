type Stop = { property_id: string; stop_state: string; locked_appointment: boolean };

export function reorderFlexibleStops<T extends Stop>(rows: T[], source: string, target: string): T[] {
  const flexible = rows.filter((row) => row.stop_state === "active" && !row.locked_appointment);
  const from = flexible.findIndex((row) => row.property_id === source);
  const to = flexible.findIndex((row) => row.property_id === target);
  if (from < 0 || to < 0 || from === to) return rows;
  const moved = flexible.splice(from, 1)[0];
  if (!moved) return rows;
  flexible.splice(to, 0, moved);
  let index = 0;
  return rows.map((row) => (row.stop_state === "active" && !row.locked_appointment ? (flexible[index++] ?? row) : row));
}

type Gesture =
  | { kind: "idle" }
  | { kind: "dragging"; pointer: number; source: HTMLElement; target: HTMLElement | null; x: number; y: number };

export function mountStopDrag(
  list: HTMLElement,
  options: { editable: () => boolean; move: (source: string, target: string) => void },
) {
  let gesture: Gesture = { kind: "idle" };
  const doc = list.ownerDocument;
  const view = doc.defaultView;
  const scrollingView = view?.frameElement ? view.parent : view;
  const offset = () => view?.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const abort = new AbortController();
  const signal = abort.signal;
  let frame = 0;
  function scroll() {
    if (gesture.kind !== "dragging") return;
    if (!options.editable()) {
      cancel();
      return;
    }
    if (view && scrollingView) {
      const delta = gesture.y < 56 ? -16 : gesture.y > scrollingView.innerHeight - 56 ? 16 : 0;
      if (delta) {
        scrollingView.scrollBy({ top: delta, behavior: "instant" });
        gesture.target?.classList.remove("stop-drop-target");
        const frameOffset = offset();
        gesture.target = targetAt({ clientX: gesture.x - frameOffset.left, clientY: gesture.y - frameOffset.top });
        gesture.target?.classList.add("stop-drop-target");
      }
      // eslint-disable-next-line no-restricted-syntax -- One frame per active gesture; cancel cancels it on drop, Escape, blur or retirement. No network reads.
      frame = view.requestAnimationFrame(scroll);
    }
  }
  function cancel() {
    doc.defaultView?.cancelAnimationFrame(frame);
    const previous = gesture;
    gesture = { kind: "idle" };
    if (previous.kind === "dragging") {
      previous.source.classList.remove("stop-dragging");
      previous.target?.classList.remove("stop-drop-target");
      const handle = previous.source.querySelector("[data-stop-drag]");
      if (handle instanceof HTMLElement && handle.hasPointerCapture?.(previous.pointer))
        handle.releasePointerCapture(previous.pointer);
    }
  }
  function targetAt(event: { clientX: number; clientY: number }) {
    const target = doc.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>("[data-flexible-stop]");
    return target && list.contains(target) ? target : null;
  }
  list.addEventListener(
    "pointerdown",
    (event) => {
      if (!options.editable() || event.button !== 0 || event.isPrimary === false) return;
      const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-stop-drag]") : null;
      const source = handle?.closest<HTMLElement>("[data-flexible-stop]");
      if (!handle || !source) return;
      cancel();
      gesture = {
        kind: "dragging",
        pointer: event.pointerId,
        source,
        target: null,
        x: event.clientX + offset().left,
        y: event.clientY + offset().top,
      };
      // eslint-disable-next-line no-restricted-syntax -- A single local gesture frame loop; cancel ends it on every gesture exit. No network reads.
      frame = doc.defaultView?.requestAnimationFrame(scroll) ?? 0;
      handle.focus({ preventScroll: true });
      source.classList.add("stop-dragging");
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    { signal },
  );
  doc.addEventListener(
    "pointermove",
    (event) => {
      if (gesture.kind !== "dragging" || event.pointerId !== gesture.pointer) return;
      if (!options.editable()) {
        cancel();
        return;
      }
      gesture.target?.classList.remove("stop-drop-target");
      gesture.x = event.clientX + offset().left;
      gesture.y = event.clientY + offset().top;
      gesture.target = targetAt(event);
      gesture.target?.classList.add("stop-drop-target");
      event.preventDefault();
    },
    { signal, passive: false },
  );
  doc.addEventListener(
    "pointerup",
    (event) => {
      if (gesture.kind !== "dragging" || event.pointerId !== gesture.pointer) return;
      const source = gesture.source.dataset.propertyId;
      const target = targetAt(event)?.dataset.propertyId;
      cancel();
      if (source && target && source !== target && options.editable()) options.move(source, target);
    },
    { signal },
  );
  doc.addEventListener("pointercancel", cancel, { signal });
  list.addEventListener("lostpointercapture", cancel, { signal });
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") cancel();
    },
    { signal },
  );
  doc.defaultView?.addEventListener("blur", cancel, { signal });
  return {
    active() {
      return gesture.kind === "dragging";
    },
    destroy() {
      cancel();
      abort.abort();
    },
  };
}
