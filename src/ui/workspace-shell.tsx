import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { selectPanel, validateLayout, type Layout, type LayoutNode } from "./workspace-layout";

type Panel = Readonly<{ id: string; title: string; node: HTMLElement }>;
type HostedPanel = Panel & Readonly<{ home: Comment; hidden: HTMLElement["hidden"] }>;

function Workspace({ layout, panels, focused, onSelect }: {
  layout: Layout; panels: ReadonlyMap<string, HostedPanel>; focused: Element | null;
  onSelect: (panel: string) => void;
}) {
  const slots = useRef(new Map<string, HTMLDivElement>());
  const parking = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shown = new Set<string>();
    function place(node: LayoutNode) {
      if (node.kind === "split") { place(node.first); place(node.second); return; }
      const slot = slots.current.get(node.id);
      if (!slot) return;
      for (const id of node.panels) {
        const panel = panels.get(id);
        if (!panel) continue;
        panel.node.hidden = id !== node.active;
        slot.append(panel.node);
        shown.add(id);
      }
    }
    if (layout.stage) place(layout.stage);
    for (const panel of panels.values()) {
      if (!shown.has(panel.id)) { panel.node.hidden = true; parking.current?.append(panel.node); }
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
      <div className="workspace-branch" ref={element => { if (element) element.style.flex = `${1 - node.ratio} 1 0`; }}>{render(node.second)}</div>
    </div>;
    return <section key={node.id} className="workspace-group" aria-label="Workspace panel group">
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
    flushSync(() => root.render(<Workspace layout={current} panels={registry} focused={focused} onSelect={id => update(selectPanel(current, id))} />));
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
