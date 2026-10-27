import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { resizeSplit, selectPanel, validateLayout, type Layout, type LayoutNode } from "./workspace-layout";

type Panel = Readonly<{ id: string; title: string; node: HTMLElement }>;
type HostedPanel = Panel & Readonly<{ home: Comment; hidden: HTMLElement["hidden"] }>;

function Workspace({ layout, panels, focused, onSelect, onResize }: {
  layout: Layout; panels: ReadonlyMap<string, HostedPanel>; focused: Element | null;
  onSelect: (panel: string) => void; onResize: (id: string, ratio: number) => void;
}) {
  const drag = useRef<{ pointer: number; start: number; extent: number; ratio: number } | null>(null);
  const clamp = (ratio: number) => Math.max(0.01, Math.min(0.99, ratio));
  const slots = useRef(new Map<string, HTMLDivElement>());
  const parking = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shown = new Set<string>();
    function place(node: LayoutNode) {
      if (node.kind === "split") { place(node.first); place(node.second); return; }
      const slot = slots.current.get(node.id);
      if (!slot) return;
      let index = 0;
      for (const id of node.panels) {
        const panel = panels.get(id);
        if (!panel) continue;
        panel.node.hidden = id !== node.active;
        const current = slot.children.item(index);
        if (current !== panel.node) slot.insertBefore(panel.node, current);
        index++;
        shown.add(id);
      }
    }
    if (layout.stage) place(layout.stage);
    for (const panel of panels.values()) {
      if (!shown.has(panel.id)) {
        panel.node.hidden = true;
        if (panel.node.parentElement !== parking.current) parking.current?.append(panel.node);
      }
    }
    const view = workspace.current?.ownerDocument.defaultView;
    if (view && focused instanceof view.HTMLElement && workspace.current?.contains(focused)) {
      if (!focused.closest("[hidden]")) focused.focus({ preventScroll: true });
      else workspace.current.focus({ preventScroll: true });
    }
  });
  function render(node: LayoutNode) {
    if (node.kind === "split") return <div key={node.id} className="workspace-split" data-axis={node.axis}>
      <div className="workspace-branch" ref={element => { if (element) element.style.flex = `${node.ratio} 1 0`; }}>{render(node.first)}</div>
      <div className="workspace-divider" role="separator" tabIndex={0} aria-label="Resize panels"
        aria-orientation={node.axis === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemin={1} aria-valuemax={99} aria-valuenow={Math.round(node.ratio * 100)}
        onKeyDown={event => {
          const previous = node.axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
          const next = node.axis === "horizontal" ? "ArrowRight" : "ArrowDown";
          if (![previous, next, "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          onResize(node.id, event.key === "Home" ? 0.01 : event.key === "End" ? 0.99
            : clamp(node.ratio + (event.key === next ? 0.05 : -0.05)));
        }}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          const branches = event.currentTarget.parentElement?.querySelectorAll(":scope > .workspace-branch");
          if (!branches || branches.length !== 2) return;
          const extent = Array.from(branches).reduce((sum, branch) => {
            const box = branch.getBoundingClientRect();
            return sum + (node.axis === "horizontal" ? box.width : box.height);
          }, 0);
          if (!extent) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, start: node.axis === "horizontal" ? event.clientX : event.clientY, extent, ratio: node.ratio };
        }}
        onPointerMove={event => {
          const active = drag.current;
          if (!active || active.pointer !== event.pointerId) return;
          const position = node.axis === "horizontal" ? event.clientX : event.clientY;
          onResize(node.id, clamp(active.ratio + (position - active.start) / active.extent));
        }}
        onPointerUp={event => {
          if (drag.current?.pointer !== event.pointerId) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }} />
      <div className="workspace-branch" ref={element => { if (element) element.style.flex = `${1 - node.ratio} 1 0`; }}>{render(node.second)}</div>
    </div>;
    return <section key={node.id} className="workspace-group" aria-label={`Workspace panel group ${node.id}`}>
      <div className="workspace-tabs" role="group" aria-label="Choose a panel">
        {node.panels.map(id => <button key={id} type="button" className="btn btn-quiet" aria-pressed={id === node.active} onClick={() => onSelect(id)}>{panels.get(id)?.title}</button>)}
      </div>
      <div className="workspace-panel-slot" ref={element => { if (element) slots.current.set(node.id, element); else slots.current.delete(node.id); }} />
    </section>;
  }
  return <div className="workspace-shell" ref={workspace} tabIndex={-1} aria-label="Workspace">
    {layout.stage ? render(layout.stage) : <p>No panels open.</p>}
    <div hidden ref={parking} />
  </div>;
}

export function mountWorkspace({ container, panels, layout }: {
  container: HTMLElement; panels: readonly Panel[]; layout: Layout;
}): { update: (layout: Layout) => void; unmount: () => void } {
  const document = container.ownerDocument;
  if (!container.isConnected) throw new Error("Workspace container must be mounted");
  if (container.childNodes.length) throw new Error("Workspace container must be empty");
  const registry = new Map<string, HostedPanel>();
  for (const panel of panels) {
    if (!panel.id.trim() || registry.has(panel.id)) throw new Error("Duplicate or empty panel identifier");
    if (panel.node.ownerDocument !== document || !panel.node.isConnected || panel.node.contains(container) || container.contains(panel.node)
      || panels.some(other => other !== panel && (other.node.contains(panel.node) || panel.node.contains(other.node)))) throw new Error("Panels must be separate mounted nodes outside the workspace");
    registry.set(panel.id, { ...panel, home: document.createComment("workspace-panel"), hidden: panel.node.hidden });
  }
  function checked(next: Layout): Layout {
    const valid = validateLayout(next);
    function check(node: LayoutNode) {
      if (node.kind === "split") { check(node.first); check(node.second); }
      else for (const id of node.panels) if (!registry.has(id)) throw new Error("Unknown workspace panel");
    }
    if (valid.stage) check(valid.stage);
    return valid;
  }
  let current = checked(layout);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/css/workspace-shell.css";
  document.head.append(stylesheet);
  for (const panel of registry.values()) panel.node.before(panel.home);
  const root = createRoot(container);
  let disposed = false;
  function update(next: Layout) {
    if (disposed) throw new Error("Workspace is unmounted");
    current = checked(next);
    const focused = document.activeElement;
    flushSync(() => root.render(<Workspace layout={current} panels={registry} focused={focused} onSelect={id => update(selectPanel(current, id))} onResize={(id, ratio) => update(resizeSplit(current, id, ratio))} />));
  }
  update(current);
  return { update, unmount() {
    if (disposed) return;
    disposed = true;
    const focused = document.activeElement;
    for (const panel of registry.values()) { panel.node.hidden = panel.hidden; panel.home.replaceWith(panel.node); }
    root.unmount();
    stylesheet.remove();
    const view = document.defaultView;
    if (view && focused instanceof view.HTMLElement && focused.isConnected && !focused.closest("[hidden]")) focused.focus({ preventScroll: true });
  } };
}
